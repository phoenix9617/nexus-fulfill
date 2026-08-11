// app/services/cj.server.ts

const CJ_API_BASE = "https://developers.cjdropshipping.com/api2.0/v1";

// --- Types & Interfaces ---

export interface StandardProduct {
  id: string;
  externalId: string;
  source: "CJ Dropshipping";
  title: string;
  price: number;
  image: string;
  description: string;
  sku?: string;
  supplier: string;
}

export interface CJAuthResponse {
  code: number;
  message: string;
  result: {
    accessToken: string;
    accessTokenExpiryDate: string;
  };
  data?: {
    accessToken: string;
    accessTokenExpiryDate: string;
  };
}

export interface CJProductVariant {
  vid: string;
  pid: string;
  variantSku: string;
  variantName: string;
  variantNameEn?: string;
  variantProperty?: string;
  variantKey?: string;
  variantPrice: number | string;
  variantImage?: string;
  variantUnit?: string;
  variantVolume?: number;
  variantWeight?: number;
}

export interface StructuredVariantOption {
  name: string;
  value: string;
}

export interface CJStructuredVariant {
  variantId: string;
  name: string;
  options: StructuredVariantOption[];
  price: number;
  sku: string;
  image?: string;
  inventoryQuantity: number;
}

export interface CJProductDetail {
  pid: string;
  productName: string;
  productSku: string;
  productImage: string;
  productWeight: string;
  productType: string;
  categoryName: string;
  sellPrice?: string;
  entryCode?: string;
  variants: CJProductVariant[];
  description?: string;
}

export interface CJShippingCostRequest {
  startCountryCode?: string;
  endCountryCode: string;
  productWeight: number;
  proNum?: number;
  variantId?: string;
}

export interface CJShippingCostResponse {
  code: number;
  message: string;
  result: Array<{
    logisticName: string;
    logisticAging: string;
    logisticPrice: number;
  }>;
}

export interface CJOrderItem {
  vid: string;
  quantity: number;
}

export interface CJShippingAddress {
  customerName: string;
  address: string;
  address2?: string;
  city: string;
  province: string;
  country: string;
  zip: string;
  phone?: string;
}

export interface CJCreateOrderParams {
  shopifyOrderId: string;
  shippingAddress: CJShippingAddress;
  items: CJOrderItem[];
  logisticName?: string;
}

// --- Property Parsing Utility ---

export function parseCJVariantProperties(
  propertyStr: string,
  variantName: string
): StructuredVariantOption[] {
  const options: StructuredVariantOption[] = [];

  if (propertyStr && propertyStr.includes(":")) {
    const pairs = propertyStr.split(",");
    for (const pair of pairs) {
      const [key, val] = pair.split(":");
      if (key && val) {
        options.push({ name: key.trim(), value: val.trim() });
      }
    }
  } else if (propertyStr && propertyStr.includes("-")) {
    const parts = propertyStr.split("-");
    if (parts.length >= 2) {
      options.push({ name: "Color", value: parts[0].trim() });
      options.push({ name: "Size", value: parts[1].trim() });
    }
  } else if (variantName && variantName.includes("/")) {
    const parts = variantName.split("/");
    if (parts.length === 2) {
      options.push({ name: "Color", value: parts[0].trim() });
      options.push({ name: "Size", value: parts[1].trim() });
    } else {
      parts.forEach((p, i) => {
        options.push({ name: `Option ${i + 1}`, value: p.trim() });
      });
    }
  }

  if (options.length === 0) {
    options.push({
      name: "Title",
      value: variantName || propertyStr || "Default Title",
    });
  }

  return options;
}

// --- API Helpers ---

/**
 * Obtain an Access Token from CJ Dropshipping
 */
