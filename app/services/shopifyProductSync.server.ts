// app/services/cjTrackingSync.server.ts
import db from "../db.server";
import { getCJTracking } from "./cj.server";

interface SyncTrackingOptions {
  admin?: any;
  shop?: string;
}

/**
 * Syncs CJ Dropshipping tracking numbers and updates fulfillment status in Shopify / Database
 */
export async function syncCJTrackingOrders(options: SyncTrackingOptions = {}) {
  const { admin, shop } = options;

  console.log(`[CJ Tracking Sync] Starting tracking sync${shop ? ` for ${shop}` : ""}...`);

  let updatedCount = 0;

  try {
    // 1. Fetch orders from DB that have a CJ order ID but are missing tracking or unfulfilled
    const pendingOrders = await db.order.findMany({
      where: {
        ...(shop ? { shop } : {}),
        cjOrderId: { not: null },
        trackingNumber: null,
      },
      take: 50,
    });

    for (const order of pendingOrders) {
      if (!order.cjOrderId) continue;

      try {
        // 2. Query CJ API for tracking details
        const trackingData = await getCJTracking(order.cjOrderId);

        if (trackingData && trackingData.trackingNumber) {
          // 3. Update order record in database
          await db.order.update({
            where: { id: order.id },
            data: {
              trackingNumber: trackingData.trackingNumber,
              carrier: trackingData.carrier || "CJ Logistics",
              fulfillmentStatus: "FULFILLED",
            },
          });

          // 4. If Shopify admin client is provided, fulfill the order in Shopify
          if (admin && order.shopifyOrderId) {
            await fulfillShopifyOrder(admin, order.shopifyOrderId, {
              trackingNumber: trackingData.trackingNumber,
              carrier: trackingData.carrier || "CJ Logistics",
            });
          }

          updatedCount++;
        }
      } catch (orderError) {
        console.error(`[CJ Tracking Sync] Error syncing CJ Order ${order.cjOrderId}:`, orderError);
      }
    }

    console.log(`[CJ Tracking Sync] Complete. Updated ${updatedCount} orders.`);
    return { success: true, updatedCount };
  } catch (error) {
    console.error("[CJ Tracking Sync] Global sync error:", error);
    return { success: false, updatedCount, error: (error as Error).message };
  }
}

/**
 * Helper to fulfill an order in Shopify via GraphQL API
 */
async function fulfillShopifyOrder(
  admin: any,
  shopifyOrderId: string,
  trackingInfo: { trackingNumber: string; carrier: string }
) {
  const FULFILLMENT_MUTATION = `#graphql
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

  try {
    const response = await admin.graphql(FULFILLMENT_MUTATION, {
      variables: {
        fulfillment: {
          lineItemsByFulfillmentOrder: [
            {
              fulfillmentOrderId: shopifyOrderId,
            },
          ],
          trackingInfo: {
            company: trackingInfo.carrier,
            number: trackingInfo.trackingNumber,
          },
        },
      },
    });

    const json = await response.json();
    if (json.data?.fulfillmentCreateV2?.userErrors?.length > 0) {
      console.warn("[Shopify Fulfillment] User errors:", json.data.fulfillmentCreateV2.userErrors);
    }
  } catch (err) {
    console.error("[Shopify Fulfillment] Exception while fulfilling order:", err);
  }
}