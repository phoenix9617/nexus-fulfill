// app/services/shopifyProductSync.server.ts

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import db from "../db.server";
import { getCJTracking } from "./cj.server";
import { ensureGid } from "./shopifyPrice.server";

// ==========================================
// Types & Interfaces
// ==========================================

export interface SyncShopifyProductsOptions {
  admin: AdminApiContext;
  shop: string;
  batchSize?: number;
}

export interface SyncShopifyProductsResult {
  success: boolean;
  count: number;
  error?: string;
  errors?: string[];
}

export interface SyncSingleProductOptions {
  admin: AdminApiContext;
  shop: string;
  productId: string;
}

export interface SyncWebhookProductPayload {
  shop: string;
  productPayload: {
    id: number | string;
    title: string;
    images?: Array<{ src: string }>;
    variants?: Array<{
      id: number | string;
      title?: string;
      price: string | number;
      sku?: string | null;
    }>;
  };
}

interface ShopifyVariantNode {
  id: string;
  title?: string;
  sku: string | null;
  price: string;
  compareAtPrice: string | null;
  image?: {
    url: string;
  } | null;
}

interface ShopifyProductNode {
  id: string;
  title: string;
  featuredImage?: {
    url: string;
  } | null;
  variants: {
    nodes: ShopifyVariantNode[];
  };
}

interface GraphQLProductsResponse {
  data?: {
    products?: {
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
      nodes: ShopifyProductNode[];
    };
  };
  errors?: Array<{ message: string }>;
}

interface GraphQLSingleProductResponse {
  data?: {
    product?: ShopifyProductNode | null;
  };
  errors?: Array<{ message: string }>;
}

export interface SyncTrackingOptions {
  admin?: AdminApiContext;
  shop?: string;
}

export interface SyncTrackingResult {
  success: boolean;
  updatedCount: number;
  error?: string;
}

export interface FulfillmentTrackingInfo {
  trackingNumber: string;
  carrier: string;
}

interface FulfillmentOrderNode {
  id: string;
  status: string;
}

interface GraphQLFulfillmentOrdersResponse {
  data?: {
    order?: {
      fulfillmentOrders?: {
        nodes?: FulfillmentOrderNode[];
      };
    };
  };
  errors?: Array<{ message: string }>;
}

