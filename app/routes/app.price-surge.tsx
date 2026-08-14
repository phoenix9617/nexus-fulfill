// app/routes/app.price-surge.tsx

import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useActionData, useLoaderData, useSubmit, useNavigation, Form } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Layout,
  Card,
  TextField,
  Button,
  Banner,
  BlockStack,
  InlineStack,
  Text,
  Select,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// ----------------------------------------------------------------------
// LOADER: Fetch active products and surge records
// ----------------------------------------------------------------------
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  // 1. Fetch active surge records from PostgreSQL
  const activeSurges = await db.surgedProduct.findMany({
    where: { shop },
  });

  // 2. Fetch products from Shopify Admin GraphQL API
  const response = await admin.graphql(`
    #graphql
    query getProducts {
      products(first: 20) {
        nodes {
          id
          title
          variants(first: 5) {
            nodes {
              id
              title
              price
            }
          }
        }
      }
    }
  `);

  const responseJson = await response.json();
  const products = responseJson.data?.products?.nodes || [];

  return json({ shop, products, activeSurges });
};

// ----------------------------------------------------------------------
// ACTION: Save surge state to DB FIRST, then mutate Shopify prices
// ----------------------------------------------------------------------
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const rawProductId = formData.get("productId") as string;
  const rawVariantId = formData.get("variantId") as string;
  const newPrice = formData.get("surgePrice") as string;
  const originalPrice = formData.get("originalPrice") as string;
  const durationHours = parseInt((formData.get("durationHours") as string) || "1", 10);

  if (!rawProductId || !rawVariantId || !newPrice) {
    return json({ success: false, error: "Missing required fields." }, { status: 400 });
  }

  // Normalize ID formats
  const numericProductId = rawProductId.replace("gid://shopify/Product/", "");
  const productGid = `gid://shopify/Product/${numericProductId}`;
  const variantGid = rawVariantId.startsWith("gid://") 
    ? rawVariantId 
    : `gid://shopify/ProductVariant/${rawVariantId}`;

  // Calculate surge expiration timestamp in UTC
  const surgeExpiresAt = new Date(Date.now() + durationHours * 60 * 60 * 1000);

  try {
    // ------------------------------------------------------------------
    // STEP 1: WRITE TO DATABASE FIRST (Surge Guard Pre-registration)
    // ------------------------------------------------------------------
    const existing = await db.surgedProduct.findFirst({
      where: {
        shop,
        OR: [
          { shopifyProductId: numericProductId },
          { shopifyProductId: productGid },
        ],
      },
    });

    if (existing) {
      await db.surgedProduct.update({
        where: { id: existing.id },
        data: {
          surgeStatus: "SURGED",
          surgeExpiresAt,
          surgedPrice: parseFloat(newPrice),
          originalPrice: originalPrice ? parseFloat(originalPrice) : existing.originalPrice,
        },
      });
    } else {
      await db.surgedProduct.create({
        data: {
          shop,
          shopifyProductId: numericProductId,
          surgeStatus: "SURGED",
          surgeExpiresAt,
          surgedPrice: parseFloat(newPrice),
          originalPrice: originalPrice ? parseFloat(originalPrice) : 0,
        },
      });
    }

    console.log(`[Price Surge] Registered surge in DB for product ${numericProductId} until ${surgeExpiresAt.toISOString()}`);

    // ------------------------------------------------------------------
    // STEP 2: MUTATE SHOPIFY VARIANT PRICE SECOND
    // ------------------------------------------------------------------
    const response = await admin.graphql(
      `
      #graphql
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
      }
      `,
      {
        variables: {
          productId: productGid,
          variants: [
            {
              id: variantGid,
              price: newPrice,
            },
          ],
        },
      }
    );

    const result = await response.json();
    const userErrors = result.data?.productVariantsBulkUpdate?.userErrors;

    if (userErrors && userErrors.length > 0) {
      console.error("[Price Surge] Shopify GraphQL Errors:", userErrors);
      return json({ success: false, error: userErrors[0].message }, { status: 400 });
    }

    return json({
      success: true,
      message: `Surge applied! Price updated to $${newPrice} for ${durationHours} hour(s).`,
    });
  } catch (error: any) {
    console.error("[Price Surge] Exception:", error);
    return json({ success: false, error: error.message || "Failed to apply surge." }, { status: 500 });
  }
};

