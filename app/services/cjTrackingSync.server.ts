// app/services/cjTrackingSync.server.ts

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import db from "../db.server";
import { getCJTrackingInfo } from "./cj.server";

const FULFILLMENT_CREATE_MUTATION = `#graphql
  mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
    fulfillmentCreateV2(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
        trackingInfo {
          number
          url
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface FulfillmentOrderNode {
  id: string;
  status: string;
}

interface SyncOptions {
  admin?: AdminApiContext | any;
  shop?: string;
}

/**
 * Polls CJ Dropshipping for tracking numbers and updates Shopify fulfillments.
 * Accepts either ({ admin, shop }) or (admin, shop).
 */
export async function syncPendingOrderTracking(
  adminOrOptions?: AdminApiContext | SyncOptions | any,
  shopParam?: string
) {
  let admin: any;
  let shop: string | undefined;

  // Handle both object input { admin, shop } and positional arguments (admin, shop)
  if (
    adminOrOptions &&
    typeof adminOrOptions === "object" &&
    ("admin" in adminOrOptions || "shop" in adminOrOptions)
  ) {
    admin = adminOrOptions.admin;
    shop = adminOrOptions.shop;
  } else {
    admin = adminOrOptions;
    shop = shopParam;
  }

  const pendingOrders = await db.fulfilledOrder.findMany({
    where: {
      ...(shop ? { shop } : {}),
      status: "PROCESSING",
      cjOrderId: { not: null },
    },
  });

  let updatedCount = 0;

  for (const order of pendingOrders) {
    if (!order.cjOrderId) continue;

    try {
      // 1. Fetch tracking status from CJ API
      const trackingData = await getCJTrackingInfo(order.cjOrderId);

      if (trackingData?.trackingNumber) {
        const trackingNumber = trackingData.trackingNumber;
        const trackingUrl =
          trackingData.trackingUrl || `https://www.17track.net/en/track#nums=${trackingNumber}`;

        if (admin && order.shopifyOrderId) {
          // 2. Fetch fulfillment order ID from Shopify GraphQL
          const orderResponse = await admin.graphql(
            `#graphql
              query getFulfillmentOrders($id: ID!) {
                order(id: $id) {
                  fulfillmentOrders(first: 5) {
                    nodes {
                      id
                      status
                    }
                  }
                }
              }`,
            {
              variables: { id: order.shopifyOrderId },
            }
          );

          const orderJson = await orderResponse.json();
          const fulfillmentOrders: FulfillmentOrderNode[] =
            orderJson.data?.order?.fulfillmentOrders?.nodes || [];

          const openFulfillmentOrder = fulfillmentOrders.find(
            (fo) => fo.status === "OPEN" || fo.status === "IN_PROGRESS"
          );

          if (openFulfillmentOrder) {
            // 3. Create Fulfillment on Shopify
            const fulfillmentResponse = await admin.graphql(FULFILLMENT_CREATE_MUTATION, {
              variables: {
                fulfillment: {
                  lineItemsByFulfillmentOrder: [
                    {
                      fulfillmentOrderId: openFulfillmentOrder.id,
                    },
                  ],
                  trackingInfo: {
                    number: trackingNumber,
                    url: trackingUrl,
                    company: trackingData.carrier || "CJ Dropshipping",
                  },
                  notifyCustomer: true,
                },
              },
            });

            const fulfillmentJson = await fulfillmentResponse.json();

            if (fulfillmentJson.data?.fulfillmentCreateV2?.fulfillment) {
              // 4. Update database record to FULFILLED
              await db.fulfilledOrder.update({
                where: { id: order.id },
                data: {
                  status: "FULFILLED",
                  trackingNumber,
                  trackingUrl,
                },
              });

              updatedCount++;
            } else {
              console.error(
                `[Tracking Sync] Shopify fulfillment creation failed for order ${order.shopifyOrderId}:`,
                fulfillmentJson.data?.fulfillmentCreateV2?.userErrors
              );
            }
          } else {
            console.warn(`[Tracking Sync] No open fulfillment order found for ${order.shopifyOrderId}`);
          }
        }
      }
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      console.error(`[Tracking Sync] Error processing CJ Order ${order.cjOrderId}: ${errorMsg}`);
    }
  }

  return { success: true, processed: pendingOrders.length, updated: updatedCount };
}

// Named exports to satisfy app._index.tsx and external routes
export {
  syncPendingOrderTracking as syncCJTrackingOrders,
  syncPendingOrderTracking as syncCJTracking,
  syncPendingOrderTracking as syncTracking,
};