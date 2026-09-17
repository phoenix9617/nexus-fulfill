import { useState, useEffect } from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useLoaderData,
  useFetcher,
  Form,
  useSubmit,
  useNavigate,
} from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  TextField,
  Button,
  BlockStack,
  InlineStack,
  Badge,
  Grid,
  Text,
  Select,
  Modal,
  Banner,
  Box,
  Divider,
  EmptyState,
} from "@shopify/polaris";
import {
  SearchIcon,
  ImportIcon,
  EditIcon,
} from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// --- Types ---
interface VariantOption {
  name: string;
  value: string;
}

interface ImportedVariant {
  variantId: string;
  name: string;
  options: VariantOption[];
  price: number;
  originalPrice: number;
  landedCost: number;
  sku: string;
  inventoryQuantity: number;
  shopifyVariantId?: string;
}

interface ImportedProduct {
  id: string;
  shopifyProductId: string;
  supplierProductId: string;
  title: string;
  category: string;
  supplier: string;
  retailPrice: number;
  originalRetailPrice: number;
  landedCost: number;
  sku: string;
  image: string;
  syncStatus: "synced" | "pending" | "error";
  lastSyncedAt: string;
  activeSurgePercentage: number;
  variants: ImportedVariant[];
}

interface EditableVariantState {
  variantId: string;
  shopifyVariantId?: string;
  name: string;
  sku: string;
  originalPrice: string;
  price: string;
  landedCost: string;
  inventoryQuantity: string;
}

