// app/routes/webhooks.orders.create.tsx

import type { ActionFunctionArgs } from "@remix-run/node";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";
import { updateShopifyVariantPrice } from "../services/shopifyPrice.server";
import { getCJAccessToken } from "../services/cj.server";

const CJ_API_BASE = "https://developers.cjdropshipping.com/api2.0/v1";

interface ShopifyShippingAddress {
  first_name?: string;
  last_name?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  country?: string;
  zip?: string;
  phone?: string;
  country_code?: string;
}

interface ShopifyLineItem {
  id: number;
  variant_id: number | string | null;
  product_id: number | string | null;
  title?: string;
  name?: string;
  sku?: string;
  quantity: number;
  price?: string;
}

interface CJSubmitResult {
  success: boolean;
  cjOrderId?: string;
  error?: string;
}

function roundCurrency(val: number): number {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

function ensureGid(id: number | string, type: "Product" | "ProductVariant" | "Order"): string {
  const strId = String(id);
  if (strId.startsWith("gid://")) return strId;
  return `gid://shopify/${type}/${strId}`;
}

/**
 * Sends fulfillment request directly to CJ Dropshipping API
 */
async function submitOrderToCJ(orderData: {
  orderId: string;
  name: string;
  shippingAddress: ShopifyShippingAddress;
  items: Array<{ sku: string; quantity: number }>;
}): Promise<CJSubmitResult> {
  const token = await getCJAccessToken();
  if (!token) {
    console.error(`[CJ Fulfillment] Access token unavailable for Order #${orderData.orderId}`);
    return { success: false, error: "CJ Token Unavailable" };
  }

  const { shippingAddress } = orderData;
  const customerName =
    `${shippingAddress.first_name || ""} ${shippingAddress.last_name || ""}`.trim() ||
    "Customer";

  const payload = {
    orderNumber: orderData.name || orderData.orderId,
    shippingCustomerName: customerName,
    shippingAddress: shippingAddress.address1 || "",
    shippingAddress2: shippingAddress.address2 || "",
    shippingCity: shippingAddress.city || "",
    shippingProvince: shippingAddress.province || "",
    shippingCountryCode: shippingAddress.country_code || "US",
    shippingZip: shippingAddress.zip || "",
    shippingPhone: shippingAddress.phone || "0000000000",
    products: orderData.items.map((item) => ({
      sku: item.sku,
      quantity: item.quantity,
    })),
  };

  try {
    const res = await fetch(`${CJ_API_BASE}/shopping/order/createOrder`, {
      method: "POST",
      headers: {
        "CJ-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.error(
        `[CJ Fulfillment] HTTP Error ${res.status} when creating order for ${orderData.name}`
      );
      return { success: false, error: `CJ HTTP Error ${res.status}` };
    }

    const data = (await res.json()) as {
      code?: number;
      result?: string | { orderId?: string };
      message?: string;
    };

    if (data.code === 200) {
      const cjOrderId =
        typeof data.result === "string" ? data.result : data.result?.orderId || null;
      console.log(
        `[CJ Fulfillment] Order submitted successfully for Shopify Order ${orderData.name}:`,
        cjOrderId
      );
      return { success: true, cjOrderId: cjOrderId || undefined };
    }

    console.error(
      `[CJ Fulfillment] Submission rejected for Order ${orderData.name}:`,
      data.message
    );
    return { success: false, error: data.message || "CJ API Rejected Order" };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : "Network Error";
    console.error(`[CJ Fulfillment] Error dispatching order to CJ:`, err);
    return { success: false, error: errorMsg };
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, admin: webhookAdmin } = await authenticate.webhook(request);

  if (topic !== "ORDERS_CREATE") {
    return new Response("Topic ignored", { status: 200 });
  }

  if (!shop) {
    return new Response("Missing shop context", { status: 400 });
  }

  const lineItems: ShopifyLineItem[] = payload.line_items || [];
  if (lineItems.length === 0) {
    return new Response("No line items to process", { status: 200 });
  }

  const rawOrderId = payload.admin_graphql_api_id || payload.id;
  const shopifyOrderId = ensureGid(rawOrderId, "Order");
  const orderName = payload.name || `#${payload.id}`;
  const shippingAddress: ShopifyShippingAddress | undefined = payload.shipping_address;

  // --- 1. CJ DROPSHIPPING AUTOMATED FULFILLMENT ---
  try {
    const cjLineItems = lineItems.filter(
      (item) => item.sku && (item.sku.startsWith("CJ-") || item.sku.startsWith("ALI-"))
    );

    if (cjLineItems.length > 0 && shippingAddress) {
      console.log(
        `[CJ Fulfillment] Found ${cjLineItems.length} supplier item(s) in Order ${orderName}`
      );

      const itemsToFulfill = cjLineItems.map((item) => ({
        sku: item.sku!,
        quantity: item.quantity || 1,
      }));

      const cjResult = await submitOrderToCJ({
        orderId: String(payload.id),
        name: orderName,
        shippingAddress,
        items: itemsToFulfill,
      });

      await db.fulfilledOrder.upsert({
        where: { shopifyOrderId },
        update: {
          cjOrderId: cjResult.cjOrderId || null,
          status: cjResult.success ? "PROCESSING" : "FAILED",
        },
        create: {
          shop,
          shopifyOrderId,
          cjOrderId: cjResult.cjOrderId || null,
          status: cjResult.success ? "PROCESSING" : "FAILED",
        },
      });
    }
  } catch (cjError: unknown) {
    console.error("[CJ Fulfillment] Workflow execution error:", cjError);
  }

  // --- 2. AUTO-SURGE PRICING ENGINE ---
  try {
    const settings = await db.surgeSetting.findUnique({
      where: { shop },
    });

    if (settings && "isEnabled" in settings && (settings as { isEnabled?: boolean }).isEnabled === false) {
      return new Response("Auto Surge disabled", { status: 200 });
    }

    const defaultThreshold = settings?.autoSalesThreshold ?? 10;
    const defaultSurgePct = Number(settings?.autoSurgePercentage ?? 10.0);
    const defaultResetDays = settings?.autoResetDays ?? 7;

    // Resolve Admin API context with fallback
    let admin: AdminApiContext | undefined = webhookAdmin;
    if (!admin) {
      try {
        const unauthContext = await unauthenticated.admin(shop);
        admin = unauthContext.admin;
      } catch (e: unknown) {
        console.warn(
          `[Auto-Surge] Could not construct unauthenticated admin client for shop ${shop}:`,
          e
        );
      }
    }

    for (const item of lineItems) {
      if (!item.variant_id) continue;

      const variantGid = ensureGid(item.variant_id, "ProductVariant");
      const productGid = item.product_id ? ensureGid(item.product_id, "Product") : undefined;
      const quantityPurchased = Math.max(1, item.quantity || 1);

      let record = await db.surgedProduct.findUnique({
        where: { shopifyVariantId: variantGid },
      });

      const itemPrice = parseFloat(item.price || "0");
      const safePrice = !Number.isNaN(itemPrice) && itemPrice >= 0 ? roundCurrency(itemPrice) : 0;

      if (!record) {
        record = await db.surgedProduct.create({
          data: {
            shop,
            shopifyProductId: productGid || "",
            shopifyVariantId: variantGid,
            title: item.title || item.name || "Product Variant",
            sku: item.sku || "N/A",
            originalPrice: safePrice,
            currentPrice: safePrice,
            salesCount: quantityPurchased,
            autoSurgeThreshold: defaultThreshold,
            resetDays: defaultResetDays,
          },
        });
      } else {
        record = await db.surgedProduct.update({
          where: { id: record.id },
          data: {
            salesCount: { increment: quantityPurchased },
          },
        });
      }

      // Trigger Surge Evaluation
      const threshold = record.autoSurgeThreshold || defaultThreshold;
      const currentSales = record.salesCount;

      if (record.surgeStatus === "NORMAL" && currentSales >= threshold) {
        const rawOriginal = Number(record.originalPrice);
        const basePrice =
          rawOriginal && rawOriginal > 0
            ? roundCurrency(rawOriginal)
            : safePrice > 0
            ? safePrice
            : roundCurrency(Number(record.currentPrice ?? 0));

        if (basePrice <= 0) {
          console.warn(`[Auto-Surge] Skipped variant ${variantGid}: Invalid baseline price ($${basePrice}).`);
          continue;
        }

        const recordSurgePct = Number(record.surgePercentage ?? 0);
        const surgePct = recordSurgePct > 0 ? recordSurgePct : defaultSurgePct;

        const newPrice = roundCurrency(basePrice * (1 + surgePct / 100));
        const resetDays = record.resetDays || defaultResetDays;
        const resetAt = new Date();
        resetAt.setDate(resetAt.getDate() + resetDays);

        if (admin) {
          const res = await updateShopifyVariantPrice({
            admin,
            variantId: variantGid,
            productId: productGid || record.shopifyProductId,
            newPrice,
          });

          if (res.success) {
            const finalPrice = res.price ?? newPrice;
            await db.surgedProduct.update({
              where: { id: record.id },
              data: {
                originalPrice: basePrice,
                currentPrice: finalPrice,
                surgeStatus: "AUTO_SURGED",
                surgePercentage: surgePct,
                surgedAt: new Date(),
                resetAt,
              },
            });
            console.log(
              `[Auto-Surge] Variant ${variantGid} successfully surged from $${basePrice.toFixed(2)} to $${finalPrice.toFixed(2)}`
            );
          } else {
            console.error(`[Auto-Surge] Failed to surge variant ${variantGid}:`, res.error);
          }
        } else {
          console.error(
            `[Auto-Surge] Skipped price update for ${variantGid}: Admin GraphQL client unavailable.`
          );
        }
      }
    }
  } catch (surgeError: unknown) {
    console.error("[Auto-Surge] Workflow execution error:", surgeError);
  }

  return new Response("OK", { status: 200 });
};