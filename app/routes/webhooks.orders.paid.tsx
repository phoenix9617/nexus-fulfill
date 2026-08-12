// app/routes/webhooks.orders.paid.tsx

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { applyPriceSurge, ensureGid } from "../services/shopifyPrice.server";
import { SurgeStatus } from "@prisma/client";

interface LineItemPayload {
  id: number;
  variant_id: number | null;
  product_id: number | null;
  title: string;
  quantity: number;
  price: string;
  sku?: string | null;
}

interface OrderPaidPayload {
  id: number;
  admin_graphql_api_id: string;
  order_number: number;
  name: string;
  email: string;
  total_price: string;
  currency: string;
  line_items: LineItemPayload[];
  shipping_address?: {
    first_name?: string;
    last_name?: string;
    address1?: string;
    address2?: string;
    city?: string;
    province?: string;
    country?: string;
    zip?: string;
    phone?: string;
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, session, admin, payload } = await authenticate.webhook(request);

  if (topic !== "ORDERS_PAID") {
    console.warn(`[Webhook orders/paid] Unhandled topic received: ${topic}`);
    return new Response("Topic not handled", { status: 200 });
  }

  const orderData = payload as OrderPaidPayload;
  const shopifyOrderId = ensureGid(String(orderData.id), "Order");

  console.log(`[Webhook orders/paid] Processing order #${orderData.order_number} (${shopifyOrderId}) for ${shop}`);

  try {
    // 1. Fetch store surge settings
    const settings = await db.surgeSetting.findUnique({
      where: { shop },
    });

    const isAutoSurgeEnabled = settings?.autoSurgeEnabled ?? true;
    const salesThreshold = settings?.salesThreshold ?? 3;

    // 2. Process each purchased line item
    for (const item of orderData.line_items) {
      if (!item.variant_id) continue;

      const variantGid = ensureGid(String(item.variant_id), "ProductVariant");

      // Find matched surged product
      const product = await db.surgedProduct.findFirst({
        where: { shop, shopifyVariantId: variantGid },
      });

      if (!product) {
        console.warn(`[Webhook orders/paid] Variant ${variantGid} not found in database. Skipping surge check.`);
        continue;
      }

      // Increment sales count
      const updatedProduct = await db.surgedProduct.update({
        where: { id: product.id },
        data: {
          salesCount: { increment: item.quantity },
        },
      });

      // 3. Evaluate Price Surge Condition
      if (
        isAutoSurgeEnabled &&
        admin &&
        updatedProduct.surgeStatus === SurgeStatus.NORMAL &&
        updatedProduct.salesCount >= salesThreshold
      ) {
        console.log(
          `[Webhook orders/paid] Sales threshold met (${updatedProduct.salesCount}/${salesThreshold}) for variant ${variantGid}. Triggering surge...`
        );

        await applyPriceSurge({
          admin,
          shop,
          shopifyVariantId: variantGid,
          surgePercentage: updatedProduct.surgePercentage || settings?.autoSurgePercentage || 10,
          resetDays: updatedProduct.resetDays || settings?.autoResetDays || 7,
          status: SurgeStatus.AUTO_SURGED,
        });
      }
    }

    // 4. Create internal Order record for CJ Dropshipping fulfillment sync
    const existingOrder = await db.order.findFirst({
      where: { shopifyOrderId },
    });

    if (!existingOrder) {
      const recipientName = orderData.shipping_address
        ? `${orderData.shipping_address.first_name || ""} ${orderData.shipping_address.last_name || ""}`.trim()
        : "N/A";

      await db.order.create({
        data: {
          shop,
          shopifyOrderId,
          orderNumber: String(orderData.order_number),
          totalPrice: parseFloat(orderData.total_price) || 0,
          customerEmail: orderData.email || "N/A",
          recipientName: recipientName || "N/A",
          fulfillmentStatus: "UNFULFILLED",
          cjOrderId: null,
          trackingNumber: null,
        },
      });

      console.log(`[Webhook orders/paid] Created fulfillment order record for Order #${orderData.order_number}`);
    }

    return new Response("Order paid webhook processed successfully", { status: 200 });
  } catch (error: unknown) {
    const errMessage = error instanceof Error ? error.message : "Webhook processing failed";
    console.error(`[Webhook orders/paid] Error processing order #${orderData.order_number}:`, error);
    return new Response(`Webhook Error: ${errMessage}`, { status: 500 });
  }
};