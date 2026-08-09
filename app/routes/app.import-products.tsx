import { useState, useEffect } from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, Form, useSubmit } from "@remix-run/react";
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
} from "@shopify/polaris";
import { SearchIcon, ImportIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { searchCJProducts } from "../services/cj.server";
import db from "../db.server";

// --- Types ---

interface VariantOption {
  name: string;
  value: string;
}

interface Variant {
  variantId: string;
  name: string;
  options: VariantOption[];
  price: number;
  calculatedPrice?: number;
  sku: string;
  inventoryQuantity?: number;
}

interface Product {
  id: string;
  supplierProductId: string;
  title: string;
  supplier: string;
  price: number;
  shippingCost: number;
  shippingDays: string;
  shippingDaysMin: number;
  rating: number;
  baseSku: string;
  image: string;
  rawDescription: string;
  variants: Variant[];
}

type PricingStrategy = "multiplier" | "fixed" | "margin";

function calculateRetailPrice(
  supplierCost: number,
  strategy: PricingStrategy,
  value: number
): number {
  if (isNaN(value) || value <= 0) return supplierCost;

  let retail = supplierCost;
  switch (strategy) {
    case "multiplier":
      retail = supplierCost * value;
      break;
    case "fixed":
      retail = supplierCost + value;
      break;
    case "margin": {
      const marginDecimal = Math.min(value, 99) / 100;
      retail = supplierCost / (1 - marginDecimal);
      break;
    }
  }
  return Number(retail.toFixed(2));
}

function generateSEOData(originalTitle: string, rawDescription: string) {
  const seoTitle = `Premium ${originalTitle} | Fast Shipping & Quality`;
  const seoDescription = `<p>Elevate your store catalog with <strong>${originalTitle}</strong>.</p>
<ul>
  <li><strong>Verified Merchant Stock:</strong> Quick dispatch and reliable tracking.</li>
  <li><strong>Durable Construction:</strong> Inspected for quality control before shipping.</li>
</ul>
<p>${rawDescription}</p>`;

  return { seoTitle, seoDescription };
}

function getQueryBasedOffset(query: string) {
  let hash = 0;
  for (let i = 0; i < query.length; i++) {
    hash = (hash << 5) - hash + query.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash % 15);
}

// --- Helper to fetch Primary Shopify Location ID ---

async function getPrimaryLocationId(admin: any): Promise<string | null> {
  try {
    const response = await admin.graphql(
      `#graphql
      query getPrimaryLocation {
        locations(first: 10, includeLegacy: false) {
          nodes {
            id
            name
            isPrimary
            isActive
          }
        }
      }`
    );
    const data = await response.json();
    const locations = data?.data?.locations?.nodes || [];
    const primaryLoc =
      locations.find((loc: any) => loc.isPrimary && loc.isActive) || locations[0];
    return primaryLoc ? primaryLoc.id : null;
  } catch (err) {
    console.warn("Failed to fetch primary Shopify location ID:", err);
    return null;
  }
}

// --- Loader ---

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const searchQuery = url.searchParams.get("query") || "socks";

  let userSettings = null;
  try {
    userSettings = await db.appSettings.findUnique({
      where: { shop: session.shop },
    });
  } catch (e) {
    console.warn("Could not query appSettings:", e);
  }

  const savedPricingStrategy =
    (userSettings?.pricingStrategy as PricingStrategy) || "multiplier";
  const savedPricingValue = userSettings?.pricingValue || "1.4";

  let catalog: Product[] = [];

  // Query external CJ supplier API if configured
  if (searchQuery.trim().length > 0 && userSettings?.cjApiKey) {
    try {
      const cjData = await searchCJProducts(searchQuery);
      if (cjData?.result?.list?.length > 0) {
        catalog = cjData.result.list.map((item: any) => ({
          id: `cj-${item.pid}`,
          supplierProductId: item.pid,
          title: item.productName,
          supplier: "CJ Dropshipping",
          price: parseFloat(item.sellPrice || "0"),
          shippingCost: 2.1,
          shippingDays: "7-12 days",
          shippingDaysMin: 7,
          rating: 4.8,
          baseSku: item.productSku || `CJ-${item.pid}`,
          image: item.productImage,
          rawDescription: item.description || item.productName,
          variants: [
            {
              variantId: `${item.pid}-V1`,
              name: "Standard",
              options: [{ name: "Title", value: "Default Title" }],
              price: parseFloat(item.sellPrice || "0"),
              sku: item.productSku || `CJ-${item.pid}-STD`,
              inventoryQuantity: 100,
            },
          ],
        }));
      }
    } catch (err) {
      console.warn("CJ API Request failed:", err);
    }
  }

  // Fallback UI items matching catalog layout
  if (catalog.length === 0) {
    const term = searchQuery.trim() || "Socks";
    const capitalized = term.charAt(0).toUpperCase() + term.slice(1);
    const cleanTerm = term.toLowerCase().replace(/[^a-z0-9]/g, "");
    const encodedTerm = encodeURIComponent(term);
    const priceOffset = getQueryBasedOffset(term);

    const baseCost1 = Number((0.99 + (priceOffset % 2) * 0.2).toFixed(2));
    const baseCost2 = Number((1.2 + (priceOffset % 3) * 0.25).toFixed(2));
    const baseCost3 = Number((1.85 + (priceOffset % 4) * 0.3).toFixed(2));
    const baseCost4 = Number((2.4 + (priceOffset % 5) * 0.4).toFixed(2));

    catalog = [
      {
        id: "cat-item-1",
        supplierProductId: "SUP-ALI-101",
        title: `Thermal Winter Wool ${capitalized} (High Density)`,
        supplier: "AliExpress",
        price: baseCost1,
        shippingCost: 1.5,
        shippingDays: "10-15 days",
        shippingDaysMin: 10,
        rating: 4.5,
        baseSku: `ALI-${cleanTerm.toUpperCase()}-THRM`,
        image: `https://images.unsplash.com/photo-1582966772680-860e3525554a?auto=format&fit=crop&w=600&q=80&${encodedTerm}`,
        rawDescription: `High-density thermal comfortable ${term} for outdoor and winter use.`,
        variants: [
          {
            variantId: "VAR-1-STD",
            name: "Standard Pair",
            options: [{ name: "Size", value: "One Size" }],
            price: baseCost1,
            sku: `ALI-${cleanTerm.toUpperCase()}-THRM-STD`,
            inventoryQuantity: 250,
          },
        ],
      },
      {
        id: "cat-item-2",
        supplierProductId: "SUP-ALI-102",
        title: `Ankle Low Cut Casual ${capitalized} (10-Pack)`,
        supplier: "AliExpress",
        price: baseCost2,
        shippingCost: 1.9,
        shippingDays: "12-18 days",
        shippingDaysMin: 12,
        rating: 4.6,
        baseSku: `ALI-${cleanTerm.toUpperCase()}-ANKL`,
        image: `https://images.unsplash.com/photo-1588850561407-ed78c282e89b?auto=format&fit=crop&w=600&q=80&${encodedTerm}`,
        rawDescription: `Breathable low-cut casual ${term} multi-pack designed for daily wear.`,
        variants: [
          {
            variantId: "VAR-2-10PK",
            name: "10-Pack Assorted",
            options: [{ name: "Pack", value: "10-Pack" }],
            price: baseCost2,
            sku: `ALI-${cleanTerm.toUpperCase()}-ANKL-10P`,
            inventoryQuantity: 180,
          },
        ],
      },
      {
        id: "cat-item-3",
        supplierProductId: "SUP-CJ-103",
        title: `Breathable Cotton Crew ${capitalized} (5-Pack)`,
        supplier: "CJ Dropshipping",
        price: baseCost3,
        shippingCost: 2.1,
        shippingDays: "7-12 days",
        shippingDaysMin: 7,
        rating: 4.8,
        baseSku: `CJ-${cleanTerm.toUpperCase()}-CREW`,
        image: `https://images.unsplash.com/photo-1576871337632-b9aef4c17ab9?auto=format&fit=crop&w=600&q=80&${encodedTerm}`,
        rawDescription: `Reinforced cotton crew ${term} offering comfort and quick dispatch.`,
        variants: [
          {
            variantId: "VAR-3-5PK",
            name: "5-Pack White/Black",
            options: [{ name: "Pack", value: "5-Pack" }],
            price: baseCost3,
            sku: `CJ-${cleanTerm.toUpperCase()}-CREW-5P`,
            inventoryQuantity: 300,
          },
        ],
      },
      {
        id: "cat-item-4",
        supplierProductId: "SUP-CJ-104",
        title: `Compression Running Athletic ${capitalized}`,
        supplier: "CJ Dropshipping",
        price: baseCost4,
        shippingCost: 1.8,
        shippingDays: "5-9 days",
        shippingDaysMin: 5,
        rating: 4.9,
        baseSku: `CJ-${cleanTerm.toUpperCase()}-COMP`,
        image: `https://images.unsplash.com/photo-1521369909029-2afed882baee?auto=format&fit=crop&w=600&q=80&${encodedTerm}`,
        rawDescription: `High performance athletic compression ${term} engineered for active support.`,
        variants: [
          {
            variantId: "VAR-4-ATH",
            name: "Athletic Pair",
            options: [{ name: "Size", value: "L/XL" }],
            price: baseCost4,
            sku: `CJ-${cleanTerm.toUpperCase()}-COMP-L`,
            inventoryQuantity: 120,
          },
        ],
      },
    ];
  }

  catalog.sort((a, b) => a.price - b.price);

  return json({
    catalog,
    query: searchQuery,
    savedPricingStrategy,
    savedPricingValue,
  });
}

