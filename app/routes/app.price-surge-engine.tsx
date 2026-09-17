// app/routes/app.price-surge-engine.tsx
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation, Form } from "@remix-run/react";
import { useState, useEffect } from "react";
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
  Badge,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// REQUIRED Prisma field on surgedProduct:
// shopifyVariantId String
//
// Add it to your Prisma schema if it does not already exist, then run:
// npx prisma migrate dev
// npx prisma generate

interface ProductVariantNode {
  id: string;
  title: string;
  price: string;
}

interface ProductNode {
  id: string;
  title: string;
  variants: {
    nodes: ProductVariantNode[];
  };
}

// ----------------------------------------------------------------------
// LOADER: Fetch active products and surge records
// ----------------------------------------------------------------------
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  // 1. Fetch active surge records from PostgreSQL
  const activeSurges = await db.surgedProduct.findMany({
    where: {
      shop,
      surgeStatus: "SURGED",
      surgeExpiresAt: {
        gt: new Date(),
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  // 2. Fetch products from Shopify Admin GraphQL API
  const response = await admin.graphql(`
    #graphql
    query getProducts {
      products(first: 50) {
        nodes {
          id
          title
          variants(first: 10) {
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

  if (responseJson.errors?.length) {
    console.error("[Price Surge] Shopify product query errors:", responseJson.errors);
    throw new Response("Failed to load Shopify products.", { status: 500 });
  }

  const products: ProductNode[] =
    responseJson.data?.products?.nodes || [];

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
  const durationHours = parseInt(
    (formData.get("durationHours") as string) || "1",
    10
  );

  const parsedNewPrice = Number(newPrice);
  const parsedOriginalPrice = originalPrice ? Number(originalPrice) : 0;

  if (!rawProductId || !rawVariantId || !newPrice) {
    return json(
      { success: false, error: "Missing required form fields." },
      { status: 400 }
    );
  }

  if (!Number.isFinite(parsedNewPrice) || parsedNewPrice <= 0) {
    return json(
      { success: false, error: "Surge price must be a valid positive number." },
      { status: 400 }
    );
  }

  if (!Number.isInteger(durationHours) || durationHours <= 0) {
    return json(
      { success: false, error: "Duration must be a positive whole number of hours." },
      { status: 400 }
    );
  }

  // Normalize ID formats
  const numericProductId = rawProductId.replace("gid://shopify/Product/", "");
  const productGid = `gid://shopify/Product/${numericProductId}`;
  
  const numericVariantId = rawVariantId.replace("gid://shopify/ProductVariant/", "");
  const variantGid = `gid://shopify/ProductVariant/${numericVariantId}`;

  // Calculate surge expiration timestamp in UTC
  const surgeExpiresAt = new Date(Date.now() + durationHours * 60 * 60 * 1000);

  try {
    // ------------------------------------------------------------------
    // STEP 1: CHECK FOR AN EXISTING SURGE FOR THIS EXACT VARIANT
    // ------------------------------------------------------------------
    // IMPORTANT:
    // Your Prisma model should contain:
    //   shopifyVariantId String
    //
    // The old implementation only keyed the surge by product ID, which
    // can cause one variant's surge to overwrite another variant's surge.

    const existing = await db.surgedProduct.findFirst({
      where: {
        shop,
        shopifyProductId: numericProductId,
        shopifyVariantId: numericVariantId,
      },
    });

    // Preserve the original/base price if this variant is already surged.
    // Never use the currently surged price as the new "original" price.
    const baseOriginalPrice =
      existing?.originalPrice && existing.originalPrice > 0
        ? existing.originalPrice
        : parsedOriginalPrice;

    if (!baseOriginalPrice || baseOriginalPrice <= 0) {
      return json(
        {
          success: false,
          error: "Could not determine the original product price.",
        },
        { status: 400 }
      );
    }

    // ------------------------------------------------------------------
    // STEP 2: UPDATE SHOPIFY FIRST
    // ------------------------------------------------------------------
    // We intentionally update Shopify BEFORE marking the DB record ACTIVE.
    // This prevents the database from saying a surge is active when Shopify
    // rejected the price update.
    console.log("[Price Surge] Updating Shopify variant:", {
      shop,
      productGid,
      variantGid,
      newPrice,
      timestamp: new Date().toISOString(),
    });

    const shopifyResponse = await admin.graphql(
      `
        #graphql
        mutation productVariantsBulkUpdate(
          $productId: ID!
          $variants: [ProductVariantsBulkInput!]!
        ) {
          productVariantsBulkUpdate(
            productId: $productId
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
        }
      `,
      {
        variables: {
          productId: productGid,
          variants: [
            {
              id: variantGid,
              price: parsedNewPrice.toFixed(2),
            },
          ],
        },
      }
    );

    const result = await shopifyResponse.json();

    if (result.errors?.length) {
      console.error("[Price Surge] Shopify GraphQL errors:", result.errors);

      return json(
        {
          success: false,
          error:
            result.errors[0]?.message ||
            "Shopify rejected the price update.",
        },
        { status: 400 }
      );
    }

    const mutationResult = result.data?.productVariantsBulkUpdate;

    if (!mutationResult) {
      return json(
        {
          success: false,
          error: "Shopify returned an unexpected response.",
        },
        { status: 500 }
      );
    }

    if (mutationResult.userErrors?.length > 0) {
      console.error(
        "[Price Surge] Shopify user errors:",
        mutationResult.userErrors
      );

      return json(
        {
          success: false,
          error: mutationResult.userErrors[0].message,
        },
        { status: 400 }
      );
    }

    const updatedVariant = mutationResult.productVariants?.find(
      (variant: { id: string; price: string }) => variant.id === variantGid
    );

    // Verify Shopify actually returned the requested price.
    if (!updatedVariant) {
      return json(
        {
          success: false,
          error: "Shopify did not return the updated variant.",
        },
        { status: 500 }
      );
    }

    const actualShopifyPrice = Number(updatedVariant.price);

    if (
      !Number.isFinite(actualShopifyPrice) ||
      Math.abs(actualShopifyPrice - parsedNewPrice) > 0.001
    ) {
      console.error("[Price Surge] Shopify price verification failed:", {
        requested: parsedNewPrice,
        returned: updatedVariant.price,
      });

      return json(
        {
          success: false,
          error: `Shopify did not confirm the requested price. Returned $${updatedVariant.price}.`,
        },
        { status: 500 }
      );
    }

    // ------------------------------------------------------------------
    // STEP 3: NOW SAVE THE SUCCESSFUL SURGE TO THE DATABASE
    // ------------------------------------------------------------------
    const surgeExpiresAt = new Date(
      Date.now() + durationHours * 60 * 60 * 1000
    );

    if (existing) {
      await db.surgedProduct.update({
        where: { id: existing.id },
        data: {
          surgeStatus: "SURGED",
          surgeExpiresAt,
          surgedPrice: parsedNewPrice,
          originalPrice: baseOriginalPrice,
          shopifyVariantId: numericVariantId,
        },
      });
    } else {
      await db.surgedProduct.create({
        data: {
          shop,
          shopifyProductId: numericProductId,
          shopifyVariantId: numericVariantId,
          surgeStatus: "SURGED",
          surgeExpiresAt,
          surgedPrice: parsedNewPrice,
          originalPrice: baseOriginalPrice,
        },
      });
    }

    console.log("[Price Surge] Surge successfully applied:", {
      productId: numericProductId,
      variantId: numericVariantId,
      price: parsedNewPrice,
      expiresAt: surgeExpiresAt.toISOString(),
    });

    return json({
      success: true,
      message: `Surge applied! Variant price updated to $${newPrice} for ${durationHours} hour(s).`,
    });
  } catch (error: unknown) {
    const errMessage = error instanceof Error ? error.message : "Failed to apply surge.";
    console.error("[Price Surge] Exception:", error);
    return json({ success: false, error: errMessage }, { status: 500 });
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

  // Reset form inputs after successful submission
  useEffect(() => {
    if (actionData?.success) {
      setSurgePrice("");
    }
  }, [actionData]);

  const selectedProduct = products.find((p) => p.id === selectedProductId);
  const selectedVariant = selectedProduct?.variants?.nodes?.find((v) => v.id === selectedVariantId);

  const productOptions = products.map((p) => ({ label: p.title, value: p.id }));
  const variantOptions = (selectedProduct?.variants?.nodes || []).map((v) => ({
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
    const prod = products.find((p) => p.id === val);
    if (prod?.variants?.nodes?.[0]) {
      setSelectedVariantId(prod.variants.nodes[0].id);
    } else {
      setSelectedVariantId("");
    }
  };

  return (
    <Page title="Price Surge Engine" subtitle="Apply temporary price bumps across catalog items with webhook protection.">
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

                  {products.length === 0 ? (
                    <Text as="p" tone="subdued">
                      No products found in your Shopify store.
                    </Text>
                  ) : (
                    <>
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
                        disabled={variantOptions.length === 0}
                      />

                      <InlineStack gap="300">
                        <TextField
                          label="Current Price"
                          value={selectedVariant?.price ? `$${selectedVariant.price}` : "$0.00"}
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

                      <InlineStack align="end">
                        <Button
                          submit
                          variant="primary"
                          loading={isSubmitting}
                          disabled={!surgePrice || !selectedVariantId || isSubmitting}
                        >
                          Apply Price Surge
                        </Button>
                      </InlineStack>
                    </>
                  )}
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
                    No active price surges recorded in the database.
                  </Text>
                ) : (
                  activeSurges.map((surge) => {
                    const isExpired = new Date(surge.surgeExpiresAt) < new Date();
                    return (
                      <InlineStack key={surge.id} align="space-between" blockAlign="center">
                        <BlockStack gap="100">
                          <Text as="span" fontWeight="bold">
                            Product ID: {surge.shopifyProductId}
                          </Text>
                          <Text as="span" variant="bodyXs" tone="subdued">
                            Surged Price: ${surge.surgedPrice?.toFixed(2) ?? "N/A"} | Original: ${surge.originalPrice?.toFixed(2) ?? "N/A"}
                          </Text>
                        </BlockStack>
                        <InlineStack gap="200" blockAlign="center">
                          <Badge tone={isExpired ? "attention" : "success"}>
                            {isExpired ? "EXPIRED" : surge.surgeStatus}
                          </Badge>
                          <Text as="span" variant="bodyXs" tone="subdued">
                            Expires: {new Date(surge.surgeExpiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </Text>
                        </InlineStack>
                      </InlineStack>
                    );
                  })
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}