// --- Helper Functions ---
async function syncProductToShopify(
  admin: any,
  shopifyProductId: string,
  variants: Array<{ shopifyVariantId?: string; price: number }>
) {
  if (!shopifyProductId || shopifyProductId.includes("Unlinked")) {
    return { success: false, reason: "Product is not linked to Shopify." };
  }

  const formattedProductId = shopifyProductId.startsWith("gid://shopify/Product/")
    ? shopifyProductId
    : `gid://shopify/Product/${shopifyProductId}`;

  let variantsToUpdate = variants
    .filter((v) => v.shopifyVariantId && Number.isFinite(v.price) && v.price >= 0)
    .map((v) => ({
      id: v.shopifyVariantId!.startsWith("gid://shopify/ProductVariant/")
        ? v.shopifyVariantId!
        : `gid://shopify/ProductVariant/${v.shopifyVariantId}`,
      price: Number(v.price).toFixed(2),
    }));

  try {
    if (variantsToUpdate.length === 0) {
      const liveRes = await admin.graphql(
        `#graphql
        query getLiveVariants($id: ID!) {
          product(id: $id) {
            variants(first: 50) {
              edges {
                node {
                  id
                  price
                }
              }
            }
          }
        }`,
        { variables: { id: formattedProductId } }
      );

      const liveData = await liveRes.json();

      if (liveData.errors?.length) {
        return {
          success: false,
          reason: liveData.errors[0]?.message || "Shopify query failed.",
        };
      }

      const liveEdges = liveData.data?.product?.variants?.edges || [];

      if (liveEdges.length === 0) {
        return { success: false, reason: "Could not locate variants on Shopify." };
      }

      variantsToUpdate = liveEdges.map((edge: any, idx: number) => {
        const targetPrice = variants[idx]?.price ?? parseFloat(edge.node.price || "0");
        return {
          id: edge.node.id,
          price: Number(targetPrice).toFixed(2),
        };
      });
    }

    const response = await admin.graphql(
      `#graphql
      mutation productVariantsBulkUpdate(
        $productId: ID!,
        $variants: [ProductVariantsBulkInput!]!
      ) {
        productVariantsBulkUpdate(
          productId: $productId,
          variants: $variants
        ) {
          productVariants {
            id
            price
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          productId: formattedProductId,
          variants: variantsToUpdate,
        },
      }
    );

    const resJson = await response.json();

    if (resJson.errors?.length) {
      return {
        success: false,
        reason: resJson.errors.map((e: any) => e.message).join(", "),
      };
    }

    const mutation = resJson.data?.productVariantsBulkUpdate;

    if (!mutation) {
      return { success: false, reason: "Shopify returned no mutation result." };
    }

    if (mutation.userErrors?.length) {
      return {
        success: false,
        reason: mutation.userErrors.map((e: any) => e.message).join(", "),
      };
    }

    // Verify the exact prices Shopify returned.
    for (const requested of variantsToUpdate) {
      const returned = (mutation.productVariants || []).find(
        (v: any) => v.id === requested.id
      );

      if (!returned) {
        return {
          success: false,
          reason: `Shopify did not return variant ${requested.id}.`,
        };
      }

      if (Math.abs(Number(returned.price) - Number(requested.price)) > 0.001) {
        return {
          success: false,
          reason: `Shopify returned $${returned.price} instead of $${requested.price}.`,
        };
      }
    }

    console.log("[Catalog Sync] Shopify price update verified:", {
      productId: formattedProductId,
      variants: variantsToUpdate,
    });

    return { success: true };
  } catch (error: any) {
    console.error("[Catalog Sync] Shopify mutation failed:", error);
    return { success: false, reason: error?.message || "Failed mutation." };
  }
}

async function ensureProductInDb(admin: any, session: any, productId: string) {
  const fullGid = productId.startsWith("gid://shopify/Product/")
    ? productId
    : `gid://shopify/Product/${productId}`;
  const cleanId = productId.replace("gid://shopify/Product/", "");

  let product = await db.importedProduct.findFirst({
    where: {
      shop: session.shop,
      OR: [
        { shopifyProductId: fullGid },
        { shopifyProductId: cleanId },
        { id: productId },
      ],
    },
    include: { variants: true },
  });

  if (!product) {
    const gqRes = await admin.graphql(
      `#graphql
      query getProduct($id: ID!) {
        product(id: $id) {
          id
          title
          productType
          vendor
          featuredImage { url }
          variants(first: 50) {
            edges {
              node {
                id
                title
                price
                sku
                inventoryQuantity
              }
            }
          }
        }
      }`,
      { variables: { id: fullGid } }
    );
    const gqData = await gqRes.json();
    const pNode = gqData.data?.product;

    if (pNode) {
      const firstVariant = pNode.variants?.edges[0]?.node;
      const initPrice = parseFloat(firstVariant?.price || "0");

      product = await db.importedProduct.create({
        data: {
          shop: session.shop,
          shopifyProductId: pNode.id,
          supplierProductId: pNode.id,
          title: pNode.title,
          category: pNode.productType || "General Store",
          vendor: pNode.vendor || "Store Catalog",
          retailPrice: initPrice,
          landedCost: Number((initPrice * 0.65).toFixed(2)),
          sku: firstVariant?.sku || "SKU-NOT-SET",
          image: pNode.featuredImage?.url || "",
          syncStatus: "synced",
          activeSurgePercentage: 0,
          variants: {
            create: (pNode.variants?.edges || []).map((vEdge: any) => {
              const vp = parseFloat(vEdge.node.price || "0");
              return {
                shopifyVariantId: vEdge.node.id,
                title: vEdge.node.title,
                price: vp,
                originalPrice: vp,
                landedCost: Number((vp * 0.65).toFixed(2)),
                sku: vEdge.node.sku || "VAR-SKU",
                stockQuantity: vEdge.node.inventoryQuantity || 0,
              };
            }),
          },
        },
        include: { variants: true },
      });
    }
  }

  if (product && product.shopifyProductId !== fullGid) {
    await db.importedProduct.update({
      where: { id: product.id },
      data: { shopifyProductId: fullGid },
    });
    product.shopifyProductId = fullGid;
  }

  return product;
}

// --- Loader ---
export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const searchQuery = url.searchParams.get("query") || "";
  let importedProducts: ImportedProduct[] = [];

  try {
    const dbRecords = await db.importedProduct.findMany({
      include: { variants: true },
      orderBy: { updatedAt: "desc" },
    });

    const shopifyResponse = await admin.graphql(
      `#graphql
      query getStoreProducts {
        products(first: 250, sortKey: TITLE) {
          edges {
            node {
              id
              title
              productType
              vendor
              featuredImage { url }
              variants(first: 50) {
                edges {
                  node {
                    id
                    title
                    price
                    sku
                    inventoryQuantity
                  }
                }
              }
            }
          }
        }
      }`
    );

    const resJson = await shopifyResponse.json();
    const shopifyProducts = resJson.data?.products?.edges || [];

    const shopifyMap = new Map();
    for (const edge of shopifyProducts) {
      const node = edge.node;
      shopifyMap.set(node.id, node);
      const rawId = node.id.replace("gid://shopify/Product/", "");
      shopifyMap.set(rawId, node);
    }

    const processedShopifyIds = new Set<string>();

    for (const record of dbRecords) {
      const fullGid = record.shopifyProductId?.startsWith("gid://shopify/Product/")
        ? record.shopifyProductId
        : record.shopifyProductId
        ? `gid://shopify/Product/${record.shopifyProductId}`
        : "";

      if (fullGid) processedShopifyIds.add(fullGid);
      if (record.shopifyProductId) processedShopifyIds.add(record.shopifyProductId);

      const shopifyMatch =
        shopifyMap.get(record.shopifyProductId) || shopifyMap.get(fullGid);
      const activeSurge = record.activeSurgePercentage || 0;
      const currentRetail = record.retailPrice || 0;
      const firstVariant = record.variants?.[0];

      let originalRetail =
        firstVariant?.originalPrice && firstVariant.originalPrice > 0
          ? firstVariant.originalPrice
          : currentRetail;

      if (activeSurge > 0 && originalRetail === currentRetail) {
        originalRetail = Number(
          (currentRetail / (1 + activeSurge / 100)).toFixed(2)
        );
      }

      const mappedVariants: ImportedVariant[] = (record.variants || []).map(
        (v) => ({
          variantId: v.id,
          name: v.title,
          options: [{ name: "Variant", value: v.title }],
          price: v.price,
          originalPrice:
            v.originalPrice && v.originalPrice > 0 ? v.originalPrice : v.price,
          landedCost: v.landedCost || 0,
          sku: v.sku || "VAR-SKU",
          inventoryQuantity: v.stockQuantity || 0,
          shopifyVariantId: v.shopifyVariantId || undefined,
        })
      );

      importedProducts.push({
        id: fullGid || record.id,
        shopifyProductId: fullGid || "Unlinked",
        supplierProductId: record.id,
        title: record.title || shopifyMatch?.title || "Untitled Product",
        category:
          record.category || shopifyMatch?.productType || "General Store",
        supplier: record.vendor || shopifyMatch?.vendor || "Supplier Catalog",
        retailPrice: currentRetail,
        originalRetailPrice: originalRetail,
        landedCost: record.landedCost || 0,
        sku: mappedVariants[0]?.sku || record.sku || "SKU-NOT-SET",
        image:
          record.image ||
          shopifyMatch?.featuredImage?.url ||
          "https://images.unsplash.com/photo-1591799264318-7e6ef8ddb7ea?auto=format&fit=crop&w=600&q=80",
        syncStatus:
          (record.syncStatus as "synced" | "pending" | "error") || "synced",
        lastSyncedAt: record.updatedAt
          ? new Date(record.updatedAt).toISOString().split("T")[0]
          : "Not Synced",
        activeSurgePercentage: activeSurge,
        variants: mappedVariants,
      });
    }

    for (const edge of shopifyProducts) {
      const pNode = edge.node;
      const rawId = pNode.id.replace("gid://shopify/Product/", "");

      if (!processedShopifyIds.has(pNode.id) && !processedShopifyIds.has(rawId)) {
        const firstVariant = pNode.variants?.edges[0]?.node;
        const price = parseFloat(firstVariant?.price || "0");

        importedProducts.push({
          id: pNode.id,
          shopifyProductId: pNode.id,
          supplierProductId: pNode.id,
          title: pNode.title,
          category: pNode.productType || "General Store",
          supplier: pNode.vendor || "Store Catalog",
          retailPrice: price,
          originalRetailPrice: price,
          landedCost: Number((price * 0.65).toFixed(2)),
          sku: firstVariant?.sku || "SKU-NOT-SET",
          image:
            pNode.featuredImage?.url ||
            "https://images.unsplash.com/photo-1591799264318-7e6ef8ddb7ea?auto=format&fit=crop&w=600&q=80",
          syncStatus: "synced",
          lastSyncedAt: "Live Store",
          activeSurgePercentage: 0,
          variants: (pNode.variants?.edges || []).map((vEdge: any) => ({
            variantId: vEdge.node.id,
            name: vEdge.node.title,
            options: [{ name: "Variant", value: vEdge.node.title }],
            price: parseFloat(vEdge.node.price || "0"),
            originalPrice: parseFloat(vEdge.node.price || "0"),
            landedCost: Number(
              (parseFloat(vEdge.node.price || "0") * 0.65).toFixed(2)
            ),
            sku: vEdge.node.sku || "VAR-SKU",
            inventoryQuantity: vEdge.node.inventoryQuantity || 0,
            shopifyVariantId: vEdge.node.id,
          })),
        });
      }
    }
  } catch (e) {
    console.error("Failed to fetch products from Shopify/DB:", e);
  }

  if (searchQuery.trim().length > 0) {
    const q = searchQuery.toLowerCase();
    importedProducts = importedProducts.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        p.supplier.toLowerCase().includes(q)
    );
  }

  return json({
    importedProducts,
    query: searchQuery,
  });
}

