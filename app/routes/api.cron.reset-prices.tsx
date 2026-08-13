import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { revertPriceSurge, updateShopifyVariantPrice } from "../services/shopifyPrice.server";
import { syncCJTrackingOrders } from "../services/shopifyProductSync.server";

function roundCurrency(val: number): number {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

// --- Main Handler ---

async function handleCronExecution(request: Request) {
  const url = new URL(request.url);
  const querySecret = url.searchParams.get("secret") || url.searchParams.get("key");
  const authHeader = request.headers.get("authorization") || request.headers.get("Authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret) {
    const isHeaderValid = authHeader === `Bearer ${cronSecret}`;
    const isQueryValid = querySecret === cronSecret;

    if (!isHeaderValid && !isQueryValid) {
      return json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // --- Task 1: CJ Tracking Number & Fulfillment Sync ---
  let trackingUpdatedCount = 0;
  try {
    const trackingRes = await syncCJTrackingOrders();
    // Safely extract count without dumping large object payload into response
    trackingUpdatedCount =
      typeof trackingRes?.updatedCount === "number"
        ? trackingRes.updatedCount
        : typeof trackingRes?.count === "number"
        ? trackingRes.count
        : 0;

    console.log("[Cron Reset Prices] Tracking Sync finished:", trackingRes);
  } catch (trackingErr) {
    console.error("[Cron Reset Prices] Error during tracking sync:", trackingErr);
  }

  // --- Task 2: Price Surge Reset ---
  const now = new Date();

  const expiredProducts = await db.surgedProduct.findMany({
    where: {
      surgeStatus: { in: ["AUTO_SURGED", "FORCE_SURGED", "MANUAL_SURGED"] },
      resetAt: { lte: now },
    },
  });

  let resetCount = 0;
  const errors: string[] = [];

  if (expiredProducts.length > 0) {
    const shopGroups = expiredProducts.reduce((acc, product) => {
      if (!acc[product.shop]) acc[product.shop] = [];
      acc[product.shop].push(product);
      return acc;
    }, {} as Record<string, typeof expiredProducts>);

    for (const [shop, products] of Object.entries(shopGroups)) {
      try {
        const { admin } = await unauthenticated.admin(shop);

        for (const product of products) {
          const originalPriceNum = roundCurrency(Number(product.originalPrice ?? 0));

          if (originalPriceNum <= 0) {
            console.warn(
              `[Price Reset Cron] Invalid base price ($${originalPriceNum}) for ${product.shopifyVariantId}, skipping.`
            );
            continue;
          }

          let res: { success: boolean; error?: string };

          if (typeof revertPriceSurge === "function") {
            res = await revertPriceSurge({
              admin,
              shop,
              shopifyVariantId: product.shopifyVariantId,
            });
          } else {
            const updateRes = await updateShopifyVariantPrice({
              admin,
              variantId: product.shopifyVariantId,
              productId: product.shopifyProductId || undefined,
              newPrice: originalPriceNum,
            });

            if (updateRes.success) {
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
              res = { success: true };
            } else {
              res = { success: false, error: updateRes.error };
            }
          }

          if (res.success) {
            resetCount++;
            console.log(
              `[Price Reset Cron] Reset ${product.shopifyVariantId} back to base price $${originalPriceNum.toFixed(2)}`
            );
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

  // Log full errors to Render server logs instead of sending them in HTTP body
  if (errors.length > 0) {
    console.error(`[Price Reset Cron] Encountered ${errors.length} errors:`, errors);
  }

  // Return a compact JSON response (< 150 bytes)
  return json({
    success: errors.length === 0,
    timestamp: new Date().toISOString(),
    trackingUpdatedCount,
    resetCount,
    totalExpired: expiredProducts.length,
    errorCount: errors.length,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  return handleCronExecution(request);
}

export async function loader({ request }: LoaderFunctionArgs) {
  return handleCronExecution(request);
}