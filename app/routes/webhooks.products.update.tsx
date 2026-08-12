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
    const productGid = `gid://shopify/Product/${rawProductId}`;

    // Check local database to see if the product is currently in a surge state
    const existingProduct = await db.product.findFirst({
      where: {
        shop,
        OR: [
          { shopifyProductId: rawProductId },
          { shopifyProductId: productGid },
        ],
      },
    });

    const isSurged =
      existingProduct?.isSurged ||
      (existingProduct?.surgeExpiresAt && new Date(existingProduct.surgeExpiresAt) > new Date());

    if (isSurged) {
      console.log(
        `[Webhook products/update] Ignored update for product ${rawProductId} (${shop}) because surge pricing is currently active.`
      );
      return new Response("Ignored: Product pricing is currently surged", { status: 200 });
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