// app/routes/webhooks.products.update.tsx

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { syncProductFromWebhookPayload } from "../services/shopifyProductSync.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic !== "PRODUCTS_UPDATE") {
    console.warn(`[Webhook products/update] Unhandled topic received: ${topic}`);
    return new Response("Topic not handled", { status: 200 });
  }

  console.log(`[Webhook products/update] Received product update for ${shop}`);

  try {
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