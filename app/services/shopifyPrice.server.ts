// app/services/shopifyPrice.server.ts

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { SurgeStatus } from "@prisma/client";

export interface UpdateShopifyVariantPriceParams {
  admin: AdminApiContext;
  variantId: string;
  newPrice: number;
  compareAtPrice?: number | null;
  productId?: string;
}

export interface UpdateShopifyVariantPriceResult {
  success: boolean;
  error?: string;
  price?: number;
  compareAtPrice?: number | null;
}

export interface ApplyPriceSurgeParams {
  admin: AdminApiContext;
  shop: string;
  shopifyVariantId: string;
  surgePercentage?: number;
  resetDays?: number;
  status?: SurgeStatus;
}

export interface RevertPriceSurgeParams {
  admin: AdminApiContext;
  shopifyVariantId: string;
}

interface ShopifyUserError {
  field?: string[];
  message: string;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface BulkUpdateData {
  productVariantsBulkUpdate?: {
    productVariants?: Array<{
      id: string;
      price: string;
      compareAtPrice: string | null;
    }>;
    userErrors?: ShopifyUserError[];
  };
}

interface SingleUpdateData {
  productVariantUpdate?: {
    productVariant?: {
      id: string;
      price: string;
      compareAtPrice: string | null;
    };
    userErrors?: ShopifyUserError[];
  };
}

const BULK_UPDATE_MUTATION = `#graphql
  mutation updateVariantPriceBulk($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        price
        compareAtPrice
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const SINGLE_UPDATE_MUTATION = `#graphql
  mutation updateSingleVariantPrice($input: ProductVariantInput!) {
    productVariantUpdate(input: $input) {
      productVariant {
        id
        price
        compareAtPrice
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Ensures an ID string has proper Shopify GID format (e.g., gid://shopify/ProductVariant/12345)
 */
export function ensureGid(id: string, type: "Product" | "ProductVariant"): string {
  if (!id) return id;
  const prefix = `gid://shopify/${type}/`;
  return id.startsWith("gid://") ? id : `${prefix}${id}`;
}

/**
 * Updates a product variant's price in Shopify using the GraphQL Admin API.
 * Leverages productVariantsBulkUpdate if a productId GID is provided, falling
 * back automatically to productVariantUpdate if no productId exists or if the bulk operation fails.
 */
export async function updateShopifyVariantPrice({
  admin,
  variantId,
  newPrice,
  compareAtPrice,
  productId,
}: UpdateShopifyVariantPriceParams): Promise<UpdateShopifyVariantPriceResult> {
  const formattedVariantId = ensureGid(variantId, "ProductVariant");
  const formattedProductId = productId ? ensureGid(productId, "Product") : undefined;

  const safeNewPrice = typeof newPrice === "number" && !Number.isNaN(newPrice) ? newPrice : 0;
  const formattedPrice = safeNewPrice.toFixed(2);

  let formattedComparePrice: string | null | undefined = undefined;
  if (typeof compareAtPrice === "number" && !Number.isNaN(compareAtPrice)) {
    formattedComparePrice = compareAtPrice.toFixed(2);
  } else if (compareAtPrice === null) {
    formattedComparePrice = null;
  }

  // 1. Primary Strategy: Bulk update if parent productId GID is present
  if (formattedProductId) {
    try {
      const variantInput: { id: string; price: string; compareAtPrice?: string | null } = {
        id: formattedVariantId,
        price: formattedPrice,
      };

      if (formattedComparePrice !== undefined) {
        variantInput.compareAtPrice = formattedComparePrice;
      }

      const response = await admin.graphql(BULK_UPDATE_MUTATION, {
        variables: {
          productId: formattedProductId,
          variants: [variantInput],
        },
      });

      const responseJson = (await response.json()) as GraphQLResponse<BulkUpdateData>;

      if (responseJson.errors && responseJson.errors.length > 0) {
        const topLevelError = responseJson.errors.map((e) => e.message).join(", ");
        console.warn(
          `[Shopify Price Service] Bulk GraphQL error for variant ${formattedVariantId}: ${topLevelError}. Falling back to single mutation...`
        );
      } else {
        const userErrors = responseJson.data?.productVariantsBulkUpdate?.userErrors || [];

        if (userErrors.length === 0) {
          const updatedVariant = responseJson.data?.productVariantsBulkUpdate?.productVariants?.[0];
          console.log(
            `[Shopify Price Service] Successfully bulk-updated variant ${formattedVariantId} to $${formattedPrice}`
          );
          return {
            success: true,
            price: updatedVariant?.price ? parseFloat(updatedVariant.price) : safeNewPrice,
            compareAtPrice: updatedVariant?.compareAtPrice
              ? parseFloat(updatedVariant.compareAtPrice)
              : formattedComparePrice === null
              ? null
              : undefined,
          };
        }

        const errorMsg = userErrors
          .map((e) => `${e.field?.join(".") || "field"}: ${e.message}`)
          .join(", ");
        console.warn(
          `[Shopify Price Service] Bulk userErrors for variant ${formattedVariantId}: ${errorMsg}. Falling back to single mutation...`
        );
      }
    } catch (error: unknown) {
      const errMessage = error instanceof Error ? error.message : "Unknown error";
      console.warn(
        `[Shopify Price Service] Bulk mutation exception for variant ${formattedVariantId}: ${errMessage}. Falling back to single mutation...`
      );
    }
  }

  // 2. Secondary Strategy: Single variant update fallback
  try {
    const singleInput: { id: string; price: string; compareAtPrice?: string | null } = {
      id: formattedVariantId,
      price: formattedPrice,
    };

    if (formattedComparePrice !== undefined) {
      singleInput.compareAtPrice = formattedComparePrice;
    }

    const response = await admin.graphql(SINGLE_UPDATE_MUTATION, {
      variables: { input: singleInput },
    });

    const responseJson = (await response.json()) as GraphQLResponse<SingleUpdateData>;

    if (responseJson.errors && responseJson.errors.length > 0) {
      const topLevelError = responseJson.errors.map((e) => e.message).join(", ");
      console.error(
        `[Shopify Price Service] Single GraphQL error for variant ${formattedVariantId}:`,
        topLevelError
      );
      return { success: false, error: topLevelError };
    }

    const userErrors = responseJson.data?.productVariantUpdate?.userErrors || [];

    if (userErrors.length > 0) {
      const errorMsg = userErrors
        .map((e) => `${e.field?.join(".") || "field"}: ${e.message}`)
        .join(", ");
      console.error(
        `[Shopify Price Service] Single userErrors for variant ${formattedVariantId}:`,
        errorMsg
      );
      return { success: false, error: errorMsg };
    }

    const updatedVariant = responseJson.data?.productVariantUpdate?.productVariant;
    console.log(
      `[Shopify Price Service] Successfully updated single variant ${formattedVariantId} to $${formattedPrice}`
    );

    return {
      success: true,
      price: updatedVariant?.price ? parseFloat(updatedVariant.price) : safeNewPrice,
      compareAtPrice: updatedVariant?.compareAtPrice
        ? parseFloat(updatedVariant.compareAtPrice)
        : formattedComparePrice === null
        ? null
        : undefined,
    };
  } catch (error: unknown) {
    const errMessage = error instanceof Error ? error.message : "GraphQL execution failed";
    console.error(
      `[Shopify Price Service] Single mutation failed for variant ${formattedVariantId}:`,
      error
    );
    return { success: false, error: errMessage };
  }
}

/**
 * Calculates and applies a price surge for a given variant, updating both Shopify and Prisma.
 */
export async function applyPriceSurge({
  admin,
  shop,
  shopifyVariantId,
  surgePercentage,
  resetDays,
  status = SurgeStatus.AUTO_SURGED,
}: ApplyPriceSurgeParams): Promise<UpdateShopifyVariantPriceResult> {
  const formattedVariantId = ensureGid(shopifyVariantId, "ProductVariant");

  // 1. Fetch current variant record and shop-level surge rules
  const [product, settings] = await Promise.all([
    prisma.surgedProduct.findUnique({ where: { shopifyVariantId: formattedVariantId } }),
    prisma.surgeSetting.findUnique({ where: { shop } }),
  ]);

  if (!product) {
    return { success: false, error: `SurgedProduct record not found for variant ${formattedVariantId}` };
  }

  const surgePct = surgePercentage ?? product.surgePercentage ?? settings?.autoSurgePercentage ?? 10.0;
  const daysToReset = resetDays ?? product.resetDays ?? settings?.autoResetDays ?? 7;

  // 2. Calculate surged price
  let newPrice = Number((product.originalPrice * (1 + surgePct / 100)).toFixed(2));

  // Apply maximum price cap if set in shop settings
  if (settings?.maxPriceCap && newPrice > settings.maxPriceCap) {
    newPrice = settings.maxPriceCap;
  }

  // 3. Update variant in Shopify (baseline original price moves to compareAtPrice)
  const shopifyResult = await updateShopifyVariantPrice({
    admin,
    variantId: formattedVariantId,
    newPrice,
    compareAtPrice: product.originalPrice,
    productId: product.shopifyProductId,
  });

  if (!shopifyResult.success) {
    return shopifyResult;
  }

  // 4. Calculate auto-revert target date
  const resetAt = new Date();
  resetAt.setDate(resetAt.getDate() + daysToReset);

  // 5. Commit updated status to Prisma
  await prisma.surgedProduct.update({
    where: { shopifyVariantId: formattedVariantId },
    data: {
      currentPrice: newPrice,
      surgeStatus: status,
      surgePercentage: surgePct,
      surgedAt: new Date(),
      resetAt: resetAt,
    },
  });

  return {
    success: true,
    price: newPrice,
    compareAtPrice: product.originalPrice,
  };
}

/**
 * Reverts a surged variant back to its original price baseline in Shopify and Prisma.
 */
export async function revertPriceSurge({
  admin,
  shopifyVariantId,
}: RevertPriceSurgeParams): Promise<UpdateShopifyVariantPriceResult> {
  const formattedVariantId = ensureGid(shopifyVariantId, "ProductVariant");

  const product = await prisma.surgedProduct.findUnique({
    where: { shopifyVariantId: formattedVariantId },
  });

  if (!product) {
    return { success: false, error: `SurgedProduct record not found for variant ${formattedVariantId}` };
  }

  // 1. Reset price in Shopify and remove compareAtPrice (pass null)
  const shopifyResult = await updateShopifyVariantPrice({
    admin,
    variantId: formattedVariantId,
    newPrice: product.originalPrice,
    compareAtPrice: null,
    productId: product.shopifyProductId,
  });

  if (!shopifyResult.success) {
    return shopifyResult;
  }

  // 2. Reset database record
  await prisma.surgedProduct.update({
    where: { shopifyVariantId: formattedVariantId },
    data: {
      currentPrice: product.originalPrice,
      surgeStatus: SurgeStatus.NORMAL,
      surgePercentage: 0.0,
      surgedAt: null,
      resetAt: null,
    },
  });

  return {
    success: true,
    price: product.originalPrice,
    compareAtPrice: null,
  };
}

// Named alias to guarantee backwards compatibility across routes
export const updateVariantPrice = updateShopifyVariantPrice;