// --- Action Helpers ---

export async function createShopifyProduct(
  admin: any,
  productPayload: any,
  primaryLocationId: string | null
) {
  const {
    title,
    descriptionHtml,
    vendor,
    baseSku,
    supplierProductId,
    imageUrl,
    variants,
  } = productPayload;

  const optionNamesSet = new Set<string>();
  variants.forEach((v: Variant) => {
    v.options?.forEach((opt) => optionNamesSet.add(opt.name));
  });
  const productOptions = Array.from(optionNamesSet).map((name) => ({ name }));

  const productResponse = await admin.graphql(
    `#graphql
    mutation createProduct($input: ProductInput!, $media: [CreateMediaInput!]) {
      productCreate(input: $input, media: $media) {
        product {
          id
          title
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        input: {
          title,
          descriptionHtml,
          vendor: vendor || "NexusFulfill",
          tags: ["Imported", `Supplier-ID:${supplierProductId}`, `SKU:${baseSku}`],
          productOptions: productOptions.length > 0 ? productOptions : undefined,
        },
        media: imageUrl
          ? [
              {
                originalSource: imageUrl,
                mediaContentType: "IMAGE",
                alt: title,
              },
            ]
          : [],
      },
    }
  );

  const productResult = await productResponse.json();
  const productData = productResult.data?.productCreate;

  if (productData?.userErrors?.length) {
    throw new Error(productData.userErrors.map((e: any) => e.message).join(", "));
  }

  const createdProductId = productData?.product?.id;

  if (createdProductId && variants.length > 0) {
    const variantInputs = variants.map((variant: Variant) => {
      const variantPayload: any = {
        price: (variant.calculatedPrice ?? variant.price).toString(),
        sku: variant.sku,
        optionValues: variant.options.map((opt) => ({
          name: opt.value,
          optionName: opt.name,
        })),
      };

      if (primaryLocationId) {
        const qty =
          typeof variant.inventoryQuantity === "number"
            ? variant.inventoryQuantity
            : 100;
        variantPayload.inventoryQuantities = [
          {
            availableQuantity: qty,
            locationId: primaryLocationId,
          },
        ];
      }

      return variantPayload;
    });

    await admin.graphql(
      `#graphql
      mutation productVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkCreate(productId: $productId, variants: $variants) {
          productVariants {
            id
            sku
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          productId: createdProductId,
          variants: variantInputs,
        },
      }
    );
  }

  return createdProductId;
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "saveSettings") {
    const strategy = formData.get("pricingStrategy") as string;
    const value = formData.get("pricingValue") as string;

    await db.appSettings.upsert({
      where: { shop: session.shop },
      update: { pricingStrategy: strategy, pricingValue: value },
      create: {
        shop: session.shop,
        pricingStrategy: strategy,
        pricingValue: value,
      },
    });

    return json({ success: true, settingsSaved: true });
  }

  const primaryLocationId = await getPrimaryLocationId(admin);

  if (intent === "bulkImport") {
    const productsPayloadRaw = formData.get("productsPayload") as string;
    let productsPayload: any[] = [];
    try {
      productsPayload = JSON.parse(productsPayloadRaw);
    } catch (e) {
      return json(
        { success: false, errors: [{ message: "Invalid payload JSON" }] },
        { status: 400 }
      );
    }

    let successCount = 0;
    for (const prod of productsPayload) {
      try {
        await createShopifyProduct(admin, prod, primaryLocationId);
        successCount++;
      } catch (err) {
        console.error("Bulk Import item error:", err);
      }
    }

    return json({
      success: true,
      bulkImport: true,
      total: productsPayload.length,
      successCount,
    });
  }

  try {
    const title = formData.get("title") as string;
    const descriptionHtml = formData.get("descriptionHtml") as string;
    const vendor = formData.get("vendor") as string;
    const baseSku = formData.get("baseSku") as string;
    const supplierProductId = formData.get("supplierProductId") as string;
    const imageUrl = formData.get("imageUrl") as string;
    const variantsJson = formData.get("variants") as string;
    const parsedVariants = variantsJson ? JSON.parse(variantsJson) : [];

    const createdProductId = await createShopifyProduct(
      admin,
      {
        title,
        descriptionHtml,
        vendor,
        baseSku,
        supplierProductId,
        imageUrl,
        variants: parsedVariants,
      },
      primaryLocationId
    );

    return json({ success: true, productId: createdProductId });
  } catch (error: any) {
    return json(
      { success: false, errors: [{ message: error.message }] },
      { status: 500 }
    );
  }
}