export async function getCJAccessToken(customApiKey?: string): Promise<string | null> {
  const apiKey = customApiKey || process.env.CJ_API_KEY || process.env.CJ_ACCESS_TOKEN;
  if (!apiKey) {
    console.error("[CJ Server] Missing CJ API Key/Token.");
    return null;
  }

  // If provided key is already a full JWT access token (long string), return directly
  if (apiKey.length > 50 && !apiKey.includes("-")) {
    return apiKey;
  }

  try {
    const res = await fetch(`${CJ_API_BASE}/authentication/getAccessToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: process.env.CJ_EMAIL,
        apiKey,
      }),
    });

    if (!res.ok) {
      throw new Error(`Auth request failed with status ${res.status}`);
    }

    const data: CJAuthResponse = await res.json();
    const token = data.result?.accessToken || data.data?.accessToken;

    if ((data.code === 200 || data.code === 0) && token) {
      return token;
    }

    console.error("[CJ Server] Auth error response message:", data.message || "Unknown auth error");
  } catch (error) {
    console.error("[CJ Server] Authentication exception:", error);
  }

  return null;
}

/**
 * Search CJ Dropshipping Product Catalog by keyword.
 */
export async function searchCJProducts(
  keyword: string,
  apiKeyOrToken?: string,
  pageNum = 1,
  pageSize = 20
): Promise<StandardProduct[]> {
  const token = await getCJAccessToken(apiKeyOrToken);
  if (!token) return [];

  try {
    const url = new URL(`${CJ_API_BASE}/product/list`);
    if (keyword) url.searchParams.set("productName", keyword);
    url.searchParams.set("pageNum", pageNum.toString());
    url.searchParams.set("pageSize", pageSize.toString());

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "CJ-Access-Token": token,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(`Product search HTTP error ${res.status}`);
    }

    const data = await res.json();
    if (data.code !== 200 && data.code !== 0) {
      console.warn("[CJ Server] API Returned non-200 code:", data.code, data.message);
      return [];
    }

    const rawList =
      data.data?.list ||
      data.result?.list ||
      (Array.isArray(data.data) ? data.data : []) ||
      (Array.isArray(data.result) ? data.result : []);

    return rawList.map((item: any) => ({
      id: `cj_${item.pid}`,
      externalId: item.pid,
      source: "CJ Dropshipping" as const,
      supplier: "CJ Dropshipping",
      title: item.productNameEn || item.productName || "Untitled Product",
      price: parseFloat(item.sellPrice || item.productPrice || item.price || "0"),
      image: item.productImage || "",
      description: item.description || item.productNameEn || item.productName || "",
      sku: item.productSku || `CJ-${item.pid}`,
    }));
  } catch (error) {
    console.error("[CJ Server] Product search error:", error);
    return [];
  }
}

// Alias for searchCJProducts to support imports expecting fetchCJProducts
export const fetchCJProducts = searchCJProducts;

/**
 * Fetch complete Product Details
 */
export async function getCJProductDetail(productId: string, apiKeyOrToken?: string) {
  const token = await getCJAccessToken(apiKeyOrToken);
  if (!token) return null;

  try {
    const url = new URL(`${CJ_API_BASE}/product/query`);
    url.searchParams.set("pid", productId);

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "CJ-Access-Token": token,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(`Product detail HTTP error ${res.status}`);
    }

    const data = await res.json();
    if (data.code === 200 || data.code === 0) {
      return (data.result || data.data) as CJProductDetail;
    }

    console.error("[CJ Server] Error fetching product detail:", data.message);
  } catch (error) {
    console.error("[CJ Server] Product detail fetch error:", error);
  }

  return null;
}

/**
 * Fetch sub-variants for a specific CJ Product ID
 */
export async function getCJProductVariants(
  pid: string,
  providedToken?: string
): Promise<CJStructuredVariant[]> {
  const token = await getCJAccessToken(providedToken);
  if (!token) return [];

  try {
    const url = new URL(`${CJ_API_BASE}/product/variant/query`);
    url.searchParams.set("pid", pid);

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "CJ-Access-Token": token,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(`Variant matrix HTTP error ${res.status}`);
    }

    const data = await res.json();
    const rawVariants = data.result || data.data;

    if ((data.code === 200 || data.code === 0) && Array.isArray(rawVariants)) {
      return rawVariants.map((v: CJProductVariant) => {
        const rawName = v.variantNameEn || v.variantName || "Standard";
        const rawProp = v.variantProperty || v.variantKey || "";
        const options = parseCJVariantProperties(rawProp, rawName);

        return {
          variantId: v.vid || `${pid}-${v.variantSku}`,
          name: rawName,
          options,
          price: typeof v.variantPrice === "number" ? v.variantPrice : parseFloat(v.variantPrice || "0"),
          sku: v.variantSku || `CJ-${pid}-${v.vid}`,
          image: v.variantImage || undefined,
          inventoryQuantity: 100,
        };
      });
    }

    console.error("[CJ Server] Error fetching variant matrix:", data.message);
  } catch (error) {
    console.error(`[CJ Server] Variant fetch error for PID ${pid}:`, error);
  }

  return [];
}

/**
 * Combined details and variant matrix fetcher
 */
export async function getCJProductWithVariants(productId: string, apiKeyOrToken?: string) {
  const token = await getCJAccessToken(apiKeyOrToken);
  if (!token) return null;

  try {
    const [detail, variants] = await Promise.all([
      getCJProductDetail(productId, token),
      getCJProductVariants(productId, token),
    ]);

    if (!detail) return null;

    const basePrice = parseFloat(detail.sellPrice || "0");

    return {
      id: `cj-${detail.pid}`,
      supplierProductId: detail.pid,
      title: detail.productName,
      supplier: "CJ Dropshipping",
      price: basePrice,
      shippingCost: 2.5,
      shippingDays: "5-10 days",
      shippingDaysMin: 5,
      rating: 4.8,
      baseSku: detail.productSku || `CJ-${detail.pid}`,
      image: detail.productImage,
      rawDescription: detail.description || detail.productName,
      variants:
        variants.length > 0
          ? variants
          : [
              {
                variantId: `${detail.pid}-STD`,
                name: "Standard",
                options: [{ name: "Title", value: "Default Title" }],
                price: basePrice,
                sku: detail.productSku || `CJ-${detail.pid}-STD`,
                inventoryQuantity: 100,
              },
            ],
    };
  } catch (error) {
    console.error("[CJ Server] Combined product fetch error:", error);
    return null;
  }
}

/**
 * Estimate Shipping Rates
 */
export async function calculateCJShipping(params: CJShippingCostRequest, apiKeyOrToken?: string) {
  const token = await getCJAccessToken(apiKeyOrToken);
  if (!token) return null;

  try {
    const res = await fetch(`${CJ_API_BASE}/logistic/freightCalculate`, {
      method: "POST",
      headers: {
        "CJ-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        startCountryCode: params.startCountryCode || "CN",
        endCountryCode: params.endCountryCode || "US",
        productWeight: params.productWeight,
        proNum: params.proNum || 1,
        variantId: params.variantId,
      }),
    });

    if (!res.ok) {
      throw new Error(`Shipping calculation HTTP error ${res.status}`);
    }

    const data: CJShippingCostResponse = await res.json();
    if (data.code === 200 || data.code === 0) {
      return data.result;
    }
  } catch (error) {
    console.error("[CJ Server] Shipping calculation error:", error);
  }

  return null;
}

/**
 * Submit Order to CJ Dropshipping
 */
export async function createCJOrder(params: CJCreateOrderParams, apiKeyOrToken?: string) {
  const token = await getCJAccessToken(apiKeyOrToken);
  if (!token) {
    throw new Error("[CJ Server] Could not authenticate with CJ Dropshipping.");
  }

  try {
    const payload = {
      orderNumber: params.shopifyOrderId,
      shippingCustomerName: params.shippingAddress.customerName,
      shippingAddress: params.shippingAddress.address,
      shippingAddress2: params.shippingAddress.address2 || "",
      shippingCity: params.shippingAddress.city,
      shippingProvince: params.shippingAddress.province,
      shippingCountry: params.shippingAddress.country,
      shippingZip: params.shippingAddress.zip,
      shippingPhone: params.shippingAddress.phone || "0000000000",
      logisticName: params.logisticName || "CJ Packet Ordinary",
      products: params.items.map((item) => ({
        vid: item.vid,
        quantity: item.quantity,
      })),
    };

    const res = await fetch(`${CJ_API_BASE}/shopping/order/createOrder`, {
      method: "POST",
      headers: {
        "CJ-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`CJ Order Creation HTTP error ${res.status}`);
    }

    const data = await res.json();
    if (data.code === 200 || data.code === 0 || data.result) {
      return data.data || data.result;
    }

    throw new Error(data.message || "CJ Order creation failed");
  } catch (error) {
    console.error("[CJ Server] Create Order error:", error);
    throw error;
  }
}

/**
 * Fetch Raw Tracking Info for a CJ Order
 */
export async function getCJTrackingInfo(cjOrderId: string, apiKeyOrToken?: string) {
  const token = await getCJAccessToken(apiKeyOrToken);
  if (!token) return null;

  try {
    const url = new URL(`${CJ_API_BASE}/logistic/getTrackingInfo`);
    url.searchParams.set("orderId", cjOrderId);

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "CJ-Access-Token": token,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(`Tracking lookup HTTP error ${res.status}`);
    }

    const data = await res.json();
    if (data.code === 200 || data.code === 0) {
      return data.data || data.result;
    }

    console.error("[CJ Server] Error fetching tracking info:", data.message);
  } catch (error) {
    console.error(`[CJ Server] Tracking lookup error for order ${cjOrderId}:`, error);
  }

  return null;
}

/**
 * Fetch and normalize tracking information for a CJ Order
 */
export async function getCJTracking(cjOrderId: string, apiKeyOrToken?: string) {
  const raw = await getCJTrackingInfo(cjOrderId, apiKeyOrToken);
  if (!raw) return null;

  return {
    trackingNumber: raw.trackingNumber || raw.trackNumber || raw.logisticTrackNo || null,
    carrier: raw.carrier || raw.logisticName || raw.logisticCompany || "CJ Logistics",
    raw,
  };
}

// Casing alias
export const getCjTracking = getCJTracking;