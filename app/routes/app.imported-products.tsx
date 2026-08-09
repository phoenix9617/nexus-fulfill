import { useState, useEffect } from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, Form, useSubmit, useNavigate } from "@remix-run/react";
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
  Checkbox,
  EmptyState,
} from "@shopify/polaris";
import {
  SearchIcon,
  RefreshIcon,
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

// --- Helper Functions ---

async function syncProductToShopify(
  admin: any,
  shopifyProductId: string,
  variants: Array<{ shopifyVariantId?: string; price: number }>
) {
  if (!shopifyProductId || shopifyProductId.includes("Unlinked")) {
    return { success: false, reason: "Unlinked product" };
  }

  const variantsToUpdate = variants
    .filter((v) => v.shopifyVariantId)
    .map((v) => ({
      id: v.shopifyVariantId as string,
      price: v.price.toFixed(2),
    }));

  if (variantsToUpdate.length === 0) {
    return { success: false, reason: "No Shopify variant IDs found" };
  }

  try {
    const response = await admin.graphql(
      `#graphql
      mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
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
          productId: shopifyProductId,
          variants: variantsToUpdate,
        },
      }
    );

    const resJson = await response.json();
    const userErrors = resJson.data?.productVariantsBulkUpdate?.userErrors || [];
    if (userErrors.length > 0) {
      console.error("Shopify GraphQL errors updating variants:", userErrors);
      return { success: false, errors: userErrors };
    }
    return { success: true };
  } catch (error) {
    console.error("Failed to execute Shopify GraphQL mutation:", error);
    return { success: false, error };
  }
}

// --- Loader ---

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const searchQuery = url.searchParams.get("query") || "";

  let importedProducts: ImportedProduct[] = [];

  try {
    // 1. Fetch DB records first so app-imported products are never missed
    const shopDomain = session.shop.split(".")[0];
    const dbRecords = await db.importedProduct.findMany({
      where: {
        OR: [
          { shop: session.shop },
          { shop: { contains: shopDomain } },
        ],
      },
      include: { variants: true },
      orderBy: { updatedAt: "desc" },
    });

    // 2. Query store items from Shopify GraphQL
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
              featuredImage {
                url
              }
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
    const shopifyMap = new Map(shopifyProducts.map((edge: any) => [edge.node.id, edge.node]));

    // 3. Process DB records first
    for (const record of dbRecords) {
      const shopifyMatch = record.shopifyProductId ? shopifyMap.get(record.shopifyProductId) : null;
      const activeSurge = record.activeSurgePercentage || 0;
      const currentRetail = record.retailPrice || 0;

      const firstVariant = record.variants?.[0];
      const originalRetail =
        firstVariant?.originalPrice && firstVariant.originalPrice > 0
          ? firstVariant.originalPrice
          : activeSurge > 0
          ? Number((currentRetail / (1 + activeSurge / 100)).toFixed(2))
          : currentRetail;

      const mappedVariants: ImportedVariant[] = (record.variants || []).map((v) => ({
        variantId: v.id,
        name: v.title,
        options: [{ name: "Variant", value: v.title }],
        price: v.price,
        originalPrice: v.originalPrice && v.originalPrice > 0 ? v.originalPrice : v.price,
        landedCost: v.landedCost || 0,
        sku: v.sku || "VAR-SKU",
        inventoryQuantity: v.stockQuantity || 0,
        shopifyVariantId: v.shopifyVariantId || undefined,
      }));

      importedProducts.push({
        id: record.id,
        shopifyProductId: record.shopifyProductId || "Unlinked",
        supplierProductId: record.id,
        title: record.title || shopifyMatch?.title || "Untitled Product",
        category: record.category || shopifyMatch?.productType || "General Hardware",
        supplier: record.vendor || shopifyMatch?.vendor || "Supplier Catalog",
        retailPrice: currentRetail,
        originalRetailPrice: originalRetail,
        landedCost: record.landedCost || 0,
        sku: mappedVariants[0]?.sku || record.sku || "SKU-NOT-SET",
        image:
          record.image ||
          shopifyMatch?.featuredImage?.url ||
          "https://images.unsplash.com/photo-1591799264318-7e6ef8ddb7ea?auto=format&fit=crop&w=600&q=80",
        syncStatus: (record.syncStatus as "synced" | "pending" | "error") || (record.shopifyProductId ? "synced" : "pending"),
        lastSyncedAt: record.updatedAt
          ? new Date(record.updatedAt).toISOString().split("T")[0]
          : "Not Synced",
        activeSurgePercentage: activeSurge,
        variants: mappedVariants,
      });
    }

    // 4. Auto-include native store products not yet saved to local DB
    for (const edge of shopifyProducts) {
      const pNode = edge.node;
      const existsInDb = dbRecords.some((r) => r.shopifyProductId === pNode.id);

      if (!existsInDb) {
        const firstVariant = pNode.variants?.edges[0]?.node;
        const price = parseFloat(firstVariant?.price || "0");

        importedProducts.push({
          id: pNode.id,
          shopifyProductId: pNode.id,
          supplierProductId: pNode.id,
          title: pNode.title,
          category: pNode.productType || "General Hardware",
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
            landedCost: Number((parseFloat(vEdge.node.price || "0") * 0.65).toFixed(2)),
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

  if (intent === "updateProduct") {
    const productId = formData.get("productId") as string;
    const title = formData.get("title") as string;
    const category = formData.get("category") as string;
    const variantsRaw = formData.get("variants") as string;
    const variantsData: Array<{
      variantId: string;
      name: string;
      sku: string;
      originalPrice: number;
      price: number;
      landedCost: number;
      inventoryQuantity: number;
    }> = JSON.parse(variantsRaw || "[]");

    try {
      const product = await db.importedProduct.findUnique({
        where: { id: productId },
        include: { variants: true },
      });

      if (product) {
        const primaryVar = variantsData[0];
        const primaryPrice = primaryVar ? primaryVar.price : product.retailPrice;
        const primaryLandedCost = primaryVar ? primaryVar.landedCost : product.landedCost;

        await db.importedProduct.update({
          where: { id: productId },
          data: {
            title,
            category,
            retailPrice: primaryPrice,
            landedCost: primaryLandedCost,
            syncStatus: "synced",
          },
        });

        for (const v of variantsData) {
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

        if (product.shopifyProductId && !product.shopifyProductId.includes("Unlinked")) {
          await admin.graphql(
            `#graphql
            mutation productUpdate($input: ProductInput!) {
              productUpdate(input: $input) {
                product { id title }
                userErrors { field message }
              }
            }`,
            {
              variables: {
                input: {
                  id: product.shopifyProductId,
                  title: title,
                  productType: category,
                },
              },
            }
          );

          const shopifyVariantsPayload = variantsData.map((v) => {
            const dbVar = product.variants.find((vDb) => vDb.id === v.variantId);
            return {
              shopifyVariantId: dbVar?.shopifyVariantId || undefined,
              price: v.price,
            };
          });

          await syncProductToShopify(admin, product.shopifyProductId, shopifyVariantsPayload);
        }
      }
    } catch (error) {
      console.error("Failed to update product details:", error);
      return json({ success: false, error: "Failed to update product." }, { status: 500 });
    }

    return json({ success: true, updatedProductId: productId, actionType: "edited" });
  }

  if (intent === "forceSurge") {
    const productId = formData.get("productId") as string;
    const surgePercentage = parseFloat(formData.get("surgePercentage") as string) || 0;

    try {
      const product = await db.importedProduct.findUnique({
        where: { id: productId },
        include: { variants: true },
      });

      if (product) {
        const multiplier = 1 + surgePercentage / 100;
        const updatedVariantsData: Array<{ shopifyVariantId?: string; price: number }> = [];
        let newProductPrice = 0;

        for (const v of product.variants) {
          const baseVarPrice = v.originalPrice && v.originalPrice > 0 ? v.originalPrice : v.price;
          const newVarPrice = Number((baseVarPrice * multiplier).toFixed(2));

          if (newProductPrice === 0) {
            newProductPrice = newVarPrice;
          }

          await db.importedVariant.update({
            where: { id: v.id },
            data: {
              price: newVarPrice,
              originalPrice: baseVarPrice,
            },
          });

          updatedVariantsData.push({
            shopifyVariantId: v.shopifyVariantId || undefined,
            price: newVarPrice,
          });
        }

        if (product.shopifyProductId) {
          await syncProductToShopify(admin, product.shopifyProductId, updatedVariantsData);
        }

        await db.importedProduct.update({
          where: { id: productId },
          data: {
            retailPrice: newProductPrice || product.retailPrice,
            activeSurgePercentage: surgePercentage,
            syncStatus: "synced",
          },
        });
      }
    } catch (error) {
      console.error("Failed to apply price surge in DB:", error);
      return json({ success: false, error: "Failed to apply surge." }, { status: 500 });
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

    try {
      const product = await db.importedProduct.findUnique({
        where: { id: productId },
        include: { variants: true },
      });

      if (product) {
        const resetVariantsData: Array<{ shopifyVariantId?: string; price: number }> = [];
        let resetProductPrice = 0;

        for (const v of product.variants) {
          const baseVarPrice = v.originalPrice && v.originalPrice > 0 ? v.originalPrice : v.price;

          if (resetProductPrice === 0) {
            resetProductPrice = baseVarPrice;
          }

          await db.importedVariant.update({
            where: { id: v.id },
            data: {
              price: baseVarPrice,
            },
          });

          resetVariantsData.push({
            shopifyVariantId: v.shopifyVariantId || undefined,
            price: baseVarPrice,
          });
        }

        if (product.shopifyProductId) {
          await syncProductToShopify(admin, product.shopifyProductId, resetVariantsData);
        }

        await db.importedProduct.update({
          where: { id: productId },
          data: {
            retailPrice: resetProductPrice || product.retailPrice,
            activeSurgePercentage: 0,
            syncStatus: "synced",
          },
        });
      }
    } catch (error) {
      console.error("Failed to remove surge in DB:", error);
      return json({ success: false, error: "Failed to reset surge." }, { status: 500 });
    }

    return json({
      success: true,
      surgedProductId: productId,
      surgePercentage: 0,
      actionType: "removed",
    });
  }

  if (intent === "syncProduct") {
    const productId = formData.get("productId") as string;

    try {
      const product = await db.importedProduct.findUnique({
        where: { id: productId },
        include: { variants: true },
      });

      if (product && product.shopifyProductId) {
        await syncProductToShopify(
          admin,
          product.shopifyProductId,
          product.variants.map((v) => ({
            shopifyVariantId: v.shopifyVariantId || undefined,
            price: v.price,
          }))
        );
      }

      await db.importedProduct.update({
        where: { id: productId },
        data: { syncStatus: "synced" },
      });
    } catch (error) {
      console.error("Failed to sync product in DB:", error);
      return json({ success: false, error: "Failed to sync product." }, { status: 500 });
    }

    return json({ success: true, syncedProductId: productId });
  }

  if (intent === "bulkSync") {
    const productIdsRaw = formData.get("productIds") as string;
    const productIds: string[] = JSON.parse(productIdsRaw || "[]");

    try {
      const whereClause =
        productIds.length > 0
          ? { id: { in: productIds } }
          : { shop: session.shop };

      const products = await db.importedProduct.findMany({
        where: whereClause,
        include: { variants: true },
      });

      for (const product of products) {
        if (product.shopifyProductId) {
          await syncProductToShopify(
            admin,
            product.shopifyProductId,
            product.variants.map((v) => ({
              shopifyVariantId: v.shopifyVariantId || undefined,
              price: v.price,
            }))
          );
        }
      }

      await db.importedProduct.updateMany({
        where: whereClause,
        data: { syncStatus: "synced" },
      });
    } catch (error) {
      console.error("Failed bulk sync in DB:", error);
      return json({ success: false, error: "Bulk sync failed." }, { status: 500 });
    }

    return json({ success: true, bulkSynced: true, count: productIds.length });
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
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [customSurges, setCustomSurges] = useState<{ [productId: string]: string }>({});

  // Editable Modal States
  const [activeModal, setActiveModal] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<ImportedProduct | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editVariants, setEditVariants] = useState<ImportedVariant[]>([]);

  useEffect(() => {
    setProductsList(importedProducts);
  }, [importedProducts]);

  const isSaving = editFetcher.state === "submitting" || surgeFetcher.state === "submitting";

  const handleOpenManageModal = (product: ImportedProduct) => {
    setSelectedProduct(product);
    setEditTitle(product.title);
    setEditCategory(product.category);
    setEditVariants(JSON.parse(JSON.stringify(product.variants)));
    setActiveModal(true);
  };

  const handleUpdateVariantField = (
    index: number,
    field: keyof ImportedVariant,
    value: any
  ) => {
    setEditVariants((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const handleSaveChanges = () => {
    if (!selectedProduct) return;

    editFetcher.submit(
      {
        intent: "updateProduct",
        productId: selectedProduct.id,
        title: editTitle,
        category: editCategory,
        variants: JSON.stringify(editVariants),
      },
      { method: "POST" }
    );

    setActiveModal(false);
  };

  const handleApplyForceSurge = (productId: string, percentage: number) => {
    if (isNaN(percentage) || percentage <= 0) return;

    setProductsList((prevProducts) =>
      prevProducts.map((p) => {
        if (p.id !== productId) return p;

        const basePrice = p.originalRetailPrice || p.retailPrice;
        const multiplier = 1 + percentage / 100;
        const newRetail = Number((basePrice * multiplier).toFixed(2));

        const updatedVariants = p.variants.map((v) => {
          const baseVarPrice = v.originalPrice || v.price;
          return {
            ...v,
            price: Number((baseVarPrice * multiplier).toFixed(2)),
          };
        });

        return {
          ...p,
          retailPrice: newRetail,
          variants: updatedVariants,
          syncStatus: "pending",
          activeSurgePercentage: percentage,
        };
      })
    );

    surgeFetcher.submit(
      {
        intent: "forceSurge",
        productId,
        surgePercentage: percentage.toString(),
      },
      { method: "POST" }
    );
  };

  const handleRemoveSurge = (productId: string) => {
    setProductsList((prevProducts) =>
      prevProducts.map((p) => {
        if (p.id !== productId) return p;

        const originalRetail = p.originalRetailPrice || p.retailPrice;

        const resetVariants = p.variants.map((v) => ({
          ...v,
          price: v.originalPrice || v.price,
        }));

        return {
          ...p,
          retailPrice: originalRetail,
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
        productId,
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
        const totalStockA = a.variants.reduce((acc, v) => acc + (v.inventoryQuantity || 0), 0);
        const totalStockB = b.variants.reduce((acc, v) => acc + (v.inventoryQuantity || 0), 0);
        return totalStockB - totalStockA;
      }
      default:
        return 0;
    }
  });

  const handleToggleSelectProduct = (id: string) => {
    setSelectedProductIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleSelectAll = () => {
    if (selectedProductIds.length === sortedProducts.length) {
      setSelectedProductIds([]);
    } else {
      setSelectedProductIds(sortedProducts.map((p) => p.id));
    }
  };

  const handleExecuteBulkSync = () => {
    editFetcher.submit(
      {
        intent: "bulkSync",
        productIds: JSON.stringify(selectedProductIds),
      },
      { method: "POST" }
    );
  };

  const handleSyncSingleProduct = (productId: string) => {
    editFetcher.submit(
      {
        intent: "syncProduct",
        productId,
      },
      { method: "POST" }
    );
  };

  const allSelected =
    sortedProducts.length > 0 && selectedProductIds.length === sortedProducts.length;

  return (
    <Page
      title="Store Catalog & Imported Products"
      subtitle="Edit products, surge prices, and manage catalog items synchronized with your Shopify store."
      primaryAction={
        sortedProducts.length > 0
          ? {
              content: "Re-sync All Stock",
              icon: RefreshIcon,
              onAction: handleExecuteBulkSync,
            }
          : undefined
      }
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {/* Search & Filter Bar */}
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

            {/* Notifications */}
            {editFetcher.data?.actionType === "edited" && (
              <Banner tone="success" title="Product Updated Successfully">
                <p>Product title, category, price, and inventory modifications were saved and pushed to Shopify.</p>
              </Banner>
            )}

            {surgeFetcher.data?.success && (
              <Banner
                tone={surgeFetcher.data.actionType === "removed" ? "info" : "warning"}
                title={
                  surgeFetcher.data.actionType === "removed"
                    ? "Price Surge Reset"
                    : "Price Surge Applied"
                }
              >
                <p>
                  {surgeFetcher.data.actionType === "removed"
                    ? "Price surge was reset back to original base price."
                    : `Applied +${surgeFetcher.data.surgePercentage}% price surge to product and synced to Shopify.`}
                </p>
              </Banner>
            )}

            {/* Bulk Actions Controls */}
            {sortedProducts.length > 0 && (
              <Card padding="300">
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="300" blockAlign="center">
                    <Checkbox
                      label={`Select All (${selectedProductIds.length}/${sortedProducts.length} Items)`}
                      checked={allSelected}
                      onChange={handleSelectAll}
                    />
                  </InlineStack>
                  <Button
                    variant="primary"
                    icon={RefreshIcon}
                    disabled={selectedProductIds.length === 0 || isSaving}
                    loading={isSaving}
                    onClick={handleExecuteBulkSync}
                  >
                    {`Re-sync Selected (${selectedProductIds.length})`}
                  </Button>
                </InlineStack>
              </Card>
            )}

            {/* Empty State */}
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
                  <p>
                    {searchValue
                      ? `No products matched your search "${searchValue}". Try clearing filters.`
                      : "No products were found in your Shopify store or imported database."}
                  </p>
                </EmptyState>
              </Card>
            ) : (
              /* Product Grid */
              <Grid>
                {sortedProducts.map((product) => {
                  const totalStock = product.variants.reduce(
                    (acc, v) => acc + (v.inventoryQuantity || 0),
                    0
                  );
                  const isSelected = selectedProductIds.includes(product.id);

                  // Calculated Profit Metrics
                  const unitProfit = product.retailPrice - product.landedCost;
                  const profitMargin =
                    product.retailPrice > 0
                      ? ((unitProfit / product.retailPrice) * 100).toFixed(1)
                      : "0.0";

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
                          {/* Image Container with Badges Overlay */}
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
                              borderTopLeftRadius: "8px",
                              borderTopRightRadius: "8px",
                            }}
                          >
                            <img
                              src={product.image}
                              alt={product.title}
                              style={{
                                width: "100%",
                                height: "100%",
                                objectFit: "cover",
                              }}
                            />

                            {/* Select Checkbox */}
                            <div
                              style={{
                                position: "absolute",
                                top: "10px",
                                left: "10px",
                                zIndex: 3,
                                background: "rgba(255, 255, 255, 0.9)",
                                borderRadius: "4px",
                                padding: "2px 6px",
                              }}
                            >
                              <Checkbox
                                label=""
                                labelHidden
                                checked={isSelected}
                                onChange={() => handleToggleSelectProduct(product.id)}
                              />
                            </div>

                            {/* Status & Surge Badges */}
                            <div
                              style={{
                                position: "absolute",
                                top: "10px",
                                right: "10px",
                                zIndex: 3,
                                display: "flex",
                                flexDirection: "column",
                                gap: "4px",
                                alignItems: "flex-end",
                              }}
                            >
                              <Badge
                                tone={
                                  product.syncStatus === "synced"
                                    ? "success"
                                    : product.syncStatus === "pending"
                                    ? "attention"
                                    : "critical"
                                }
                              >
                                {product.syncStatus.toUpperCase()}
                              </Badge>

                              {hasActiveSurge && (
                                <Badge tone="warning">
                                  {`+${product.activeSurgePercentage}% SURGE`}
                                </Badge>
                              )}
                            </div>
                          </div>

                          {/* Product Info */}
                          <Box padding="400">
                            <BlockStack gap="300">
                              <BlockStack gap="100">
                                <Text as="h3" variant="headingSm" truncate>
                                  {product.title}
                                </Text>
                                <InlineStack gap="200" align="space-between">
                                  <Text as="span" variant="bodyXs" tone="subdued">
                                    {product.category}
                                  </Text>
                                  <Text as="span" variant="bodyXs" tone="subdued">
                                    SKU: {product.sku}
                                  </Text>
                                </InlineStack>
                              </BlockStack>

                              <Divider />

                              {/* Price & Margin Breakdown */}
                              <BlockStack gap="100">
                                <InlineStack align="space-between">
                                  <Text as="span" variant="bodySm" tone="subdued">
                                    Retail Price:
                                  </Text>
                                  <Text as="span" variant="bodyMd" fontWeight="bold">
                                    ${product.retailPrice.toFixed(2)}
                                  </Text>
                                </InlineStack>

                                <InlineStack align="space-between">
                                  <Text as="span" variant="bodySm" tone="subdued">
                                    Landed Cost:
                                  </Text>
                                  <Text as="span" variant="bodySm">
                                    ${product.landedCost.toFixed(2)}
                                  </Text>
                                </InlineStack>

                                <InlineStack align="space-between">
                                  <Text as="span" variant="bodySm" tone="subdued">
                                    Est. Profit:
                                  </Text>
                                  <Text
                                    as="span"
                                    variant="bodySm"
                                    fontWeight="bold"
                                    tone={unitProfit > 0 ? "success" : "critical"}
                                  >
                                    ${unitProfit.toFixed(2)} ({profitMargin}%)
                                  </Text>
                                </InlineStack>

                                <InlineStack align="space-between">
                                  <Text as="span" variant="bodySm" tone="subdued">
                                    Total Stock:
                                  </Text>
                                  <Text as="span" variant="bodySm">
                                    {totalStock} units
                                  </Text>
                                </InlineStack>
                              </BlockStack>

                              <Divider />

                              {/* Quick Surge Controls */}
                              <BlockStack gap="200">
                                <Text as="span" variant="bodyXs" fontWeight="bold">
                                  Price Surge Controls
                                </Text>
                                <InlineStack gap="100">
                                  <Button
                                    size="micro"
                                    onClick={() => handleApplyForceSurge(product.id, 10)}
                                  >
                                    +10%
                                  </Button>
                                  <Button
                                    size="micro"
                                    onClick={() => handleApplyForceSurge(product.id, 20)}
                                  >
                                    +20%
                                  </Button>
                                  <Button
                                    size="micro"
                                    onClick={() => handleApplyForceSurge(product.id, 30)}
                                  >
                                    +30%
                                  </Button>
                                </InlineStack>

                                <InlineStack gap="200" blockAlign="center">
                                  <div style={{ flexGrow: 1 }}>
                                    <TextField
                                      label="Custom Surge"
                                      labelHidden
                                      placeholder="Custom %"
                                      type="number"
                                      value={currentCustomVal}
                                      onChange={(val) =>
                                        setCustomSurges((prev) => ({
                                          ...prev,
                                          [product.id]: val,
                                        }))
                                      }
                                      autoComplete="off"
                                    />
                                  </div>
                                  <Button
                                    size="slim"
                                    onClick={() =>
                                      handleApplyForceSurge(
                                        product.id,
                                        parseFloat(currentCustomVal)
                                      )
                                    }
                                  >
                                    Apply
                                  </Button>
                                </InlineStack>

                                {hasActiveSurge && (
                                  <Button
                                    size="slim"
                                    tone="critical"
                                    onClick={() => handleRemoveSurge(product.id)}
                                  >
                                    Reset Surge Price
                                  </Button>
                                )}
                              </BlockStack>

                              <Divider />

                              {/* Footer Action Buttons */}
                              <InlineStack gap="200" align="space-between">
                                <Button
                                  icon={EditIcon}
                                  size="slim"
                                  onClick={() => handleOpenManageModal(product)}
                                >
                                  Edit
                                </Button>
                                <Button
                                  icon={RefreshIcon}
                                  size="slim"
                                  onClick={() => handleSyncSingleProduct(product.id)}
                                >
                                  Re-sync
                                </Button>
                              </InlineStack>
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

      {/* Product Edit Modal */}
      {selectedProduct && (
        <Modal
          open={activeModal}
          onClose={() => setActiveModal(false)}
          title={`Manage ${selectedProduct.title}`}
          primaryAction={{
            content: "Save Changes",
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
              <TextField
                label="Product Title"
                value={editTitle}
                onChange={setEditTitle}
                autoComplete="off"
              />
              <TextField
                label="Category / Product Type"
                value={editCategory}
                onChange={setEditCategory}
                autoComplete="off"
              />

              <Divider />

              <Text as="h3" variant="headingSm">
                Product Variants
              </Text>

              {editVariants.map((variant, index) => (
                <Card key={variant.variantId || index}>
                  <BlockStack gap="300">
                    <Text as="h4" fontWeight="bold">
                      Variant #{index + 1}: {variant.name}
                    </Text>
                    <Grid>
                      <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                        <TextField
                          label="Variant Title"
                          value={variant.name}
                          onChange={(val) => handleUpdateVariantField(index, "name", val)}
                          autoComplete="off"
                        />
                      </Grid.Cell>
                      <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                        <TextField
                          label="SKU"
                          value={variant.sku}
                          onChange={(val) => handleUpdateVariantField(index, "sku", val)}
                          autoComplete="off"
                        />
                      </Grid.Cell>
                      <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 4, lg: 4, xl: 4 }}>
                        <TextField
                          label="Price ($)"
                          type="number"
                          value={variant.price.toString()}
                          onChange={(val) =>
                            handleUpdateVariantField(index, "price", parseFloat(val) || 0)
                          }
                          autoComplete="off"
                        />
                      </Grid.Cell>
                      <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 4, lg: 4, xl: 4 }}>
                        <TextField
                          label="Landed Cost ($)"
                          type="number"
                          value={variant.landedCost.toString()}
                          onChange={(val) =>
                            handleUpdateVariantField(index, "landedCost", parseFloat(val) || 0)
                          }
                          autoComplete="off"
                        />
                      </Grid.Cell>
                      <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 4, lg: 4, xl: 4 }}>
                        <TextField
                          label="Stock Quantity"
                          type="number"
                          value={variant.inventoryQuantity.toString()}
                          onChange={(val) =>
                            handleUpdateVariantField(
                              index,
                              "inventoryQuantity",
                              parseInt(val, 10) || 0
                            )
                          }
                          autoComplete="off"
                        />
                      </Grid.Cell>
                    </Grid>
                  </BlockStack>
                </Card>
              ))}
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}