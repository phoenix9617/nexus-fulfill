// app/routes/webhooks.products.update.tsx

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { syncProductFromWebhookPayload } from "../services/shopifyProductSync.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic !== "PRODUCTS_UPDATE") {
    console.warn(`[Webhook products/update] Unhandled topic received: ${topic}`);
    return new Response("Topic not handled", { status: 200 });
  }

  console.log(`[Webhook products/update] Received product update for ${shop}`);

  try {
    const rawProductId = String((payload as any)?.id || "");
    const numericId = rawProductId.replace("gid://shopify/Product/", "");
    const productGid = `gid://shopify/Product/${numericId}`;

    // Query db.surgedProduct matching all potential ID format variations
    const existingSurgedProduct = await db.surgedProduct.findFirst({
      where: {
        shop,
        OR: [
          { shopifyProductId: numericId },
          { shopifyProductId: productGid },
          { shopifyProductId: rawProductId },
        ],
      },
    });

    if (existingSurgedProduct) {
      const status = existingSurgedProduct.surgeStatus?.toUpperCase();
      const hasNotExpired = existingSurgedProduct.surgeExpiresAt
        ? new Date(existingSurgedProduct.surgeExpiresAt) > new Date()
        : false;

      const isSurged =
        status === "AUTO_SURGED" ||
        status === "SURGED" ||
        status === "ACTIVE" ||
        status === "ENABLED" ||
        hasNotExpired;

      console.log(
        `[Webhook products/update] Record found for product ${numericId} on ${shop}. Status: ${status}, ExpiresAt: ${existingSurgedProduct.surgeExpiresAt}, isSurged: ${isSurged}`
      );

      if (isSurged) {
        console.log(
          `[Webhook products/update] 🛑 BLOCKED SYNC for product ${numericId} on ${shop} because surge status is active.`
        );
        return new Response("Ignored: Product pricing is currently surged", { status: 200 });
      }
    } else {
      console.log(
        `[Webhook products/update] No surgedProduct record found for Product ID: ${numericId}`
      );
    }

    const result = await syncProductFromWebhookPayload({
      shop,
      productPayload: payload as any,
    });

    if (!result.success) {
      console.error(`[Webhook products/update] Failed to sync product payload for ${shop}:`, result.error);
      return new Response("Error syncing product payload", { status: 500 });
    }

    console.log(
      `[Webhook products/update] Successfully synced ${result.count} variant(s) for ${shop}`
    );

    return new Response("Product update webhook processed successfully", { status: 200 });
  } catch (error: unknown) {
    const errMessage = error instanceof Error ? error.message : "Webhook processing failed";
    console.error(`[Webhook products/update] Exception during sync for ${shop}:`, error);
    return new Response(`Webhook Error: ${errMessage}`, { status: 500 });
  }
};