// app/services/surge.server.ts
import db from "../db.server";
import { updateShopifyVariantPrice } from "./shopifyPrice.server";

export interface VendorPriceCheck {
  shopifyProductId: string;
  variantGid: string;
  currentWholesaleCost: number;
  newWholesaleCost: number;
  currentRetailPrice: number;
  minMarginPercent: number;
}

/**
 * Evaluates sales velocity thresholds and automatically surges storefront prices for high-demand items.
 */
export async function evaluateAutoSurgeForShop({
  admin,
  shop,
}: {
  admin: any;
  shop: string;
}) {
  const settings = await db.surgeSetting.findUnique({
    where: { shop },
  });

  if (!settings) return;

  // Find products that hit or exceed the sales threshold but are not currently surged
  const eligibleProducts = await db.surgedProduct.findMany({
    where: {
      shop,
      surgeStatus: "NORMAL",
      salesCount: { gte: settings.autoSalesThreshold },
    },
  });

  for (const product of eligibleProducts) {
    const rawOriginal = Number(product.originalPrice ?? product.currentPrice ?? 0);
    const basePrice = rawOriginal > 0 ? rawOriginal : Number(product.currentPrice ?? 0);
    const newPrice =
      Math.round((basePrice * (1 + settings.autoSurgePercentage / 100)) * 100) / 100;

    // 1. Update storefront price on Shopify
    const priceRes = await updateShopifyVariantPrice({
      admin,
      variantId: product.shopifyVariantId,
      newPrice,
    });

    if (priceRes.success) {
      const resetAt = new Date();
      resetAt.setDate(resetAt.getDate() + settings.autoResetDays);

      // 2. Transition status to AUTO_SURGED so it populates the engine dashboard
      await db.surgedProduct.update({
        where: { id: product.id },
        data: {
          originalPrice: basePrice,
          currentPrice: newPrice,
          surgeStatus: "AUTO_SURGED",
          surgePercentage: settings.autoSurgePercentage,
          surgedAt: new Date(),
          resetAt,
        },
      });
    }
  }
}

/**
 * Evaluates vendor cost changes and updates storefront retail prices if margin is breached.
 */
export async function processCostSurgeForShop(
  shop: string,
  adminGraphQL: any,
  item: VendorPriceCheck
) {
  const {
    shopifyProductId,
    variantGid,
    currentWholesaleCost,
    newWholesaleCost,
    currentRetailPrice,
    minMarginPercent,
  } = item;

  // Calculate projected net margin at current retail price with new wholesale cost
  const projectedMargin =
    ((currentRetailPrice - newWholesaleCost) / currentRetailPrice) * 100;

  // If projected margin drops below the merchant's configured minimum boundary
  if (projectedMargin < minMarginPercent) {
    // Formula: Required Retail = New Wholesale / (1 - Target Margin %)
    const requiredRetail = Number(
      (newWholesaleCost / (1 - minMarginPercent / 100)).toFixed(2)
    );

    // 1. Execute price update on Shopify via GraphQL Admin API
    const response = await adminGraphQL(
      `
      #graphql
      mutation updateProductPrice($input: ProductInput!) {
        productUpdate(input: $input) {
          product {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
      {
        variables: {
          input: {
            id: shopifyProductId,
            variants: [{ id: variantGid, price: String(requiredRetail) }],
          },
        },
      }
    );

    const result = await response.json();

    if (!result.data?.productUpdate?.userErrors?.length) {
      // 2. Find internal vendor mapping ID
      const mapping = await db.vendorMapping.findFirst({
        where: { shop, shopifyProductId },
      });

      // 3. Write record to costSurgeLog for audit history
      await db.costSurgeLog.create({
        data: {
          shop,
          productId: shopifyProductId,
          productMappingId: mapping?.id,
          previousCost: currentWholesaleCost,
          newCost: newWholesaleCost,
          previousRetail: currentRetailPrice,
          newRetail: requiredRetail,
        },
      });

      console.log(
        `[NexusFulfill Surge] Updated ${variantGid}: Retail adjusted from $${currentRetailPrice} to $${requiredRetail} (Cost surge: $${currentWholesaleCost} -> $${newWholesaleCost})`
      );
    }
  }
}