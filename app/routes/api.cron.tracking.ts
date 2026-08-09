// app/routes/api.cron.tracking.ts

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { syncPendingOrderTracking } from "../services/cjTrackingSync.server";

async function handleTrackingCron(request: Request) {
  // 1. Authorization Check (Query Param or Bearer Token)
  const url = new URL(request.url);
  const queryKey = url.searchParams.get("key");
  const authHeader = request.headers.get("authorization");
  const expectedSecret = process.env.CRON_SECRET;

  const isAuthorized =
    !expectedSecret ||
    queryKey === expectedSecret ||
    authHeader === `Bearer ${expectedSecret}`;

  if (!isAuthorized) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // 2. Fetch unique shops that currently have pending CJ orders needing sync
    const pendingShops = await db.fulfilledOrder.findMany({
      where: {
        status: "PROCESSING",
        cjOrderId: { not: null },
      },
      select: { shop: true },
      distinct: ["shop"],
    });

    if (pendingShops.length === 0) {
      return json({
        success: true,
        message: "No pending orders requiring tracking sync.",
        processedShops: 0,
      });
    }

    const summaryResults = [];

    // 3. Process tracking sync per shop using unauthenticated Admin context
    for (const { shop } of pendingShops) {
      try {
        const { admin } = await unauthenticated.admin(shop);
        const result = await syncPendingOrderTracking(admin, shop);
        summaryResults.push({ shop, ...result });
      } catch (shopErr: unknown) {
        const message = shopErr instanceof Error ? shopErr.message : "Shop sync failed";
        console.error(`[Tracking Cron Error] Failed sync for shop ${shop}: ${message}`);
        summaryResults.push({ shop, success: false, error: message });
      }
    }

    return json({
      success: true,
      processedShops: summaryResults.length,
      details: summaryResults,
    });
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : "Unknown tracking sync error";
    console.error("[Tracking Cron Exception]:", error);
    return json({ success: false, error: errorMsg }, { status: 500 });
  }
}

export const loader = ({ request }: LoaderFunctionArgs) => handleTrackingCron(request);
export const action = ({ request }: ActionFunctionArgs) => handleTrackingCron(request);