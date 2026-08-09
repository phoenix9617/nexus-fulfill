// app/services/shopifyProductSync.server.ts
import db from "../db.server";
import { evaluateAutoSurgeForShop } from "./surge.server";

const PRODUCTS_QUERY = `#graphql
  query getProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        variants(first: 50) {
          nodes {
            id
            title
            price
            sku
          }
        }
      }
    }
  }
`;

/**
 * Helper to execute GraphQL queries with exponential backoff when Shopify rate-limits (THROTTLED)
 */
async function executeGqlWithRetry(
  admin: any,
  query: string,
  variables: Record<string, any>,
  retries = 3,
  delayMs = 1000
): Promise<any> {
  try {
    const response = await admin.graphql(query, { variables });
    const json = await response.json();

    if (json.errors && json.errors.some((e: any) => e.message?.includes("THROTTLED"))) {
      if (retries > 0) {
        console.warn(`[Shopify Sync] Rate limit hit. Retrying in ${delayMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return executeGqlWithRetry(admin, query, variables, retries - 1, delayMs * 2);
      }
    }

    return json;
  } catch (error) {
    if (retries > 0) {
      console.warn(`[Shopify Sync] Network exception. Retrying in ${delayMs}ms...`, error);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return executeGqlWithRetry(admin, query, variables, retries - 1, delayMs * 2);
    }
    throw error;
  }
}

export async function syncShopifyProducts({
  admin,
  shop,
}: {
  admin: any;
  shop: string;
}) {
  let hasNextPage = true;
  let cursor: string | null = null;
  let importedCount = 0;

  // Fetch store auto-surge settings defaults
  const settings = await db.surgeSetting.findUnique({
    where: { shop },
  });

  const defaultThreshold = settings?.autoSalesThreshold ?? 10;
  const defaultResetDays = settings?.autoResetDays ?? 7;

  while (hasNextPage) {
    const json = await executeGqlWithRetry(admin, PRODUCTS_QUERY, {
      first: 50,
      after: cursor,
    });

    const productsData = json.data?.products;

    if (!productsData || !productsData.nodes) {
      console.warn("[Shopify Sync] No product data returned or sync completed early.");
      break;
    }

    for (const product of productsData.nodes) {
      const productId = product.id;

      for (const variant of product.variants.nodes) {
        const variantId = variant.id;
        const price = parseFloat(variant.price || "0");
        const variantTitle =
          variant.title === "Default Title"
            ? product.title
            : `${product.title} - ${variant.title}`;

        // Upsert product variants into database without overwriting active surge states
        await db.surgedProduct.upsert({
          where: { shopifyVariantId: variantId },
          update: {
            title: variantTitle,
            sku: variant.sku || "",
          },
          create: {
            shop,
            shopifyProductId: productId,
            shopifyVariantId: variantId,
            title: variantTitle,
            sku: variant.sku || "",
            originalPrice: price,
            currentPrice: price,
            salesCount: 0,
            surgeStatus: "NORMAL",
            autoSurgeThreshold: defaultThreshold,
            resetDays: defaultResetDays,
          },
        });

        importedCount++;
      }
    }

    hasNextPage = productsData.pageInfo.hasNextPage;
    cursor = productsData.pageInfo.endCursor;
  }

  // Run auto-surge logic immediately after products are synced
  try {
    await evaluateAutoSurgeForShop({ admin, shop });
  } catch (error) {
    console.error("[Shopify Sync] Failed to evaluate auto surge after sync:", error);
  }

  return { success: true, count: importedCount };
}