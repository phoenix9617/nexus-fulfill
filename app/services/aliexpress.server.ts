// app/services/aliexpress.server.ts

// --- Types & Interfaces ---

export interface StandardAliProduct {
  id: string;
  externalId: string;
  source: "AliExpress";
  supplier: "AliExpress";
  title: string;
  price: number;
  image: string;
  description: string;
  sku: string;
  variants: any[];
}

export interface StructuredVariantOption {
  name: string;
  value: string;
}

export interface AliExpressStructuredVariant {
  variantId: string;
  name: string;
  options: StructuredVariantOption[];
  price: number;
  sku: string;
  image?: string;
  inventoryQuantity: number;
}

export interface AliExpressProductDetail {
  itemId: string;
  title: string;
  imagePath: string;
  price: string | number;
  description?: string;
  skuProperties?: Array<{
    skuPropertyId: number;
    skuPropertyName: string;
    skuPropertyValues: Array<{
      propertyValueId: number;
      propertyValueName: string;
      skuPropertyTips?: string;
      skuPropertyImagePath?: string;
    }>;
  }>;
  skuList?: Array<{
    skuId: string;
    skuAttr: string;
    skuVal: {
      actSkuCalPrice: string | number;
      skuCalPrice: string | number;
      availQuantity: number;
    };
  }>;
}

// --- Internal Utility Helpers ---

function resolveApiKeyAndHost(apiKey?: string) {
  let key = apiKey;
  if (!key || key.startsWith("v2_auth")) {
    if (key?.startsWith("v2_auth")) {
      console.warn(
        "[AliExpress Server] Provided key is an official AliExpress OAuth token (v2_auth). Falling back to process.env.RAPIDAPI_KEY."
      );
    }
    key = process.env.RAPIDAPI_KEY || process.env.ALIEXPRESS_API_KEY;
  }

  const host = process.env.RAPIDAPI_HOST || "aliexpress-datahub.p.rapidapi.com";
  return { key, host };
}

function parseAliExpressPrice(priceValue: any): number {
  if (typeof priceValue === "number") return priceValue;
  if (typeof priceValue === "string") {
    const cleaned = priceValue.replace(/[^0-9.]/g, "");
    return parseFloat(cleaned) || 0;
  }
  return 0;
}

function normalizeImageUrl(url?: string): string {
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  return url;
}

// --- Core API Exports ---

/**
 * Search AliExpress products via RapidAPI endpoint
 */
export async function searchAliExpress(
  query: string,
  apiKey?: string,
  page = 1
): Promise<StandardAliProduct[]> {
  if (!query || !query.trim()) return [];

  const { key, host } = resolveApiKeyAndHost(apiKey);

  if (!key) {
    console.error("[AliExpress Server] Missing RapidAPI Key.");
    return [];
  }

  try {
    const url = new URL(`https://${host}/item_search`);
    url.searchParams.set("q", query.trim());
    url.searchParams.set("page", page.toString());

    console.log(`[AliExpress Server] Fetching: ${url.toString()}`);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-rapidapi-key": key,
        "x-rapidapi-host": host,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.error(`[AliExpress Server] HTTP Error ${response.status}: ${response.statusText}`);
      const errText = await response.text();
      console.error("[AliExpress Server] Error Response Body:", errText);
      return [];
    }

    const data = await response.json();

    if (data.message && !data.result && !data.data) {
      console.error("[AliExpress Server] RapidAPI Message Error:", data.message);
      return [];
    }

    // Support multiple RapidAPI AliExpress schema wrappers safely
    const rawItems =
      data.result?.status?.data?.products ||
      data.result?.resultList ||
      data.result?.products ||
      data.data?.products ||
      data.result?.items ||
      (Array.isArray(data.result) ? data.result : []) ||
      (Array.isArray(data.data) ? data.data : []);

    console.log(`[AliExpress Server] Successfully retrieved ${rawItems.length} items from API.`);

    return rawItems.map((entry: any) => {
      const item = entry.item || entry;
      const itemId =
        item.itemId || item.productId || item.id || String(Math.floor(Math.random() * 1000000));

      const rawPrice =
        item.sku?.def?.promotionPrice ||
        item.sku?.def?.price ||
        item.price ||
        item.targetSalePrice ||
        item.salePrice ||
        "0";

      const parsedPrice = parseAliExpressPrice(rawPrice);
      const imageUrl = normalizeImageUrl(
        item.image || item.productImage || item.imageUrl || item.picUrl || ""
      );

      return {
        id: `ali_${itemId}`,
        externalId: String(itemId),
        source: "AliExpress" as const,
        supplier: "AliExpress" as const,
        title: item.title || item.productTitle || item.subject || "AliExpress Product",
        price: parsedPrice,
        image: imageUrl,
        description: item.title || item.productTitle || "",
        sku: item.sku?.def?.skuId || `ALI-${itemId}`,
        variants: [],
      };
    });
  } catch (error) {
    console.error("[AliExpress Server] Fetch Error:", error);
    return [];
  }
}

