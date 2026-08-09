// app/routes/api.cron.reset-prices.tsx

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { updateShopifyVariantPrice } from "../services/shopifyPrice.server";
import { getCJAccessToken } from "../services/cj.server";

const CJ_API_BASE = "https://developers.cjdropshipping.com/api2.0/v1";

// --- Tracking Sync Helpers ---

/**
 * Queries CJ API for tracking updates given an order number or ID
 */
async function getCJOrderTracking(orderNumber: string, token: string) {
  try {
    const res = await fetch(
      `${CJ_API_BASE}/shopping/order/list?orderNumber=${encodeURIComponent(orderNumber)}`,
      {
        method: "GET",
        headers: {
          "CJ-Access-Token": token,
        },
      }
    );

    if (!res.ok) {
      console.warn(`[Tracking Sync] CJ HTTP Error ${res.status} for order ${orderNumber}`);
      return null;
    }

    const data = await res.json();
    if (data.code === 200 && data.result?.list?.length > 0) {
      const order = data.result.list[0];
      const trackingNumber = order.trackNumber || order.trackingNumber;
      if (trackingNumber) {
        return {
          trackingNumber,
          logisticName: order.logisticName || "CJ Packet",
          trackingUrl:
            order.trackingUrl ||
            `https://www.17track.net/en/track#nums=${trackingNumber}`,
        };
      }
    }
  } catch (err) {
    console.error(`[Tracking Sync] Error checking CJ status for ${orderNumber}:`, err);
  }
  return null;
}

/**
 * Fulfills a Shopify order via GraphQL Admin API with tracking details
 */