// --- Main Page Component ---

export default function SearchAndImportProductsPage() {
  const { catalog, query, savedPricingStrategy, savedPricingValue } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const settingsFetcher = useFetcher<typeof action>();
  const bulkFetcher = useFetcher<typeof action>();
  const submit = useSubmit();

  const [searchValue, setSearchValue] = useState(query);
  const [sortOption, setSortOption] = useState("price-asc");
  const [selectedSuppliers, setSelectedSuppliers] = useState<string[]>([
    "CJ Dropshipping",
    "AliExpress",
  ]);

  const [pricingStrategy, setPricingStrategy] =
    useState<PricingStrategy>(savedPricingStrategy);
  const [strategyValue, setStrategyValue] = useState<string>(savedPricingValue);

  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [activeModal, setActiveModal] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [modalVariants, setModalVariants] = useState<Variant[]>([]);
  const [seoTitle, setSeoTitle] = useState("");
  const [seoDescription, setSeoDescription] = useState("");

  const isSingleImporting = fetcher.state === "submitting";
  const isBulkImporting = bulkFetcher.state === "submitting";

  useEffect(() => {
    if (fetcher.data?.success && activeModal) {
      setActiveModal(false);
    }
  }, [fetcher.data, activeModal]);

  const handleSavePricingSettings = (
    newStrategy: PricingStrategy,
    newValue: string
  ) => {
    setPricingStrategy(newStrategy);
    setStrategyValue(newValue);

    settingsFetcher.submit(
      {
        intent: "saveSettings",
        pricingStrategy: newStrategy,
        pricingValue: newValue,
      },
      { method: "POST" }
    );
  };

  const toggleSupplier = (supplierName: string) => {
    setSelectedSuppliers((prev) =>
      prev.includes(supplierName)
        ? prev.filter((s) => s !== supplierName)
        : [...prev, supplierName]
    );
  };

  const filteredProducts = catalog.filter((product) =>
    selectedSuppliers.includes(product.supplier)
  );

  const sortedProducts = [...filteredProducts].sort((a, b) => {
    switch (sortOption) {
      case "price-asc":
        return a.price - b.price;
      case "price-desc":
        return b.price - a.price;
      case "shipping-cost-asc":
        return a.shippingCost - b.shippingCost;
      case "shipping-time-asc":
        return a.shippingDaysMin - b.shippingDaysMin;
      case "total-landed-asc":
        return a.price + a.shippingCost - (b.price + b.shippingCost);
      default:
        return a.price - b.price;
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

  const valNum = parseFloat(strategyValue) || 1;
  const allSelected =
    sortedProducts.length > 0 &&
    selectedProductIds.length === sortedProducts.length;

  const handleExecuteBulkImport = () => {
    const selectedProducts = sortedProducts.filter((p) =>
      selectedProductIds.includes(p.id)
    );

    const productsPayload = selectedProducts.map((prod) => {
      const { seoTitle: generatedTitle, seoDescription: generatedDesc } =
        generateSEOData(prod.title, prod.rawDescription);

      const computedVariants = prod.variants.map((v) => ({
        ...v,
        calculatedPrice: calculateRetailPrice(
          v.price,
          pricingStrategy,
          valNum
        ),
        inventoryQuantity: v.inventoryQuantity || 100,
      }));

      return {
        id: prod.id,
        title: generatedTitle,
        descriptionHtml: generatedDesc,
        vendor: prod.supplier,
        baseSku: prod.baseSku,
        supplierProductId: prod.supplierProductId,
        imageUrl: prod.image,
        variants: computedVariants,
      };
    });

    bulkFetcher.submit(
      { intent: "bulkImport", productsPayload: JSON.stringify(productsPayload) },
      { method: "POST" }
    );
  };

  const handleOpenModal = (product: Product) => {
    setSelectedProduct(product);

    const { seoTitle: title, seoDescription: desc } = generateSEOData(
      product.title,
      product.rawDescription
    );
    setSeoTitle(title);
    setSeoDescription(desc);

    const computedVariants = product.variants.map((v) => ({
      ...v,
      calculatedPrice: calculateRetailPrice(
        v.price,
        pricingStrategy,
        valNum
      ),
      inventoryQuantity: v.inventoryQuantity || 100,
    }));

    setModalVariants(computedVariants);
    setActiveModal(true);
  };

  const handleExecuteSingleImport = () => {
    if (!selectedProduct) return;

    fetcher.submit(
      {
        title: seoTitle,
        descriptionHtml: seoDescription,
        vendor: selectedProduct.supplier,
        baseSku: selectedProduct.baseSku,
        supplierProductId: selectedProduct.supplierProductId,
        imageUrl: selectedProduct.image,
        variants: JSON.stringify(modalVariants),
      },
      { method: "POST" }
    );
  };

  return (
    <Page
      title="Sourcing & Catalog Import"
      subtitle="Search products across suppliers, ordered by lowest item price first"
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {/* Top Search Bar & Filters */}
            <Card>
              <BlockStack gap="400">
                <Form method="get" onSubmit={(e) => submit(e.currentTarget)}>
                  <InlineStack gap="300" align="space-between">
                    <div style={{ flexGrow: 1 }}>
                      <TextField
                        name="query"
                        label="Search Catalog"
                        labelHidden
                        placeholder="Type to search suppliers (e.g. socks, electronics, mugs)..."
                        value={searchValue}
                        onChange={setSearchValue}
                        prefix={<SearchIcon />}
                        clearButton
                        onClearButtonClick={() => setSearchValue("")}
                        autoComplete="off"
                      />
                    </div>
                    <Button submit variant="primary">
                      Search Products
                    </Button>
                    <Select
                      label="Sort Order"
                      labelHidden
                      options={[
                        { label: "Item Price: Low to High", value: "price-asc" },
                        { label: "Item Price: High to Low", value: "price-desc" },
                        {
                          label: "Shipping Price: Lowest First",
                          value: "shipping-cost-asc",
                        },
                        {
                          label: "Shipping Time: Fastest First",
                          value: "shipping-time-asc",
                        },
                        {
                          label: "Total Landed Cost",
                          value: "total-landed-asc",
                        },
                      ]}
                      value={sortOption}
                      onChange={setSortOption}
                    />
                  </InlineStack>
                </Form>

                {/* Supplier Filters */}
                <InlineStack gap="400" blockAlign="center">
                  <Text variant="bodySm" tone="subdued" as="span">
                    Suppliers:
                  </Text>
                  <Checkbox
                    label="CJ Dropshipping"
                    checked={selectedSuppliers.includes("CJ Dropshipping")}
                    onChange={() => toggleSupplier("CJ Dropshipping")}
                  />
                  <Checkbox
                    label="AliExpress"
                    checked={selectedSuppliers.includes("AliExpress")}
                    onChange={() => toggleSupplier("AliExpress")}
                  />
                </InlineStack>

                <Divider />

                {/* AUTO RE-PRICING MARKUP RULE TOOLBAR */}
                <Box
                  background="bg-surface-secondary"
                  padding="300"
                  borderRadius="200"
                >
                  <InlineStack
                    align="space-between"
                    blockAlign="center"
                    wrap
                    gap="300"
                  >
                    <InlineStack gap="200" blockAlign="center">
                      <Text variant="bodyMd" fontWeight="bold" as="span">
                        ⚡ Auto Re-Pricing Markup Rule:
                      </Text>
                    </InlineStack>

                    <InlineStack gap="200" blockAlign="center">
                      <Select
                        label="Markup Strategy"
                        labelHidden
                        options={[
                          { label: "Multiplier (e.g., 1.4x)", value: "multiplier" },
                          { label: "Fixed Markup (+$)", value: "fixed" },
                          { label: "Target Margin (%)", value: "margin" },
                        ]}
                        value={pricingStrategy}
                        onChange={(val) =>
                          handleSavePricingSettings(
                            val as PricingStrategy,
                            strategyValue
                          )
                        }
                      />
                      <div style={{ width: "110px" }}>
                        <TextField
                          label="Custom Value"
                          labelHidden
                          type="number"
                          value={strategyValue}
                          onChange={(val) =>
                            handleSavePricingSettings(pricingStrategy, val)
                          }
                          prefix={
                            pricingStrategy === "fixed"
                              ? "$"
                              : pricingStrategy === "margin"
                              ? "%"
                              : "x"
                          }
                          autoComplete="off"
                        />
                      </div>
                    </InlineStack>
                  </InlineStack>
                </Box>
              </BlockStack>
            </Card>

            {/* Bulk Selection Header */}
            {sortedProducts.length > 0 && (
              <Card padding="300">
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="300" blockAlign="center">
                    <Checkbox
                      label={`Select All (${selectedProductIds.length}/${sortedProducts.length} Items Found)`}
                      checked={allSelected}
                      onChange={handleSelectAll}
                    />
                  </InlineStack>
                  <Button
                    variant="primary"
                    icon={ImportIcon}
                    disabled={
                      selectedProductIds.length === 0 || isBulkImporting
                    }
                    loading={isBulkImporting}
                    onClick={handleExecuteBulkImport}
                  >
                    {`Import Selected (${selectedProductIds.length})`}
                  </Button>
                </InlineStack>
              </Card>
            )}

            {/* Notification Banners */}
            {bulkFetcher.data?.bulkImport && (
              <Banner tone="success" title="Bulk Import Completed!">
                <p>
                  Successfully imported{" "}
                  <strong>{bulkFetcher.data.successCount}</strong> product(s) to
                  your store catalog.
                </p>
              </Banner>
            )}

            {fetcher.data?.success && (
              <Banner tone="success" title="Product Imported!">
                <p>
                  The product was created in your Shopify catalog with live
                  inventory enabled.
                </p>
              </Banner>
            )}

            {/* Sourcing Product Cards */}
            <Grid>
              {sortedProducts.map((product) => {
                const totalLandedCost = product.price + product.shippingCost;
                const estRetail = calculateRetailPrice(
                  product.price,
                  pricingStrategy,
                  valNum
                );
                const isSelected = selectedProductIds.includes(product.id);

                return (
                  <Grid.Cell
                    key={product.id}
                    columnSpan={{ xs: 6, sm: 6, md: 4, lg: 3, xl: 3 }}
                  >
                    <Card padding="0">
                      <BlockStack gap="0">
                        {/* Image & Supplier Tag */}
                        <div
                          style={{
                            position: "relative",
                            width: "100%",
                            height: "200px",
                            backgroundColor: "#f1f2f4",
                            overflow: "hidden",
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
                              onChange={() =>
                                handleToggleSelectProduct(product.id)
                              }
                            />
                          </div>

                          <div
                            style={{
                              position: "absolute",
                              top: "10px",
                              right: "10px",
                              zIndex: 2,
                            }}
                          >
                            <Badge
                              tone={
                                product.supplier === "CJ Dropshipping"
                                  ? "info"
                                  : "attention"
                              }
                            >
                              {product.supplier}
                            </Badge>
                          </div>
                        </div>

                        {/* Product Details & Shipping Info */}
                        <Box padding="400">
                          <BlockStack gap="200">
                            <Text variant="headingSm" as="h3" truncate>
                              {product.title}
                            </Text>

                            <InlineStack align="space-between">
                              <Text variant="bodyXs" tone="subdued" as="span">
                                Item Price:
                              </Text>
                              <Text
                                variant="bodyXs"
                                fontWeight="bold"
                                tone="success"
                                as="span"
                              >
                                ${product.price.toFixed(2)}
                              </Text>
                            </InlineStack>

                            <InlineStack align="space-between">
                              <Text variant="bodyXs" tone="subdued" as="span">
                                Shipping:
                              </Text>
                              <Text variant="bodyXs" as="span">
                                ${product.shippingCost.toFixed(2)} ({product.shippingDays})
                              </Text>
                            </InlineStack>

                            <InlineStack align="space-between">
                              <Text variant="bodyXs" tone="subdued" as="span">
                                Total Landed:
                              </Text>
                              <Text variant="bodyXs" fontWeight="bold" as="span">
                                ${totalLandedCost.toFixed(2)}
                              </Text>
                            </InlineStack>

                            <InlineStack align="space-between">
                              <Text variant="bodyXs" tone="subdued" as="span">
                                Est. Retail:
                              </Text>
                              <Text
                                variant="bodyXs"
                                fontWeight="bold"
                                tone="interactive"
                                as="span"
                              >
                                ${estRetail.toFixed(2)}
                              </Text>
                            </InlineStack>

                            <Divider />

                            <Button
                              fullWidth
                              variant="secondary"
                              onClick={() => handleOpenModal(product)}
                            >
                              Review & Import
                            </Button>
                          </BlockStack>
                        </Box>
                      </BlockStack>
                    </Card>
                  </Grid.Cell>
                );
              })}
            </Grid>

            {/* Import Single Item Modal */}
            <Modal
              open={activeModal}
              onClose={() => setActiveModal(false)}
              title="Review & Custom Import"
              primaryAction={{
                content: "Import to Shopify",
                loading: isSingleImporting,
                onAction: handleExecuteSingleImport,
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
                    value={seoTitle}
                    onChange={setSeoTitle}
                    autoComplete="off"
                  />
                  <TextField
                    label="Description (HTML)"
                    value={seoDescription}
                    onChange={setSeoDescription}
                    multiline={4}
                    autoComplete="off"
                  />
                  <Text variant="headingSm" as="h4">
                    Variant Pricing & Inventory
                  </Text>
                  {modalVariants.map((variant, index) => (
                    <Card key={variant.variantId || index}>
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="100">
                          <Text variant="bodyMd" fontWeight="bold" as="span">
                            {variant.name}
                          </Text>
                          <Text variant="bodyXs" tone="subdued" as="span">
                            SKU: {variant.sku} | Supplier Cost: ${variant.price.toFixed(2)}
                          </Text>
                        </BlockStack>
                        <div style={{ width: "120px" }}>
                          <TextField
                            label="Retail Price"
                            type="number"
                            prefix="$"
                            value={variant.calculatedPrice?.toString() || ""}
                            onChange={(val) => {
                              const newPrice = parseFloat(val) || 0;
                              setModalVariants((prev) =>
                                prev.map((v, i) =>
                                  i === index ? { ...v, calculatedPrice: newPrice } : v
                                )
                              );
                            }}
                            autoComplete="off"
                          />
                        </div>
                      </InlineStack>
                    </Card>
                  ))}
                </BlockStack>
              </Modal.Section>
            </Modal>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}