// --- Action ---
export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "forceSurge") {
    const productId = formData.get("productId") as string;
    const surgePercentage = Number(formData.get("surgePercentage"));

    if (!productId) {
      return json({ success: false, error: "Missing product ID." }, { status: 400 });
    }

    if (!Number.isFinite(surgePercentage) || surgePercentage <= 0 || surgePercentage > 1000) {
      return json(
        { success: false, error: "Surge percentage must be between 0.01% and 1000%." },
        { status: 400 }
      );
    }

    try {
      const product = await ensureProductInDb(admin, session, productId);

      if (!product) {
        return json({ success: false, error: "Product not found." }, { status: 400 });
      }

      const multiplier = 1 + surgePercentage / 100;
      const updatedVariantsData: Array<{
        shopifyVariantId?: string;
        price: number;
      }> = [];

      let newProductPrice = 0;

      // Calculate the target state WITHOUT changing the DB.
      for (const v of product.variants) {
        const baseVarPrice =
          v.originalPrice && v.originalPrice > 0
            ? Number(v.originalPrice)
            : Number(v.price);

        if (!Number.isFinite(baseVarPrice) || baseVarPrice <= 0) {
          return json(
            { success: false, error: `Invalid base price for variant ${v.title || v.id}.` },
            { status: 400 }
          );
        }

        const newVarPrice = Number((baseVarPrice * multiplier).toFixed(2));

        if (newProductPrice === 0) {
          newProductPrice = newVarPrice;
        }

        updatedVariantsData.push({
          shopifyVariantId: v.shopifyVariantId || undefined,
          price: newVarPrice,
        });
      }

      if (updatedVariantsData.length === 0) {
        return json(
          { success: false, error: "Product has no variants to surge." },
          { status: 400 }
        );
      }

      // IMPORTANT: Shopify first.
      // The old code wrote the surged prices to the DB first. If another
      // catalog-sync process sees that DB state, it can race with Shopify
      // and overwrite the price. Shopify must succeed before DB is changed.
      console.log("[Price Surge] Applying to Shopify FIRST:", {
        shop: session.shop,
        productId: product.shopifyProductId,
        surgePercentage,
        variants: updatedVariantsData,
      });

      const syncRes = await syncProductToShopify(
        admin,
        product.shopifyProductId,
        updatedVariantsData
      );

      if (!syncRes.success) {
        return json(
          { success: false, error: `Shopify Sync Failed: ${syncRes.reason}` },
          { status: 400 }
        );
      }

      // Only now persist the same prices that Shopify confirmed.
      for (let i = 0; i < product.variants.length; i++) {
        const v = product.variants[i];
        const target = updatedVariantsData[i];

        const baseVarPrice =
          v.originalPrice && v.originalPrice > 0
            ? Number(v.originalPrice)
            : Number(v.price);

        await db.importedVariant.update({
          where: { id: v.id },
          data: {
            price: target.price,
            // Never replace the base price with the surged price.
            originalPrice: baseVarPrice,
          },
        });
      }

      await db.importedProduct.update({
        where: { id: product.id },
        data: {
          retailPrice: newProductPrice || product.retailPrice,
          activeSurgePercentage: surgePercentage,
          syncStatus: "synced",
        },
      });

      console.log("[Price Surge] DB state saved AFTER Shopify confirmation.");
    } catch (error: any) {
      console.error("[Price Surge] Failed:", error);

      return json(
        { success: false, error: error?.message || "Failed surge." },
        { status: 500 }
      );
    }

    return json({
      success: true,
      surgedProductId: productId,
      surgePercentage,
      actionType: "applied",
    });
  }

  if (intent === "removeSurge") {
    const productId = formData.get("productId") as string;

    if (!productId) {
      return json({ success: false, error: "Missing product ID." }, { status: 400 });
    }

    try {
      const product = await ensureProductInDb(admin, session, productId);

      if (product) {
        const resetVariantsData: Array<{
          shopifyVariantId?: string;
          price: number;
        }> = [];

        let resetProductPrice = 0;

        for (const v of product.variants) {
          const baseVarPrice =
            v.originalPrice && v.originalPrice > 0
              ? Number(v.originalPrice)
              : Number(v.price);

          if (!Number.isFinite(baseVarPrice) || baseVarPrice < 0) {
            return json(
              { success: false, error: `Invalid original price for variant ${v.title || v.id}.` },
              { status: 400 }
            );
          }

          if (resetProductPrice === 0) {
            resetProductPrice = baseVarPrice;
          }

          resetVariantsData.push({
            shopifyVariantId: v.shopifyVariantId || undefined,
            price: baseVarPrice,
          });
        }

        // Shopify first, then DB.
        const syncRes = await syncProductToShopify(
          admin,
          product.shopifyProductId,
          resetVariantsData
        );

        if (!syncRes.success) {
          return json(
            { success: false, error: `Reset Failed: ${syncRes.reason}` },
            { status: 400 }
          );
        }

        for (let i = 0; i < product.variants.length; i++) {
          const v = product.variants[i];
          const target = resetVariantsData[i];

          await db.importedVariant.update({
            where: { id: v.id },
            data: {
              price: target.price,
              originalPrice: target.price,
            },
          });
        }

        await db.importedProduct.update({
          where: { id: product.id },
          data: {
            retailPrice: resetProductPrice || product.retailPrice,
            activeSurgePercentage: 0,
            syncStatus: "synced",
          },
        });
      }
    } catch (error: any) {
      console.error("[Price Surge Reset] Failed:", error);

      return json(
        { success: false, error: error?.message || "Failed reset." },
        { status: 500 }
      );
    }

    return json({
      success: true,
      surgedProductId: productId,
      surgePercentage: 0,
      actionType: "removed",
    });
  }

  if (intent === "updateProduct") {
    const productId = formData.get("productId") as string;
    const title = formData.get("title") as string;
    const category = formData.get("category") as string;
    const variantsRaw = formData.get("variants") as string;

    let variantsData: any[];

    try {
      variantsData = JSON.parse(variantsRaw || "[]");
    } catch {
      return json({ success: false, error: "Invalid variants data." }, { status: 400 });
    }

    if (!Array.isArray(variantsData)) {
      return json({ success: false, error: "Variants must be an array." }, { status: 400 });
    }

    try {
      const product = await ensureProductInDb(admin, session, productId);

      if (product) {
        const primaryVar = variantsData[0];
        const primaryPrice =
          primaryVar && Number.isFinite(Number(primaryVar.price))
            ? Number(primaryVar.price)
            : product.retailPrice;

        const normalizedVariants = variantsData.map((v: any) => ({
          ...v,
          price: Number(v.price),
          originalPrice: Number(v.originalPrice),
          landedCost: Number(v.landedCost),
          inventoryQuantity: Number(v.inventoryQuantity),
        }));

        for (const v of normalizedVariants) {
          if (
            !Number.isFinite(v.price) ||
            v.price < 0 ||
            !Number.isFinite(v.originalPrice) ||
            v.originalPrice < 0
          ) {
            return json(
              { success: false, error: "All variant prices must be valid numbers." },
              { status: 400 }
            );
          }
        }

        // Shopify first. Do not let a failed Shopify update leave the DB
        // claiming that the catalog was successfully updated.
        if (product.shopifyProductId) {
          const syncRes = await syncProductToShopify(
            admin,
            product.shopifyProductId,
            normalizedVariants.map((v: any) => ({
              shopifyVariantId: v.shopifyVariantId,
              price: v.price,
            }))
          );

          if (!syncRes.success) {
            return json(
              { success: false, error: `Shopify Sync Failed: ${syncRes.reason}` },
              { status: 400 }
            );
          }
        }

        await db.importedProduct.update({
          where: { id: product.id },
          data: {
            title,
            category,
            retailPrice: primaryPrice,
            syncStatus: "synced",
          },
        });

        for (const v of normalizedVariants) {
          await db.importedVariant.update({
            where: { id: v.variantId },
            data: {
              title: v.name,
              sku: v.sku,
              originalPrice: v.originalPrice,
              price: v.price,
              landedCost: v.landedCost,
              stockQuantity: v.inventoryQuantity,
            },
          });
        }
      }
    } catch (error: any) {
      console.error("[Product Update] Failed:", error);

      return json(
        { success: false, error: error?.message || "Failed update." },
        { status: 500 }
      );
    }

    return json({
      success: true,
      updatedProductId: productId,
      actionType: "edited",
    });
  }

  return json({ success: true });
}