async function fulfillShopifyOrder(
  admin: any,
  shopifyOrderId: string,
  trackingInfo: { trackingNumber: string; logisticName: string; trackingUrl: string }
) {
  // Ensure GID is properly formatted
  const formattedOrderId = shopifyOrderId.startsWith("gid://shopify/Order/")
    ? shopifyOrderId
    : `gid://shopify/Order/${shopifyOrderId}`;

  const foQuery = `#graphql
    query getFulfillmentOrders($orderId: ID!) {
      order(id: $orderId) {
        fulfillmentOrders(first: 5) {
          nodes {
            id
            status
          }
        }
      }
    }
  `;

  const foRes = await admin.graphql(foQuery, {
    variables: { orderId: formattedOrderId },
  });
  const foData = await foRes.json();

  const openFulfillmentOrders = foData.data?.order?.fulfillmentOrders?.nodes?.filter(
    (fo: any) => fo.status === "OPEN" || fo.status === "IN_PROGRESS"
  );

  if (!openFulfillmentOrders || openFulfillmentOrders.length === 0) {
    console.warn(`[Tracking Sync] No open fulfillment order found for ${formattedOrderId}`);
    return false;
  }

  const fulfillmentOrderId = openFulfillmentOrders[0].id;

  const fulfillMutation = `#graphql
    mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
      fulfillmentCreateV2(fulfillment: $fulfillment) {
        fulfillment {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const fulfillRes = await admin.graphql(fulfillMutation, {
    variables: {
      fulfillment: {
        lineItemsByFulfillmentOrder: [{ fulfillmentOrderId }],
        notifyCustomer: true,
        trackingInfo: {
          company: trackingInfo.logisticName,
          number: trackingInfo.trackingNumber,
          url: trackingInfo.trackingUrl,
        },
      },
    },
  });

  const fulfillData = await fulfillRes.json();
  const errors = fulfillData.data?.fulfillmentCreateV2?.userErrors;

  if (errors && errors.length > 0) {
    console.error(`[Tracking Sync] GraphQL Fulfillment Error for ${formattedOrderId}:`, errors);
    return false;
  }

  return true;
}

/**
 * Sweeps CJ Dropshipping for tracking numbers and updates Shopify fulfillments
 */
async function syncCJTrackingNumbers() {
  const token = await getCJAccessToken();
  if (!token) {
    return { syncedCount: 0, message: "CJ Token unavailable" };
  }

  let pendingOrders: Array<{
    id: string;
    shop: string;
    shopifyOrderId: string;
    cjOrderId?: string | null;
    orderName?: string;
  }> = [];

  try {
    // Attempt query on db.fulfilledOrder (primary) or db.order (legacy fallback)
    if ((db as any).fulfilledOrder) {
      pendingOrders = await (db as any).fulfilledOrder.findMany({
        where: { status: { in: ["PROCESSING", "FULFILLMENT_SUBMITTED", "PENDING"] } },
        take: 50,
      });
    } else if ((db as any).order) {
      pendingOrders = await (db as any).order.findMany({
        where: { status: { in: ["PROCESSING", "FULFILLMENT_SUBMITTED", "PENDING"] } },
        take: 50,
      });
    }
  } catch (err) {
    console.warn("[Tracking Sync] Could not fetch pending orders from DB:", err);
    return { syncedCount: 0, message: "DB query failed" };
  }

  let syncedCount = 0;

  for (const orderRecord of pendingOrders) {
    const lookupKey = orderRecord.cjOrderId || orderRecord.orderName || orderRecord.shopifyOrderId;
    if (!lookupKey) continue;

    const tracking = await getCJOrderTracking(lookupKey, token);

    if (tracking) {
      try {
        const { admin } = await unauthenticated.admin(orderRecord.shop);
        const fulfilled = await fulfillShopifyOrder(
          admin,
          orderRecord.shopifyOrderId,
          tracking
        );

        if (fulfilled) {
          const targetDb = (db as any).fulfilledOrder ? (db as any).fulfilledOrder : (db as any).order;
          await targetDb.update({
            where: { id: orderRecord.id },
            data: {
              status: "FULFILLED",
              trackingNumber: tracking.trackingNumber,
            },
          });
          syncedCount++;
        }
      } catch (err) {
        console.error(`[Tracking Sync] Failed to fulfill order ${lookupKey}:`, err);
      }
    }
  }

  return { syncedCount, totalChecked: pendingOrders.length };
}

// --- Main Handler ---

async function handleCronExecution(request: Request) {
  // Optional Bearer token authorization check
  const authHeader = request.headers.get("authorization") || request.headers.get("Authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  // --- Task 1: Tracking Number & Fulfillment Sync ---
  const trackingSyncResult = await syncCJTrackingNumbers();

  // --- Task 2: Price Surge Reset ---
  const now = new Date();

  const expiredProducts = await db.surgedProduct.findMany({
    where: {
      surgeStatus: { in: ["AUTO_SURGED", "FORCE_SURGED"] },
      resetAt: { lte: now },
    },
  });

  let resetCount = 0;
  const errors: string[] = [];

  if (expiredProducts.length > 0) {
    // Group expired products by shop to reuse admin context per store
    const shopGroups = expiredProducts.reduce((acc, product) => {
      if (!acc[product.shop]) acc[product.shop] = [];
      acc[product.shop].push(product);
      return acc;
    }, {} as Record<string, typeof expiredProducts>);

    for (const [shop, products] of Object.entries(shopGroups)) {
      try {
        const { admin } = await unauthenticated.admin(shop);

        for (const product of products) {
          const originalPriceNum = Number(product.originalPrice ?? 0);

          const res = await updateShopifyVariantPrice({
            admin,
            variantId: product.shopifyVariantId,
            productId: product.shopifyProductId || undefined,
            newPrice: originalPriceNum,
          });

          if (res.success) {
            await db.surgedProduct.update({
              where: { id: product.id },
              data: {
                currentPrice: originalPriceNum,
                surgeStatus: "NORMAL",
                salesCount: 0,
                surgedAt: null,
                resetAt: null,
              },
            });
            resetCount++;
            console.log(`[Price Reset Cron] Reset ${product.shopifyVariantId} back to base price $${originalPriceNum}`);
          } else {
            console.error(`Failed to reset variant ${product.shopifyVariantId}:`, res.error);
            errors.push(`${product.shopifyVariantId}: ${res.error}`);
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`Error processing shop ${shop}:`, msg);
        errors.push(`Shop ${shop}: ${msg}`);
      }
    }
  }

  return json({
    success: true,
    trackingSync: trackingSyncResult,
    priceReset: {
      processed: resetCount,
      totalExpired: expiredProducts.length,
      errors: errors.length > 0 ? errors : undefined,
    },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  return handleCronExecution(request);
}

export async function loader({ request }: LoaderFunctionArgs) {
  return handleCronExecution(request);
}