import { useState } from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useFetcher } from "@remix-run/react";
import {
  Page,
  Card,
  TextField,
  Button,
  Grid,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Banner,
  Spinner,
  Box,
  Thumbnail,
  Modal,
  Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Import supplier logic from services directory
import { fetchCJProducts } from "../services/cj.server";
import { fetchAliExpressProducts } from "../services/aliexpress.server";

export interface SearchProduct {
  id: string;
  sku: string;
  title: string;
  image: string;
  price: number;
  supplier: string;
  category: string;
  description?: string;
}

function generateFallbackResults(query: string): SearchProduct[] {
  const cleanTerm = query.trim().charAt(0).toUpperCase() + query.trim().slice(1);
  const skuTerm = query.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "ITEM";

  return [
    {
      id: "cj-demo-1",
      sku: `CJ-${skuTerm}-01`,
      title: `CJ Wholesale ${cleanTerm}`,
      image: "https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=600&q=80",
      price: 8.5,
      supplier: "CJ Dropshipping",
      category: cleanTerm,
      description: `Factory direct ${query} from CJ Dropshipping.`,
    },
    {
      id: "ali-demo-1",
      sku: `ALI-${skuTerm}-01`,
      title: `AliExpress Value ${cleanTerm}`,
      image: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=600&q=80",
      price: 11.2,
      supplier: "AliExpress",
      category: cleanTerm,
      description: `Budget-friendly ${query} from AliExpress suppliers.`,
    },
    {
      id: "cj-demo-2",
      sku: `CJ-${skuTerm}-02`,
      title: `CJ Premium Pro ${cleanTerm}`,
      image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=600&q=80",
      price: 15.0,
      supplier: "CJ Dropshipping",
      category: cleanTerm,
      description: `High quality ${query} with rapid delivery option.`,
    },
    {
      id: "ali-demo-2",
      sku: `ALI-${skuTerm}-02`,
      title: `AliExpress Exclusive ${cleanTerm}`,
      image: "https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?auto=format&fit=crop&w=600&q=80",
      price: 19.99,
      supplier: "AliExpress",
      category: cleanTerm,
      description: `Top-rated AliExpress retail ${query}.`,
    },
  ];
}

// Helpers to normalize API responses to standard SearchProduct format
function normalizeCJProduct(item: any, query: string): SearchProduct {
  const rawPrice = item.price || item.sellPrice || item.productPrice || 0;
  return {
    id: item.id || item.pid || `cj_${item.sku || Math.random()}`,
    sku: item.sku || item.productSku || `CJ-${item.pid || "ITEM"}`,
    title: item.title || item.productNameEn || item.productName || "CJ Product",
    image: item.image || item.productImage || "",
    price: typeof rawPrice === "number" ? rawPrice : parseFloat(rawPrice) || 0,
    supplier: "CJ Dropshipping",
    category: query,
    description: item.description || item.title || "",
  };
}

function normalizeAliExpressProduct(item: any, query: string): SearchProduct {
  const rawPrice = item.price || 0;
  return {
    id: item.id || `ali_${item.externalId || Math.random()}`,
    sku: item.sku || `ALI-${item.externalId || "ITEM"}`,
    title: item.title || "AliExpress Product",
    image: item.image || "",
    price: typeof rawPrice === "number" ? rawPrice : parseFloat(rawPrice) || 0,
    supplier: "AliExpress",
    category: query,
    description: item.description || item.title || "",
  };
}

// ----------------------------------------------------------------------
// LOADER & ACTION
// ----------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const query = url.searchParams.get("q") || "";

  // Query database for shop settings
  let settings: any = null;
  try {
    if ((db as any).appSettings) {
      settings = await (db as any).appSettings.findUnique({
        where: { shop: session.shop },
      });
    } else if ((db as any).setting) {
      settings = await (db as any).setting.findFirst({
        where: { shop: session.shop },
      });
    }
  } catch (e) {
    console.warn("[Search Loader] Could not retrieve app settings from database:", e);
  }

  // Extract CJ API key (Database setting -> environment variable)
  const cjApiKey = settings?.cjApiKey || process.env.CJ_API_KEY || process.env.CJ_ACCESS_TOKEN;

  // Extract RapidAPI Key with validation:
  // If database contains an official AliExpress v2_auth token, ignore it and force fallback to process.env.RAPIDAPI_KEY
  let dbRapidKey = settings?.rapidApiKey || settings?.aliExpressToken;
  if (dbRapidKey && dbRapidKey.startsWith("v2_auth")) {
    dbRapidKey = undefined;
  }
  const rapidApiKey = dbRapidKey || process.env.RAPIDAPI_KEY;

  const hasApiKey = Boolean(cjApiKey || rapidApiKey);

  if (!query) {
    return json({ query: "", results: [], hasApiKey });
  }

  console.log(`[Search Loader] Executing search for term: "${query}"`);
  console.log(`[Search Loader] CJ Key present: ${Boolean(cjApiKey)} | RapidAPI Key present: ${Boolean(rapidApiKey)}`);

  // Concurrent searches to CJ and AliExpress
  const [cjRaw, aliRaw] = await Promise.all([
    fetchCJProducts ? fetchCJProducts(query, cjApiKey).catch((err) => {
      console.error("[Search Loader] CJ Fetch Exception:", err);
      return [];
    }) : Promise.resolve([]),
    fetchAliExpressProducts ? fetchAliExpressProducts(query, rapidApiKey).catch((err) => {
      console.error("[Search Loader] AliExpress Fetch Exception:", err);
      return [];
    }) : Promise.resolve([]),
  ]);

  const cjResults: SearchProduct[] = Array.isArray(cjRaw)
    ? cjRaw.map((item) => normalizeCJProduct(item, query))
    : [];

  const aliResults: SearchProduct[] = Array.isArray(aliRaw)
    ? aliRaw.map((item) => normalizeAliExpressProduct(item, query))
    : [];

  console.log(`[Search Loader] Live items mapped -> CJ: ${cjResults.length}, AliExpress: ${aliResults.length}`);

  let results: SearchProduct[] = [...cjResults, ...aliResults];

  // Fallback to demo items ONLY if no API keys are provided at all in .env or DB
  if (results.length === 0 && !hasApiKey) {
    console.log("[Search Loader] No API keys detected. Serving fallback demo items.");
    results = generateFallbackResults(query);
  }

  // Sort lowest to highest price
  results.sort((a, b) => a.price - b.price);

  return json({
    query,
    results,
    hasApiKey,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "importProduct") {
    const title = formData.get("title") as string;
    const vendor = formData.get("vendor") as string;
    const price = formData.get("price") as string;
    const sku = formData.get("sku") as string;
    const image = formData.get("image") as string;

    try {
      // 1. Create Product in Shopify Store
      const response = await admin.graphql(
        `#graphql
        mutation productSet($synchronous: Boolean!, $input: ProductSetInput!) {
          productSet(synchronous: $synchronous, input: $input) {
            product {
              id
              title
              handle
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            synchronous: true,
            input: {
              title,
              vendor: vendor || "Supplier Fulfillment",
              tags: ["Imported", "Imported-Supplier", "CJ-Auto-Fulfill", `SKU:${sku}`, `Supplier:${vendor}`],
              files: image
                ? [
                    {
                      originalSource: image,
                      contentType: "IMAGE",
                      alt: title,
                    },
                  ]
                : [],
              productOptions: [
                {
                  name: "Title",
                  values: [{ name: "Default Title" }],
                },
              ],
              variants: [
                {
                  optionValues: [
                    { optionName: "Title", name: "Default Title" },
                  ],
                  price,
                  sku,
                },
              ],
            },
          },
        }
      );

      const resJson = await response.json();
      const userErrors = resJson.data?.productSet?.userErrors;

      if (userErrors && userErrors.length > 0) {
        console.error("[Shopify Import] GraphQL Errors:", userErrors);
        return json({ success: false, errors: userErrors }, { status: 400 });
      }

      const shopifyProductId = resJson.data?.productSet?.product?.id;

      // 2. Create local DB record so the app's internal Imported page tracks it
      if (shopifyProductId) {
        try {
          const dbModel = (db as any).importedProduct || (db as any).product;
          if (dbModel) {
            await dbModel.create({
              data: {
                shop: session.shop,
                shopifyProductId,
                title,
                vendor: vendor || "Supplier Fulfillment",
                sku,
                price: parseFloat(price),
                image,
                supplier: vendor,
              },
            });
          }
        } catch (dbErr) {
          console.warn("[DB Save Warning] Product created in Shopify, but failed to save in local DB:", dbErr);
        }
      }

      return json({ success: true, productId: shopifyProductId });
    } catch (err) {
      console.error("[Search Action] Failed to import product to Shopify:", err);
      return json({ success: false, error: "Failed to create product in Shopify" }, { status: 500 });
    }
  }

  return json({ success: true });
};

// ----------------------------------------------------------------------
// REACT COMPONENT
// ----------------------------------------------------------------------

export default function SearchSuppliers() {
  const { query: initialQuery, results, hasApiKey } = useLoaderData<typeof loader>();
  const [searchValue, setSearchValue] = useState(initialQuery);
  const [selectedProduct, setSelectedProduct] = useState<SearchProduct | null>(null);

  const submit = useSubmit();
  const navigation = useNavigation();
  const importFetcher = useFetcher<typeof action>();

  const isLoading = navigation.state === "loading" || navigation.state === "submitting";

  const handleSearch = () => {
    if (!searchValue.trim()) return;
    submit({ q: searchValue }, { method: "get" });
  };

  const handleImport = (product: SearchProduct) => {
    importFetcher.submit(
      {
        intent: "importProduct",
        title: product.title,
        vendor: product.supplier,
        price: product.price.toFixed(2),
        sku: product.sku,
        image: product.image,
      },
      { method: "POST" }
    );
  };

  return (
    <Page title="Multi-Supplier Product Search">
      <BlockStack gap="500">
        {!hasApiKey && (
          <Banner tone="warning" title="API Key Required">
            <p>
              Please enter your CJ Dropshipping key or RapidAPI key in <b>Settings</b> or your environment file to perform live supplier searches.
            </p>
          </Banner>
        )}

        {importFetcher.data?.success && (
          <Banner tone="success" title="Product Imported!">
            <p>The product was successfully created and added to your Shopify store inventory.</p>
          </Banner>
        )}

        <Card padding="500">
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Search Products Across Suppliers
            </Text>

            <InlineStack gap="300" align="start">
              <Box width="100%">
                <TextField
                  label="Search Keyword or SKU"
                  labelHidden
                  placeholder="e.g. Wireless Charger, Leather Wallet, SKU-123..."
                  value={searchValue}
                  onChange={(val) => setSearchValue(val)}
                  autoComplete="off"
                  clearButton
                  onClearButtonClick={() => setSearchValue("")}
                />
              </Box>
              <Button
                variant="primary"
                onClick={handleSearch}
                loading={isLoading}
              >
                Search
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>

        {isLoading ? (
          <Box padding="600">
            <InlineStack align="center">
              <Spinner size="large" />
            </InlineStack>
          </Box>
        ) : (
          <>
            {initialQuery && results.length === 0 && (
              <Banner tone="info">
                <p>No live products found matching "<b>{initialQuery}</b>". Please check server logs if you expected results.</p>
              </Banner>
            )}

            {results.length > 0 && (
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="headingSm" as="h3">
                    Showing {results.length} products
                  </Text>
                  <Badge tone="success">Sorted: Lowest to Highest Price</Badge>
                </InlineStack>

                <Grid>
                  {results.map((product) => {
                    const isImporting =
                      importFetcher.state === "submitting" &&
                      importFetcher.formData?.get("sku") === product.sku;

                    return (
                      <Grid.Cell
                        key={product.id}
                        columnSpan={{ xs: 6, sm: 6, md: 4, lg: 3, xl: 3 }}
                      >
                        <Card padding="400">
                          <BlockStack gap="300">
                            <Box background="bg-surface-secondary" padding="200" borderRadius="200">
                              <InlineStack align="center">
                                <Thumbnail
                                  source={product.image || ""}
                                  alt={product.title}
                                  size="large"
                                />
                              </InlineStack>
                            </Box>

                            <BlockStack gap="100">
                              <InlineStack align="space-between">
                                <Badge tone={product.supplier === "CJ Dropshipping" ? "info" : "attention"}>
                                  {product.supplier}
                                </Badge>
                              </InlineStack>
                              <Text as="h3" variant="bodyMd" fontWeight="bold" truncate>
                                {product.title}
                              </Text>
                              <Text as="span" variant="bodyXs" tone="subdued">
                                SKU: {product.sku}
                              </Text>
                              <Text as="p" variant="headingMd" tone="success">
                                ${product.price.toFixed(2)}
                              </Text>
                            </BlockStack>

                            <BlockStack gap="200">
                              <Button
                                variant="primary"
                                fullWidth
                                loading={isImporting}
                                onClick={() => handleImport(product)}
                              >
                                Import to Shopify
                              </Button>
                              <Button
                                fullWidth
                                onClick={() => setSelectedProduct(product)}
                              >
                                View Details
                              </Button>
                            </BlockStack>
                          </BlockStack>
                        </Card>
                      </Grid.Cell>
                    );
                  })}
                </Grid>
              </BlockStack>
            )}
          </>
        )}
      </BlockStack>

      {selectedProduct && (
        <Modal
          open={Boolean(selectedProduct)}
          onClose={() => setSelectedProduct(null)}
          title={selectedProduct.title}
          primaryAction={{
            content: "Import to Store",
            onAction: () => {
              handleImport(selectedProduct);
              setSelectedProduct(null);
            },
          }}
          secondaryActions={[{ content: "Close", onAction: () => setSelectedProduct(null) }]}
        >
          <Modal.Section>
            <BlockStack gap="300">
              <InlineStack gap="400" align="start">
                <Thumbnail source={selectedProduct.image} alt={selectedProduct.title} size="large" />
                <BlockStack gap="100">
                  <Badge tone="info">{selectedProduct.supplier}</Badge>
                  <Text variant="headingMd" as="h2">${selectedProduct.price.toFixed(2)}</Text>
                  <Text variant="bodySm" tone="subdued" as="p">SKU: {selectedProduct.sku}</Text>
                </BlockStack>
              </InlineStack>
              <Divider />
              <Text variant="bodyMd" as="p">{selectedProduct.description || "No description available."}</Text>
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}