// Aliases for compatibility across search loaders
export const searchAliExpressProducts = searchAliExpress;
export const fetchAliExpressProducts = searchAliExpress;

/**
 * Fetch full item details for a specific AliExpress Item ID
 */
export async function getAliExpressProductDetail(
  itemId: string,
  apiKey?: string
): Promise<AliExpressProductDetail | null> {
  const { key, host } = resolveApiKeyAndHost(apiKey);
  if (!key) return null;

  try {
    const url = new URL(`https://${host}/item_detail`);
    url.searchParams.set("itemId", itemId);

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-rapidapi-key": key,
        "x-rapidapi-host": host,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[AliExpress Server] Item detail HTTP Error ${res.status}: ${errText}`);
      return null;
    }

    const data = await res.json();
    const detail = data?.result?.status?.data || data?.data || data?.result;

    if (!detail) {
      console.error("[AliExpress Server] Empty detail payload for Item ID:", itemId);
      return null;
    }

    if (detail.imagePath) {
      detail.imagePath = normalizeImageUrl(detail.imagePath);
    }

    return detail as AliExpressProductDetail;
  } catch (error) {
    console.error(`[AliExpress Server] Detail fetch exception for ID ${itemId}:`, error);
    return null;
  }
}

/**
 * Extract and structure product variants for an AliExpress Item
 */
export async function getAliExpressProductVariants(
  itemId: string,
  apiKey?: string
): Promise<AliExpressStructuredVariant[]> {
  const detail = await getAliExpressProductDetail(itemId, apiKey);
  if (!detail || !detail.skuList) return [];

  try {
    return detail.skuList.map((skuItem: any, index: number) => {
      const rawPrice = skuItem.skuVal?.actSkuCalPrice || skuItem.skuVal?.skuCalPrice || detail.price;
      const price = parseAliExpressPrice(rawPrice);
      const skuId = skuItem.skuId || `${itemId}-${index}`;

      return {
        variantId: `ali_var_${skuId}`,
        name: skuItem.skuAttr || `Variant ${index + 1}`,
        options: [
          {
            name: "Option",
            value: skuItem.skuAttr || "Default",
          },
        ],
        price,
        sku: `ALI-${itemId}-${skuId}`,
        inventoryQuantity: skuItem.skuVal?.availQuantity || 100,
      };
    });
  } catch (error) {
    console.error(`[AliExpress Server] Variant parsing error for ID ${itemId}:`, error);
    return [];
  }
}

/**
 * Combined details and variant matrix fetcher
 */
export async function getAliExpressProductWithVariants(itemId: string, apiKey?: string) {
  try {
    const detail = await getAliExpressProductDetail(itemId, apiKey);
    if (!detail) return null;

    const variants = await getAliExpressProductVariants(itemId, apiKey);
    const basePrice = parseAliExpressPrice(detail.price);

    return {
      id: `ali-${detail.itemId}`,
      supplierProductId: String(detail.itemId),
      title: detail.title,
      supplier: "AliExpress",
      price: basePrice,
      shippingCost: 3.99,
      shippingDays: "7-15 days",
      shippingDaysMin: 7,
      rating: 4.6,
      baseSku: `ALI-${detail.itemId}`,
      image: normalizeImageUrl(detail.imagePath),
      rawDescription: detail.description || detail.title,
      variants:
        variants.length > 0
          ? variants
          : [
              {
                variantId: `${detail.itemId}-STD`,
                name: "Standard",
                options: [{ name: "Title", value: "Default Title" }],
                price: basePrice,
                sku: `ALI-${detail.itemId}-STD`,
                inventoryQuantity: 100,
              },
            ],
    };
  } catch (error) {
    console.error("[AliExpress Server] Combined product fetch error:", error);
    return null;
  }
}