// ----------------------------------------------------------------------
// REACT COMPONENT / UI
// ----------------------------------------------------------------------
export default function PriceSurgePage() {
  const { products, activeSurges } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [selectedProductId, setSelectedProductId] = useState<string>(products[0]?.id || "");
  const [selectedVariantId, setSelectedVariantId] = useState<string>(products[0]?.variants?.nodes[0]?.id || "");
  const [surgePrice, setSurgePrice] = useState<string>("");
  const [durationHours, setDurationHours] = useState<string>("1");

  const selectedProduct = products.find((p: any) => p.id === selectedProductId);
  const selectedVariant = selectedProduct?.variants?.nodes?.find((v: any) => v.id === selectedVariantId);

  const productOptions = products.map((p: any) => ({ label: p.title, value: p.id }));
  const variantOptions = (selectedProduct?.variants?.nodes || []).map((v: any) => ({
    label: `${v.title} ($${v.price})`,
    value: v.id,
  }));

  const durationOptions = [
    { label: "1 Hour", value: "1" },
    { label: "6 Hours", value: "6" },
    { label: "12 Hours", value: "12" },
    { label: "24 Hours", value: "24" },
    { label: "48 Hours", value: "48" },
  ];

  const handleProductChange = (val: string) => {
    setSelectedProductId(val);
    const prod = products.find((p: any) => p.id === val);
    if (prod?.variants?.nodes?.[0]) {
      setSelectedVariantId(prod.variants.nodes[0].id);
    }
  };

  return (
    <Page title="Price Surge Engine" subtitle="Apply temporary price bumps across catalog items.">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionData?.success && (
              <Banner title="Surge Activated" tone="success">
                <p>{actionData.message}</p>
              </Banner>
            )}

            {actionData?.error && (
              <Banner title="Surge Failed" tone="critical">
                <p>{actionData.error}</p>
              </Banner>
            )}

            <Card>
              <Form method="post">
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Create Price Surge Rule
                  </Text>

                  <Select
                    label="Select Product"
                    options={productOptions}
                    value={selectedProductId}
                    onChange={handleProductChange}
                  />

                  <Select
                    label="Select Variant"
                    options={variantOptions}
                    value={selectedVariantId}
                    onChange={(val) => setSelectedVariantId(val)}
                  />

                  <InlineStack gap="300">
                    <TextField
                      label="Current Price"
                      value={selectedVariant?.price ? `$${selectedVariant.price}` : ""}
                      disabled
                      autoComplete="off"
                    />

                    <TextField
                      label="New Surged Price ($)"
                      type="number"
                      name="surgePrice"
                      value={surgePrice}
                      onChange={(val) => setSurgePrice(val)}
                      placeholder="e.g. 49.99"
                      autoComplete="off"
                    />
                  </InlineStack>

                  <Select
                    label="Surge Duration"
                    name="durationHours"
                    options={durationOptions}
                    value={durationHours}
                    onChange={(val) => setDurationHours(val)}
                  />

                  <input type="hidden" name="productId" value={selectedProductId} />
                  <input type="hidden" name="variantId" value={selectedVariantId} />
                  <input type="hidden" name="originalPrice" value={selectedVariant?.price || "0"} />

                  <Button
                    submit
                    variant="primary"
                    loading={isSubmitting}
                    disabled={!surgePrice || isSubmitting}
                  >
                    Apply Price Surge
                  </Button>
                </BlockStack>
              </Form>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Active Surge Status ({activeSurges.length})
                </Text>
                {activeSurges.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No active surges recorded in database.
                  </Text>
                ) : (
                  activeSurges.map((surge: any) => (
                    <InlineStack key={surge.id} align="space-between">
                      <Text as="span">Product ID: {surge.shopifyProductId}</Text>
                      <Text as="span" tone="success">
                        Status: {surge.surgeStatus} (Expires: {new Date(surge.surgeExpiresAt).toLocaleTimeString()})
                      </Text>
                    </InlineStack>
                  ))
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}