interface GraphQLFulfillmentCreateResponse {
  data?: {
    fulfillmentCreateV2?: {
      fulfillment?: {
        id: string;
        status: string;
      };
      userErrors?: Array<{
        field?: string[];
        message: string;
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

// ==========================================
// GraphQL Queries & Mutations
// ==========================================

const SYNC_PRODUCTS_QUERY = `#graphql
  query getProductsToSync($first: Int!, $cursor: String) {
    products(first: $first, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        featuredImage {
          url
        }
        variants(first: 250) {
          nodes {
            id
            title
            sku
            price
            compareAtPrice
            image {
              url
            }
          }
        }
      }
    }
  }
`;

const SYNC_SINGLE_PRODUCT_QUERY = `#graphql
  query getSingleProductToSync($id: ID!) {
    product(id: $id) {
      id
      title
      featuredImage {
        url
      }
      variants(first: 250) {
        nodes {
          id
          title
          sku
          price
          compareAtPrice
          image {
            url
          }
        }
      }
    }
  }
`;

// ==========================================
// 1. Shopify Product & Variant Sync
// ==========================================

/**
 * Core helper to upsert a variant record into the surgedProduct table.
 * Crucial Rule: Preserves baseline originalPrice if the item is currently in an active surge state.
 */
async function upsertSurgedProductVariant({
  shop,
  productId,
  variantId,
  productTitle,
  variantTitle,
  price,
  sku,
  imageUrl,
}: {
  shop: string;
  productId: string;
  variantId: string;
  productTitle: string;
  variantTitle?: string | null;
  price: number;
  sku?: string | null;
  imageUrl?: string | null;
}): Promise<void> {
  const formattedVariantId = ensureGid(variantId, "ProductVariant");
  const formattedProductId = ensureGid(productId, "Product");

  const existing = await db.surgedProduct.findFirst({
    where: { shop, shopifyVariantId: formattedVariantId },
  });

  const displayTitle =
    variantTitle && variantTitle.toLowerCase() !== "default title"
      ? `${productTitle} - ${variantTitle}`
      : productTitle;

  if (existing) {
    const isNormalState = existing.surgeStatus === "NORMAL";

    await db.surgedProduct.update({
      where: { id: existing.id },
      data: {
        title: displayTitle,
        sku: sku || existing.sku || "N/A",
        shopifyProductId: formattedProductId,
        ...(imageUrl && { imageUrl }),
        // Only update baseline/current prices if the product is in a NORMAL (unsurged) state
        ...(isNormalState
          ? {
              originalPrice: price,
              currentPrice: price,
            }
          : {}),
      },
    });
  } else {
    await db.surgedProduct.create({
      data: {
        shop,
        shopifyProductId: formattedProductId,
        shopifyVariantId: formattedVariantId,
        title: displayTitle,
        sku: sku || "N/A",
        originalPrice: price,
        currentPrice: price,
        salesCount: 0,
        surgeStatus: "NORMAL",
        surgePercentage: 0,
        ...(imageUrl && { imageUrl }),
      },
    });
  }
}

/**
 * Syncs full store catalog products & variants into the surgedProduct database table.
 * Supports cursor pagination for large store catalogs and protects active surge pricing baselines.
 */
export async function syncShopifyProducts({
  admin,
  shop,
  batchSize = 50,
}: SyncShopifyProductsOptions): Promise<SyncShopifyProductsResult> {
  let hasNextPage = true;
  let cursor: string | null = null;
  let syncedCount = 0;

  console.log(`[Shopify Product Sync] Starting full catalog sync for ${shop}...`);

  try {
    while (hasNextPage) {
      const response = await admin.graphql(SYNC_PRODUCTS_QUERY, {
        variables: { first: batchSize, cursor },
      });

      const responseJson = (await response.json()) as GraphQLProductsResponse;

      if (responseJson.errors && responseJson.errors.length > 0) {
        const errorMsg = responseJson.errors.map((e) => e.message).join(", ");
        console.error(`[Shopify Product Sync] GraphQL query error: ${errorMsg}`);
        return { success: false, count: syncedCount, error: errorMsg };
      }

      const productsData = responseJson.data?.products;
      const products = productsData?.nodes || [];

      for (const product of products) {
        const defaultImageUrl = product.featuredImage?.url || null;

        for (const variant of product.variants.nodes) {
          const rawPrice = parseFloat(variant.price);
          const currentPriceNum = !Number.isNaN(rawPrice) && rawPrice >= 0 ? rawPrice : 0;
          const variantImageUrl = variant.image?.url || defaultImageUrl;

          await upsertSurgedProductVariant({
            shop,
            productId: product.id,
            variantId: variant.id,
            productTitle: product.title,
            variantTitle: variant.title,
            price: currentPriceNum,
            sku: variant.sku,
            imageUrl: variantImageUrl,
          });

          syncedCount++;
        }
      }

      hasNextPage = productsData?.pageInfo.hasNextPage ?? false;
      cursor = productsData?.pageInfo.endCursor ?? null;
    }

    console.log(`[Shopify Product Sync] Sync complete. Processed ${syncedCount} variants for ${shop}.`);
    return { success: true, count: syncedCount };
  } catch (error: unknown) {
    const errMessage = error instanceof Error ? error.message : "Product sync failed";
    console.error("[Shopify Product Sync] Unhandled exception:", error);
    return { success: false, count: syncedCount, error: errMessage };
  }
}

/**
 * Syncs a single product and its variants by Shopify Product ID.
 */
export async function syncSingleShopifyProduct({
  admin,
  shop,
  productId,
}: SyncSingleProductOptions): Promise<SyncShopifyProductsResult> {
  const formattedProductId = ensureGid(productId, "Product");

  try {
    const response = await admin.graphql(SYNC_SINGLE_PRODUCT_QUERY, {
      variables: { id: formattedProductId },
    });

    const responseJson = (await response.json()) as GraphQLSingleProductResponse;

    if (responseJson.errors && responseJson.errors.length > 0) {
      const errorMsg = responseJson.errors.map((e) => e.message).join(", ");
      console.error(`[Shopify Product Sync] Single product GraphQL error: ${errorMsg}`);
      return { success: false, count: 0, error: errorMsg };
    }

    const product = responseJson.data?.product;
    if (!product) {
      return { success: false, count: 0, error: `Product not found: ${formattedProductId}` };
    }

    let syncedCount = 0;
    const defaultImageUrl = product.featuredImage?.url || null;

    for (const variant of product.variants.nodes) {
      const rawPrice = parseFloat(variant.price);
      const currentPriceNum = !Number.isNaN(rawPrice) && rawPrice >= 0 ? rawPrice : 0;
      const variantImageUrl = variant.image?.url || defaultImageUrl;

      await upsertSurgedProductVariant({
        shop,
        productId: product.id,
        variantId: variant.id,
        productTitle: product.title,
        variantTitle: variant.title,
        price: currentPriceNum,
        sku: variant.sku,
        imageUrl: variantImageUrl,
      });

      syncedCount++;
    }

    return { success: true, count: syncedCount };
  } catch (error: unknown) {
    const errMessage = error instanceof Error ? error.message : "Single product sync failed";
    console.error(`[Shopify Product Sync] Single product exception for ${formattedProductId}:`, error);
    return { success: false, count: 0, error: errMessage };
  }
}

/**
 * Directly processes a products/create or products/update Webhook JSON payload.
 */
export async function syncProductFromWebhookPayload({
  shop,
  productPayload,
}: SyncWebhookProductPayload): Promise<SyncShopifyProductsResult> {
  try {
    const productId = ensureGid(String(productPayload.id), "Product");
    const defaultImageUrl = productPayload.images?.[0]?.src || null;
    const variants = productPayload.variants || [];

    let syncedCount = 0;

    for (const variant of variants) {
      const variantId = ensureGid(String(variant.id), "ProductVariant");
      const rawPrice = typeof variant.price === "number" ? variant.price : parseFloat(variant.price);
      const currentPriceNum = !Number.isNaN(rawPrice) && rawPrice >= 0 ? rawPrice : 0;

      await upsertSurgedProductVariant({
        shop,
        productId,
        variantId,
        productTitle: productPayload.title,
        variantTitle: variant.title,
        price: currentPriceNum,
        sku: variant.sku,
        imageUrl: defaultImageUrl,
      });

      syncedCount++;
    }

    return { success: true, count: syncedCount };
  } catch (error: unknown) {
    const errMessage = error instanceof Error ? error.message : "Webhook payload sync failed";
    console.error("[Shopify Product Sync] Webhook sync exception:", error);
    return { success: false, count: 0, error: errMessage };
  }
}

// ==========================================
// 2. CJ Tracking & Shopify Fulfillment Sync
// ==========================================

/**
 * Syncs CJ Dropshipping tracking numbers and updates fulfillment status in Shopify and the database.
 */
export async function syncCJTrackingOrders(
  options: SyncTrackingOptions = {}
): Promise<SyncTrackingResult> {
  const { admin, shop } = options;

  console.log(`[CJ Tracking Sync] Starting tracking sync${shop ? ` for ${shop}` : ""}...`);

  let updatedCount = 0;

  try {
    // 1. Fetch pending orders with a CJ order ID missing tracking
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
          const carrierName = trackingData.carrier || "CJ Logistics";

          // 3. Update database record
          await db.order.update({
            where: { id: order.id },
            data: {
              trackingNumber: trackingData.trackingNumber,
              carrier: carrierName,
              fulfillmentStatus: "FULFILLED",
            },
          });

          // 4. Fulfill order in Shopify if admin context & shopifyOrderId exist
          if (admin && order.shopifyOrderId) {
            await fulfillShopifyOrder(admin, order.shopifyOrderId, {
              trackingNumber: trackingData.trackingNumber,
              carrier: carrierName,
            });
          }

          updatedCount++;
        }
      } catch (orderError) {
        console.error(
          `[CJ Tracking Sync] Error syncing CJ Order ${order.cjOrderId}:`,
          orderError
        );
      }
    }

    console.log(`[CJ Tracking Sync] Complete. Updated ${updatedCount} orders.`);
    return { success: true, updatedCount };
  } catch (error: unknown) {
    const errMessage = error instanceof Error ? error.message : "Global sync exception";
    console.error("[CJ Tracking Sync] Global error:", error);
    return { success: false, updatedCount, error: errMessage };
  }
}

/**
 * Helper to fulfill an order in Shopify via Admin GraphQL API.
 */
async function fulfillShopifyOrder(
  admin: AdminApiContext,
  shopifyOrderId: string,
  trackingInfo: FulfillmentTrackingInfo
): Promise<void> {
  try {
    let targetFulfillmentOrderId = shopifyOrderId;

    // Convert standard Order GIDs to FulfillmentOrder IDs if necessary
    if (!shopifyOrderId.includes("FulfillmentOrder")) {
      const formattedOrderId = ensureGid(shopifyOrderId, "Order");

      const GET_FULFILLMENT_ORDERS_QUERY = `#graphql
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

      const foResponse = await admin.graphql(GET_FULFILLMENT_ORDERS_QUERY, {
        variables: { orderId: formattedOrderId },
      });

      const foJson = (await foResponse.json()) as GraphQLFulfillmentOrdersResponse;

      const openFulfillmentOrder = foJson.data?.order?.fulfillmentOrders?.nodes?.find(
        (fo) => fo.status === "OPEN" || fo.status === "IN_PROGRESS"
      );

      if (!openFulfillmentOrder) {
        console.warn(
          `[Shopify Fulfillment] No open fulfillment order found for ${shopifyOrderId}`
        );
        return;
      }

      targetFulfillmentOrderId = openFulfillmentOrder.id;
    }

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

    const response = await admin.graphql(FULFILLMENT_MUTATION, {
      variables: {
        fulfillment: {
          lineItemsByFulfillmentOrder: [
            {
              fulfillmentOrderId: targetFulfillmentOrderId,
            },
          ],
          trackingInfo: {
            company: trackingInfo.carrier,
            number: trackingInfo.trackingNumber,
          },
        },
      },
    });

    const json = (await response.json()) as GraphQLFulfillmentCreateResponse;
    const userErrors = json.data?.fulfillmentCreateV2?.userErrors || [];

    if (userErrors.length > 0) {
      console.warn("[Shopify Fulfillment] User errors encountered:", userErrors);
    } else {
      console.log(
        `[Shopify Fulfillment] Successfully fulfilled order ${shopifyOrderId} with tracking ${trackingInfo.trackingNumber}`
      );
    }
  } catch (err) {
    console.error("[Shopify Fulfillment] Exception while fulfilling order:", err);
  }
}

// Export aliases for backwards compatibility across existing routes and jobs
export {
  syncCJTrackingOrders as syncCJTracking,
  syncCJTrackingOrders as syncTracking,
  syncShopifyProducts as syncProducts,
};