// --- Component ---
export default function ImportedProductsPage() {
  const { importedProducts, query } = useLoaderData<typeof loader>();
  const surgeFetcher = useFetcher<typeof action>();
  const editFetcher = useFetcher<typeof action>();
  const submit = useSubmit();
  const navigate = useNavigate();

  const [productsList, setProductsList] = useState<ImportedProduct[]>(importedProducts);
  const [searchValue, setSearchValue] = useState(query);
  const [sortOption, setSortOption] = useState("retail-desc");
  const [customSurges, setCustomSurges] = useState<{ [productId: string]: string }>({});

  const [activeModal, setActiveModal] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<ImportedProduct | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editVariants, setEditVariants] = useState<EditableVariantState[]>([]);

  useEffect(() => {
    setProductsList(importedProducts);
  }, [importedProducts]);

  useEffect(() => {
    if (surgeFetcher.state === "idle" && surgeFetcher.data) {
      navigate(".", { replace: true });
    }
  }, [surgeFetcher.state, surgeFetcher.data, navigate]);

  const isSaving =
    editFetcher.state === "submitting" || surgeFetcher.state === "submitting";

  const handleOpenManageModal = (product: ImportedProduct) => {
    setSelectedProduct(product);
    setEditTitle(product.title);
    setEditCategory(product.category);
    setEditVariants(
      product.variants.map((v) => ({
        variantId: v.variantId,
        shopifyVariantId: v.shopifyVariantId,
        name: v.name,
        sku: v.sku || "",
        originalPrice: String(v.originalPrice ?? v.price ?? 0),
        price: String(v.price ?? 0),
        landedCost: String(v.landedCost ?? 0),
        inventoryQuantity: String(v.inventoryQuantity ?? 0),
      }))
    );
    setActiveModal(true);
  };

  const handleUpdateVariantField = (
    index: number,
    field: keyof EditableVariantState,
    value: string
  ) => {
    setEditVariants((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const handleSaveChanges = () => {
    if (!selectedProduct) return;

    const parsedVariants = editVariants.map((v) => ({
      variantId: v.variantId,
      shopifyVariantId: v.shopifyVariantId,
      name: v.name,
      sku: v.sku,
      originalPrice: parseFloat(v.originalPrice) || 0,
      price: parseFloat(v.price) || 0,
      landedCost: parseFloat(v.landedCost) || 0,
      inventoryQuantity: parseInt(v.inventoryQuantity, 10) || 0,
    }));

    editFetcher.submit(
      {
        intent: "updateProduct",
        productId: selectedProduct.id,
        title: editTitle,
        category: editCategory,
        variants: JSON.stringify(parsedVariants),
      },
      { method: "POST" }
    );
    setActiveModal(false);
  };

  const handleApplyForceSurge = (productId: string, percentage: number) => {
    if (isNaN(percentage) || percentage <= 0) return;

    const rawId = productId.replace("gid://shopify/Product/", "");
    const fullGid = productId.startsWith("gid://shopify/Product/")
      ? productId
      : `gid://shopify/Product/${productId}`;

    setProductsList((prevProducts) =>
      prevProducts.map((p) => {
        const match =
          p.id === productId ||
          p.id === fullGid ||
          p.id === rawId ||
          p.shopifyProductId === productId ||
          p.shopifyProductId === fullGid ||
          p.shopifyProductId === rawId;

        if (!match) return p;

        const basePrice =
          p.originalRetailPrice && p.originalRetailPrice > 0
            ? p.originalRetailPrice
            : p.retailPrice;

        const multiplier = 1 + percentage / 100;
        const newRetail = Number((basePrice * multiplier).toFixed(2));

        const updatedVariants = p.variants.map((v) => {
          const baseVarPrice =
            v.originalPrice && v.originalPrice > 0 ? v.originalPrice : v.price;
          return {
            ...v,
            originalPrice: baseVarPrice,
            price: Number((baseVarPrice * multiplier).toFixed(2)),
          };
        });

        return {
          ...p,
          retailPrice: newRetail,
          originalRetailPrice: basePrice,
          variants: updatedVariants,
          syncStatus: "pending",
          activeSurgePercentage: percentage,
        };
      })
    );

    surgeFetcher.submit(
      {
        intent: "forceSurge",
        productId: fullGid,
        surgePercentage: percentage.toString(),
      },
      { method: "POST" }
    );
  };

  const handleRemoveSurge = (productId: string) => {
    const rawId = productId.replace("gid://shopify/Product/", "");
    const fullGid = productId.startsWith("gid://shopify/Product/")
      ? productId
      : `gid://shopify/Product/${productId}`;

    setProductsList((prevProducts) =>
      prevProducts.map((p) => {
        const match =
          p.id === productId ||
          p.id === fullGid ||
          p.id === rawId ||
          p.shopifyProductId === productId ||
          p.shopifyProductId === fullGid ||
          p.shopifyProductId === rawId;

        if (!match) return p;

        const basePrice = p.originalRetailPrice || p.retailPrice;
        const resetVariants = p.variants.map((v) => ({
          ...v,
          price: v.originalPrice || v.price,
        }));

        return {
          ...p,
          retailPrice: basePrice,
          variants: resetVariants,
          syncStatus: "pending",
          activeSurgePercentage: 0,
        };
      })
    );

    setCustomSurges((prev) => ({ ...prev, [productId]: "" }));

    surgeFetcher.submit(
      {
        intent: "removeSurge",
        productId: fullGid,
      },
      { method: "POST" }
    );
  };

  const sortedProducts = [...productsList].sort((a, b) => {
    switch (sortOption) {
      case "retail-desc":
        return b.retailPrice - a.retailPrice;
      case "retail-asc":
        return a.retailPrice - b.retailPrice;
      case "margin-desc": {
        const profitA = a.retailPrice - a.landedCost;
        const profitB = b.retailPrice - b.landedCost;
        return profitB - profitA;
      }
      case "stock-desc": {
        const totalStockA = a.variants.reduce(
          (acc, v) => acc + (v.inventoryQuantity || 0),
          0
        );
        const totalStockB = b.variants.reduce(
          (acc, v) => acc + (v.inventoryQuantity || 0),
          0
        );
        return totalStockB - totalStockA;
      }
      default:
        return 0;
    }
  });

  return (
    <Page
      title="Store Catalog & Imported Products"
      subtitle="Edit products, surge prices, and manage catalog items synchronized with your Shopify store."
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {/* Search Bar */}
            <Card>
              <Form method="get" onSubmit={(e) => submit(e.currentTarget)}>
                <InlineStack gap="300" align="space-between">
                  <div style={{ flexGrow: 1 }}>
                    <TextField
                      name="query"
                      label="Search Inventory"
                      labelHidden
                      placeholder="Filter by title, SKU, category..."
                      value={searchValue}
                      onChange={setSearchValue}
                      prefix={<SearchIcon />}
                      clearButton
                      onClearButtonClick={() => setSearchValue("")}
                      autoComplete="off"
                    />
                  </div>
                  <Button submit variant="primary">
                    Filter Catalog
                  </Button>
                  <Select
                    label="Sort By"
                    labelHidden
                    options={[
                      { label: "Price: High to Low", value: "retail-desc" },
                      { label: "Price: Low to High", value: "retail-asc" },
                      { label: "Highest Profit ($ / item)", value: "margin-desc" },
                      { label: "Highest In Stock", value: "stock-desc" },
                    ]}
                    value={sortOption}
                    onChange={setSortOption}
                  />
                </InlineStack>
              </Form>
            </Card>

            {/* Error Banners */}
            {surgeFetcher.data && !surgeFetcher.data.success && (
              <Banner tone="critical" title="Surge Execution Error">
                <p>{(surgeFetcher.data as any).error || "Failed to surge price on Shopify."}</p>
              </Banner>
            )}
            {editFetcher.data && !editFetcher.data.success && (
              <Banner tone="critical" title="Update Error">
                <p>{(editFetcher.data as any).error || "Failed to update product."}</p>
              </Banner>
            )}

            {/* Success Banners */}
            {surgeFetcher.data?.success && surgeFetcher.data.actionType === "applied" && (
              <Banner tone="warning" title="Price Surge Applied">
                <p>{`Applied +${surgeFetcher.data.surgePercentage}% price surge to product and synced to Shopify.`}</p>
              </Banner>
            )}
            {surgeFetcher.data?.success && surgeFetcher.data.actionType === "removed" && (
              <Banner tone="info" title="Price Surge Reset">
                <p>Restored product to original catalog price.</p>
              </Banner>
            )}

            {/* Product Grid */}
            {sortedProducts.length === 0 ? (
              <Card>
                <EmptyState
                  heading="No store products found"
                  action={{
                    content: "Import Products Now",
                    icon: ImportIcon,
                    onAction: () => navigate("/app/sourcing-and-import"),
                  }}
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>No inventory items match your current filter.</p>
                </EmptyState>
              </Card>
            ) : (
              <Grid>
                {sortedProducts.map((product) => {
                  const currentCustomVal = customSurges[product.id] || "";
                  const hasActiveSurge = Boolean(
                    product.activeSurgePercentage && product.activeSurgePercentage > 0
                  );

                  return (
                    <Grid.Cell
                      key={product.id}
                      columnSpan={{ xs: 6, sm: 6, md: 4, lg: 3, xl: 3 }}
                    >
                      <Card padding="0">
                        <BlockStack gap="0">
                          {/* Image Box */}
                          <div
                            style={{
                              position: "relative",
                              width: "100%",
                              height: "190px",
                              backgroundColor: "#1e1e1e",
                              overflow: "hidden",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            <img
                              src={product.image}
                              alt={product.title}
                              style={{ width: "100%", height: "100%", objectFit: "cover" }}
                            />
                            <div
                              style={{
                                position: "absolute",
                                top: "10px",
                                right: "10px",
                                display: "flex",
                                flexDirection: "column",
                                gap: "4px",
                                alignItems: "flex-end",
                              }}
                            >
                              <Badge tone={product.syncStatus === "synced" ? "success" : "attention"}>
                                {product.syncStatus.toUpperCase()}
                              </Badge>
                              {hasActiveSurge && (
                                <Badge tone="warning">
                                  {`+${product.activeSurgePercentage}% SURGE`}
                                </Badge>
                              )}
                            </div>
                          </div>

                          {/* Card Content */}
                          <Box padding="400">
                            <BlockStack gap="300">
                              <BlockStack gap="100">
                                <Text variant="bodyMd" fontWeight="bold" as="h3" truncate>
                                  {product.title}
                                </Text>
                                <Text variant="bodyXs" tone="subdued" as="p">
                                  {product.category} • SKU: {product.sku}
                                </Text>
                              </BlockStack>
                              <Divider />
                              <InlineStack align="space-between" blockAlign="center">
                                <BlockStack gap="050">
                                  <Text variant="bodyXs" tone="subdued" as="span">Retail Price:</Text>
                                  <Text variant="bodyMd" fontWeight="bold" as="span">
                                    ${product.retailPrice.toFixed(2)}
                                  </Text>
                                </BlockStack>
                                <BlockStack gap="050">
                                  <Text variant="bodyXs" tone="subdued" as="span">Landed Cost:</Text>
                                  <Text variant="bodyMd" tone="subdued" as="span">
                                    ${product.landedCost.toFixed(2)}
                                  </Text>
                                </BlockStack>
                              </InlineStack>

                              <Divider />

                              {/* Surge Buttons */}
                              <BlockStack gap="150">
                                <Text variant="bodyXs" fontWeight="bold" as="span">
                                  Price Surge Controls
                                </Text>
                                <InlineStack gap="100">
                                  <Button size="micro" onClick={() => handleApplyForceSurge(product.id, 10)}>
                                    +10%
                                  </Button>
                                  <Button size="micro" onClick={() => handleApplyForceSurge(product.id, 20)}>
                                    +20%
                                  </Button>
                                  <Button size="micro" onClick={() => handleApplyForceSurge(product.id, 30)}>
                                    +30%
                                  </Button>
                                </InlineStack>
                                <InlineStack gap="200" blockAlign="center">
                                  <div style={{ flexGrow: 1 }}>
                                    <TextField
                                      label=""
                                      labelHidden
                                      type="number"
                                      placeholder="Custom %"
                                      value={currentCustomVal}
                                      onChange={(val) =>
                                        setCustomSurges((prev) => ({ ...prev, [product.id]: val }))
                                      }
                                      autoComplete="off"
                                    />
                                  </div>
                                  <Button
                                    size="micro"
                                    variant="secondary"
                                    onClick={() =>
                                      handleApplyForceSurge(product.id, parseFloat(currentCustomVal))
                                    }
                                  >
                                    Apply
                                  </Button>
                                  {hasActiveSurge && (
                                    <Button
                                      size="micro"
                                      tone="critical"
                                      variant="plain"
                                      onClick={() => handleRemoveSurge(product.id)}
                                    >
                                      Reset
                                    </Button>
                                  )}
                                </InlineStack>
                              </BlockStack>

                              <Button icon={EditIcon} onClick={() => handleOpenManageModal(product)}>
                                Edit Details
                              </Button>
                            </BlockStack>
                          </Box>
                        </BlockStack>
                      </Card>
                    </Grid.Cell>
                  );
                })}
              </Grid>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>

      {/* Edit Modal */}
      {selectedProduct && (
        <Modal
          open={activeModal}
          onClose={() => setActiveModal(false)}
          title={`Edit Product - ${selectedProduct.title}`}
          primaryAction={{
            content: "Save & Push to Shopify",
            onAction: handleSaveChanges,
            loading: isSaving,
          }}
          secondaryActions={[
            {
              content: "Cancel",
              onAction: () => setActiveModal(false),
            },
          ]}
        >
          <Modal.Section>
            <BlockStack gap="400">
              <TextField label="Product Title" value={editTitle} onChange={setEditTitle} autoComplete="off" />
              <TextField label="Category" value={editCategory} onChange={setEditCategory} autoComplete="off" />
              <Divider />
              <Text variant="headingSm" as="h4">Variants & Inventory</Text>
              {editVariants.map((variant, idx) => (
                <Box key={variant.variantId || idx} padding="300" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="300">
                    <Text variant="bodyMd" fontWeight="bold" as="p">Variant {idx + 1}: {variant.name}</Text>
                    <Grid>
                      <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 3, xl: 3 }}>
                        <TextField label="SKU" value={variant.sku} onChange={(v) => handleUpdateVariantField(idx, "sku", v)} autoComplete="off" />
                      </Grid.Cell>
                      <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 3, xl: 3 }}>
                        <TextField label="Retail Price ($)" type="number" value={variant.price} onChange={(v) => handleUpdateVariantField(idx, "price", v)} autoComplete="off" />
                      </Grid.Cell>
                      <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 3, xl: 3 }}>
                        <TextField label="Landed Cost ($)" type="number" value={variant.landedCost} onChange={(v) => handleUpdateVariantField(idx, "landedCost", v)} autoComplete="off" />
                      </Grid.Cell>
                      <Grid.Cell columnSpan={{ xs: 6, sm: 3, md: 3, lg: 3, xl: 3 }}>
                        <TextField label="Stock Quantity" type="number" value={variant.inventoryQuantity} onChange={(v) => handleUpdateVariantField(idx, "inventoryQuantity", v)} autoComplete="off" />
                      </Grid.Cell>
                    </Grid>
                  </BlockStack>
                </Box>
              ))}
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}