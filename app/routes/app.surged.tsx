import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  TextField,
  Button,
  BlockStack,
  InlineStack,
  Badge,
  Text,
  Select,
  Modal,
  Banner,
  IndexTable,
  Box,
  Divider,
  Icon,
  Tooltip,
  EmptySearchResult,
  Tabs,
} from "@shopify/polaris";
import {
  InfoIcon,
  CashDollarIcon,
  RefreshIcon,
  SettingsIcon,
  ImportIcon,
  SearchIcon,
} from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { updateShopifyVariantPrice } from "../services/shopifyPrice.server";
import { syncShopifyProducts } from "../services/shopifyProductSync.server";

// --- Types ---

interface SurgedProductUI {
  id: string;
  shopifyProductId: string;
  shopifyVariantId: string;
  title: string;
  sku: string;
  originalPrice: number;
  currentPrice: number;
  salesCount: number;
  surgeStatus: "FORCE_SURGED" | "AUTO_SURGED" | "NORMAL";
  surgePercentage: number;
  autoSurgeThreshold: number;
  resetDays: number;
  daysRemaining?: number;
}

interface ActionData {
  success: boolean;
  message: string;
}

function roundCurrency(val: number): number {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

// --- Server Loader ---

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  let settings = await db.surgeSetting.findUnique({
    where: { shop },
  });

  if (!settings) {
    settings = await db.surgeSetting.create({
      data: {
        shop,
        autoSalesThreshold: 10,
        autoSurgePercentage: 10.0,
        autoResetDays: 7,
      },
    });
  }

  const now = new Date();

  // Auto-reset expired surged products concurrently
  const expiredProducts = await db.surgedProduct.findMany({
    where: {
      shop,
      surgeStatus: { in: ["FORCE_SURGED", "AUTO_SURGED"] },
      resetAt: { lte: now },
    },
  });

  if (expiredProducts.length > 0) {
    await Promise.allSettled(
      expiredProducts.map(async (prod) => {
        const rawOriginal = Number(prod.originalPrice || 0);
        const origPrice = roundCurrency(
          rawOriginal > 0 ? rawOriginal : Number(prod.currentPrice ?? 0)
        );

        if (origPrice <= 0) return;

        try {
          const res = await updateShopifyVariantPrice({
            admin,
            variantId: prod.shopifyVariantId,
            newPrice: origPrice,
          });

          // Update DB state only if Shopify variant price update was successful
          if (res?.success !== false) {
            await db.surgedProduct.update({
              where: { id: prod.id },
              data: {
                currentPrice: origPrice,
                surgeStatus: "NORMAL",
                surgePercentage: 0,
                surgedAt: null,
                resetAt: null,
              },
            });
          }
        } catch (err) {
          console.error(`Failed to auto-reset variant ${prod.shopifyVariantId}:`, err);
        }
      })
    );
  }

  const rawProducts = await db.surgedProduct.findMany({
    where: {
      shop,
      surgeStatus: {
        in: ["FORCE_SURGED", "AUTO_SURGED"],
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  const products: SurgedProductUI[] = rawProducts.map((p) => {
    let daysRemaining: number | undefined = undefined;
    if (p.resetAt) {
      const resetDate = new Date(p.resetAt);
      const diffTime = resetDate.getTime() - now.getTime();
      daysRemaining = Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
    }

    const surgeStatus: "FORCE_SURGED" | "AUTO_SURGED" | "NORMAL" =
      p.surgeStatus === "AUTO_SURGED"
        ? "AUTO_SURGED"
        : p.surgeStatus === "FORCE_SURGED"
        ? "FORCE_SURGED"
        : "NORMAL";

    const currentPriceNum = roundCurrency(Number(p.currentPrice ?? 0));
    const rawOriginalNum = Number(p.originalPrice || 0);
    const originalPriceNum = roundCurrency(
      rawOriginalNum > 0 ? rawOriginalNum : currentPriceNum
    );

    return {
      id: p.id,
      shopifyProductId: p.shopifyProductId,
      shopifyVariantId: p.shopifyVariantId,
      title: p.title || "Untitled Product",
      sku: p.sku || "N/A",
      originalPrice: originalPriceNum > 0 ? originalPriceNum : currentPriceNum,
      currentPrice: currentPriceNum,
      salesCount: p.salesCount ?? 0,
      surgeStatus,
      surgePercentage: roundCurrency(Number(p.surgePercentage ?? 0)),
      autoSurgeThreshold: p.autoSurgeThreshold ?? settings.autoSalesThreshold,
      resetDays: p.resetDays ?? settings.autoResetDays,
      daysRemaining,
    };
  });

  return json({ settings, products });
}

// --- Server Action ---

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent")?.toString();

  try {
    if (intent === "sync_products") {
      const result = await syncShopifyProducts({ admin, shop });
      return json<ActionData>({
        success: true,
        message: `Successfully synced ${result.count} products!`,
      });
    }

    if (intent === "force_surge") {
      const id = formData.get("productId")?.toString();
      const rawPctStr = formData.get("percentage")?.toString() || "10";
      const rawPercentage = parseFloat(rawPctStr);
      const percentage = Number.isNaN(rawPercentage) ? 10 : Math.max(0, rawPercentage);

      if (!id) {
        return json<ActionData>({ success: false, message: "Missing product ID" }, { status: 400 });
      }

      const record = await db.surgedProduct.findUnique({ where: { id } });
      if (!record) {
        return json<ActionData>({ success: false, message: "Product record not found" }, { status: 404 });
      }

      const rawOriginal = Number(record.originalPrice || 0);
      const basePrice =
        rawOriginal > 0
          ? roundCurrency(rawOriginal)
          : roundCurrency(Number(record.currentPrice ?? 0));

      if (basePrice <= 0) {
        return json<ActionData>(
          { success: false, message: "Cannot surge product with zero or invalid baseline price." },
          { status: 400 }
        );
      }

      const newPrice = roundCurrency(basePrice * (1 + percentage / 100));

      const res = await updateShopifyVariantPrice({
        admin,
        variantId: record.shopifyVariantId,
        newPrice,
      });

      if (!res.success) {
        return json<ActionData>(
          { success: false, message: `Shopify Price Update Failed: ${res.error}` },
          { status: 400 }
        );
      }

      const settings = await db.surgeSetting.findUnique({ where: { shop } });
      const resetDays = record.resetDays ?? settings?.autoResetDays ?? 7;

      const resetAt = new Date();
      resetAt.setDate(resetAt.getDate() + resetDays);

      await db.surgedProduct.update({
        where: { id },
        data: {
          originalPrice: basePrice,
          currentPrice: newPrice,
          surgeStatus: "FORCE_SURGED",
          surgePercentage: percentage,
          surgedAt: new Date(),
          resetAt,
        },
      });

      return json<ActionData>({
        success: true,
        message: `Updated force surge! Increased price by ${percentage}% to $${newPrice.toFixed(2)}.`,
      });
    }

    if (intent === "stop_surge") {
      const id = formData.get("productId")?.toString();

      if (!id) {
        return json<ActionData>({ success: false, message: "Missing product ID" }, { status: 400 });
      }

      const record = await db.surgedProduct.findUnique({ where: { id } });
      if (!record) {
        return json<ActionData>({ success: false, message: "Product record not found" }, { status: 404 });
      }

      const rawOriginal = Number(record.originalPrice || 0);
      const originalPriceNum =
        rawOriginal > 0
          ? roundCurrency(rawOriginal)
          : roundCurrency(Number(record.currentPrice ?? 0));

      const res = await updateShopifyVariantPrice({
        admin,
        variantId: record.shopifyVariantId,
        newPrice: originalPriceNum,
      });

      if (!res.success) {
        return json<ActionData>(
          { success: false, message: `Shopify Reset Failed: ${res.error}` },
          { status: 400 }
        );
      }

      await db.surgedProduct.update({
        where: { id },
        data: {
          currentPrice: originalPriceNum,
          surgeStatus: "NORMAL",
          surgePercentage: 0,
          surgedAt: null,
          resetAt: null,
        },
      });

      return json<ActionData>({
        success: true,
        message: `Force surge stopped. Reset price back to baseline $${originalPriceNum.toFixed(2)}.`,
      });
    }

    if (intent === "update_auto_settings") {
      const thresholdRaw = formData.get("threshold")?.toString() || "10";
      const percentageRaw = formData.get("percentage")?.toString() || "10";
      const resetDaysRaw = formData.get("resetDays")?.toString() || "7";

      const threshold = Math.max(1, parseInt(thresholdRaw, 10) || 10);
      const percentage = Math.max(0, parseFloat(percentageRaw) || 0);
      const resetDays = Math.max(1, parseInt(resetDaysRaw, 10) || 7);

      await db.surgeSetting.upsert({
        where: { shop },
        update: {
          autoSalesThreshold: threshold,
          autoSurgePercentage: percentage,
          autoResetDays: resetDays,
        },
        create: {
          shop,
          autoSalesThreshold: threshold,
          autoSurgePercentage: percentage,
          autoResetDays: resetDays,
        },
      });

      return json<ActionData>({
        success: true,
        message: `Auto Surge settings updated: +${percentage}% after ${threshold} sales, auto-reset after ${resetDays} days.`,
      });
    }

    return json<ActionData>({ success: false, message: "Unknown action intent" }, { status: 400 });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred";
    return json<ActionData>({ success: false, message: errorMessage }, { status: 500 });
  }
}

// --- Main Component ---

export default function PriceSurgeEngine() {
  const { settings, products } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();

  const [searchValue, setSearchValue] = useState("");
  const [selectedTab, setSelectedTab] = useState(0);

  const initialPctStr = settings?.autoSurgePercentage?.toString() || "10";
  const isPresetPct = ["5", "10", "15"].includes(initialPctStr);

  const [autoSalesThreshold, setAutoSalesThreshold] = useState(
    settings?.autoSalesThreshold?.toString() || "10"
  );
  const [autoSurgePercentage, setAutoSurgePercentage] = useState(
    isPresetPct ? initialPctStr : "custom"
  );
  const [customSurgeValue, setCustomSurgeValue] = useState(
    isPresetPct ? "20" : initialPctStr
  );
  const [autoResetDays, setAutoResetDays] = useState(
    settings?.autoResetDays?.toString() || "7"
  );

  // Sync settings into state safely when specific values change from loader
  const thresholdVal = settings?.autoSalesThreshold;
  const surgePctVal = settings?.autoSurgePercentage;
  const resetDaysVal = settings?.autoResetDays;

  useEffect(() => {
    if (thresholdVal !== undefined && surgePctVal !== undefined && resetDaysVal !== undefined) {
      const pctStr = surgePctVal.toString();
      const preset = ["5", "10", "15"].includes(pctStr);
      setAutoSalesThreshold(thresholdVal.toString());
      setAutoSurgePercentage(preset ? pctStr : "custom");
      setCustomSurgeValue(preset ? "20" : pctStr);
      setAutoResetDays(resetDaysVal.toString());
    }
  }, [thresholdVal, surgePctVal, resetDaysVal]);

  const [infoModalOpen, setInfoModalOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<SurgedProductUI | null>(null);

  const [surgeModalOpen, setSurgeModalOpen] = useState(false);
  const [targetProduct, setTargetProduct] = useState<SurgedProductUI | null>(null);
  const [selectedSurgePct, setSelectedSurgePct] = useState("10");
  const [customPctInput, setCustomPctInput] = useState("20");

  // Track intent to reliably trigger modal close on completion
  const lastActionIntentRef = useRef<string | null>(null);

  const tabs = [
    { id: "all", content: "All Surged" },
    { id: "force", content: "Force Surged" },
    { id: "auto", content: "Auto Surged" },
  ];

  const filteredProducts = useMemo(() => {
    return products.filter((p) => {
      const query = searchValue.toLowerCase().trim();
      const matchesSearch =
        !query ||
        (p.title && p.title.toLowerCase().includes(query)) ||
        (p.sku && p.sku.toLowerCase().includes(query));

      let matchesTab = true;
      if (selectedTab === 1) matchesTab = p.surgeStatus === "FORCE_SURGED";
      if (selectedTab === 2) matchesTab = p.surgeStatus === "AUTO_SURGED";

      return matchesSearch && matchesTab;
    });
  }, [products, searchValue, selectedTab]);

  const isBusy = fetcher.state !== "idle";
  const currentIntent = fetcher.formData?.get("intent")?.toString();
  const isSyncing = isBusy && currentIntent === "sync_products";
  const isSavingSettings = isBusy && currentIntent === "update_auto_settings";
  const isApplyingSurge = isBusy && currentIntent === "force_surge";
  const submittingProductId = fetcher.formData?.get("productId")?.toString();

  useEffect(() => {
    if (fetcher.state === "submitting" || fetcher.state === "loading") {
      lastActionIntentRef.current = currentIntent || null;
    }

    if (fetcher.state === "idle" && fetcher.data?.success) {
      if (lastActionIntentRef.current === "force_surge" && surgeModalOpen) {
        setSurgeModalOpen(false);
        setTargetProduct(null);
      }
      lastActionIntentRef.current = null;
    }
  }, [fetcher.state, fetcher.data, surgeModalOpen, currentIntent]);

  const handleSyncProducts = useCallback(() => {
    fetcher.submit({ intent: "sync_products" }, { method: "POST" });
  }, [fetcher]);

  const handleOpenInfo = useCallback((product: SurgedProductUI) => {
    setSelectedProduct(product);
    setInfoModalOpen(true);
  }, []);

  const handleCloseInfoModal = useCallback(() => {
    setInfoModalOpen(false);
    setSelectedProduct(null);
  }, []);

  const handleOpenSurgeModal = useCallback((product: SurgedProductUI) => {
    setTargetProduct(product);
    const existingPctStr = product.surgePercentage ? product.surgePercentage.toString() : "10";
    const isPreset = ["5", "10", "15"].includes(existingPctStr);
    setSelectedSurgePct(isPreset ? existingPctStr : "custom");
    setCustomPctInput(isPreset ? "20" : existingPctStr);
    setSurgeModalOpen(true);
  }, []);

  const handleCloseSurgeModal = useCallback(() => {
    if (!isApplyingSurge) {
      setSurgeModalOpen(false);
      setTargetProduct(null);
    }
  }, [isApplyingSurge]);

  const handleApplyForceSurge = useCallback(() => {
    if (!targetProduct) return;
    const rawPct = selectedSurgePct === "custom" ? customPctInput : selectedSurgePct;
    const finalPct = Math.max(0, parseFloat(rawPct) || 0);

    fetcher.submit(
      {
        intent: "force_surge",
        productId: targetProduct.id,
        percentage: finalPct.toString(),
      },
      { method: "POST" }
    );
  }, [targetProduct, selectedSurgePct, customPctInput, fetcher]);

  const handleStopSurge = useCallback(
    (product: SurgedProductUI) => {
      fetcher.submit(
        {
          intent: "stop_surge",
          productId: product.id,
        },
        { method: "POST" }
      );
    },
    [fetcher]
  );

  const handleSaveAutoSettings = useCallback(() => {
    const rawPct = autoSurgePercentage === "custom" ? customSurgeValue : autoSurgePercentage;
    const finalPct = Math.max(0, parseFloat(rawPct) || 0);

    fetcher.submit(
      {
        intent: "update_auto_settings",
        threshold: autoSalesThreshold,
        percentage: finalPct.toString(),
        resetDays: autoResetDays,
      },
      { method: "POST" }
    );
  }, [autoSurgePercentage, customSurgeValue, autoSalesThreshold, autoResetDays, fetcher]);

  const livePctParsed = useMemo(() => {
    const val = selectedSurgePct === "custom" ? customPctInput : selectedSurgePct;
    const parsed = parseFloat(val);
    return Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
  }, [selectedSurgePct, customPctInput]);

  const liveCalculatedPrice = targetProduct
    ? roundCurrency(targetProduct.originalPrice * (1 + livePctParsed / 100)).toFixed(2)
    : "0.00";

  return (
    <Page
      title="Price Surge Engine"
      subtitle="Automate dynamic demand pricing and manage force surged products"
      primaryAction={{
        content: "Sync Price Surge",
        icon: ImportIcon,
        onAction: handleSyncProducts,
        loading: isSyncing,
        disabled: isBusy,
      }}
    >
      <BlockStack gap="500">
        {fetcher.data?.message && (
          <Banner tone={fetcher.data.success ? "success" : "critical"}>
            <p>{fetcher.data.message}</p>
          </Banner>
        )}

        {/* Dynamic Rules Card */}
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <Icon source={CashDollarIcon} tone="base" />
                    <Text variant="headingMd" as="h2">
                      Automatic Price Surge Rules
                    </Text>
                  </InlineStack>
                  <Badge tone="info">Auto-Pilot Active</Badge>
                </InlineStack>

                <Text variant="bodySm" tone="subdued" as="p">
                  Automatically increase product prices after high sales velocity and reset them to base price after set days.
                </Text>

                <Divider />

                <InlineStack gap="400" wrap={true} blockAlign="end">
                  <div style={{ flex: 1, minWidth: "180px" }}>
                    <TextField
                      label="Sales Threshold (x)"
                      type="number"
                      min={1}
                      value={autoSalesThreshold}
                      onChange={setAutoSalesThreshold}
                      helpText="Trigger surge after x sales"
                      autoComplete="off"
                    />
                  </div>

                  <div style={{ flex: 1, minWidth: "180px" }}>
                    <Select
                      label="Price Increase (%)"
                      options={[
                        { label: "+5%", value: "5" },
                        { label: "+10%", value: "10" },
                        { label: "+15%", value: "15" },
                        { label: "Custom %", value: "custom" },
                      ]}
                      value={autoSurgePercentage}
                      onChange={setAutoSurgePercentage}
                    />
                  </div>

                  {autoSurgePercentage === "custom" && (
                    <div style={{ flex: 1, minWidth: "180px" }}>
                      <TextField
                        label="Custom Percentage"
                        type="number"
                        min={0}
                        suffix="%"
                        value={customSurgeValue}
                        onChange={setCustomSurgeValue}
                        autoComplete="off"
                      />
                    </div>
                  )}

                  <div style={{ flex: 1, minWidth: "180px" }}>
                    <TextField
                      label="Auto-Reset Timer (Days)"
                      type="number"
                      min={1}
                      value={autoResetDays}
                      onChange={setAutoResetDays}
                      helpText="Reset to original price after x days"
                      autoComplete="off"
                    />
                  </div>

                  <Button
                    variant="primary"
                    icon={SettingsIcon}
                    onClick={handleSaveAutoSettings}
                    loading={isSavingSettings}
                    disabled={isBusy}
                  >
                    Save Rules
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* Force Surge Table */}
        <Layout>
          <Layout.Section>
            <Card padding="0">
              <Box padding="400">
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text variant="headingMd" as="h3">
                      Surged Products Management
                    </Text>
                    <Text variant="bodySm" tone="subdued" as="span">
                      Showing {filteredProducts.length} surged products
                    </Text>
                  </InlineStack>

                  <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab} />

                  <TextField
                    label="Search Surged Products"
                    labelHidden
                    placeholder="Search surged items by title or SKU..."
                    value={searchValue}
                    onChange={setSearchValue}
                    prefix={<Icon source={SearchIcon} />}
                    clearButton
                    onClearButtonClick={() => setSearchValue("")}
                    autoComplete="off"
                  />
                </BlockStack>
              </Box>

              <IndexTable
                resourceName={{ singular: "surged product", plural: "surged products" }}
                itemCount={filteredProducts.length}
                selectable={false}
                emptyState={
                  <EmptySearchResult
                    title={products.length === 0 ? "No surged products" : "No matching products"}
                    description={
                      products.length === 0
                        ? "Surge products manually from the Imported Products page or enable automatic surge rules."
                        : "Try clearing or modifying your search filter."
                    }
                    withOption
                  />
                }
                headings={[
                  { title: "Product" },
                  { title: "Original Price" },
                  { title: "Current Price" },
                  { title: "Total Sales" },
                  { title: "Status" },
                  { title: "Actions" },
                ]}
              >
                {filteredProducts.map((product, index) => {
                  const isProductStopping =
                    isBusy &&
                    submittingProductId === product.id &&
                    currentIntent === "stop_surge";

                  return (
                    <IndexTable.Row id={product.id} key={product.id} position={index}>
                      <IndexTable.Cell>
                        <BlockStack gap="050">
                          <Text variant="bodyMd" fontWeight="bold" as="span">
                            {product.title}
                          </Text>
                          <Text variant="bodyXs" tone="subdued" as="span">
                            SKU: {product.sku}
                          </Text>
                        </BlockStack>
                      </IndexTable.Cell>

                      <IndexTable.Cell>
                        <Text variant="bodyMd" as="span">
                          ${product.originalPrice.toFixed(2)}
                        </Text>
                      </IndexTable.Cell>

                      <IndexTable.Cell>
                        <InlineStack gap="100" blockAlign="center">
                          <Text variant="bodyMd" fontWeight="bold" tone="success" as="span">
                            ${product.currentPrice.toFixed(2)}
                          </Text>
                          <Badge tone="success">+{product.surgePercentage}%</Badge>
                        </InlineStack>
                      </IndexTable.Cell>

                      <IndexTable.Cell>
                        <Text variant="bodyMd" as="span">
                          {product.salesCount} units
                        </Text>
                      </IndexTable.Cell>

                      <IndexTable.Cell>
                        {product.surgeStatus === "FORCE_SURGED" ? (
                          <Badge tone="attention">
                            Force Surged (+{product.surgePercentage}%)
                          </Badge>
                        ) : product.surgeStatus === "AUTO_SURGED" ? (
                          <Badge tone="info">
                            Auto Surged (+{product.surgePercentage}%)
                          </Badge>
                        ) : (
                          <Badge tone="subdued">Normal</Badge>
                        )}
                      </IndexTable.Cell>

                      <IndexTable.Cell>
                        <InlineStack gap="200" blockAlign="center">
                          <Tooltip content="Show Product Info">
                            <Button
                              icon={InfoIcon}
                              size="slim"
                              onClick={() => handleOpenInfo(product)}
                            />
                          </Tooltip>

                          <Button
                            variant="primary"
                            tone="critical"
                            size="slim"
                            icon={CashDollarIcon}
                            onClick={() => handleOpenSurgeModal(product)}
                            disabled={isBusy}
                          >
                            Update Surge
                          </Button>

                          <Button
                            size="slim"
                            icon={RefreshIcon}
                            onClick={() => handleStopSurge(product)}
                            loading={isProductStopping}
                            disabled={isBusy && !isProductStopping}
                          >
                            Stop Surge
                          </Button>
                        </InlineStack>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  );
                })}
              </IndexTable>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>

      {/* Details Modal */}
      <Modal
        open={infoModalOpen}
        onClose={handleCloseInfoModal}
        title="Surge Product Details"
        primaryAction={{
          content: "Close",
          onAction: handleCloseInfoModal,
        }}
      >
        <Modal.Section>
          {selectedProduct && (
            <BlockStack gap="400">
              <Text variant="headingLg" as="h3">
                {selectedProduct.title}
              </Text>

              <Divider />

              <InlineStack align="space-between">
                <BlockStack gap="050">
                  <Text variant="bodyXs" tone="subdued" as="p">
                    Baseline Original Price
                  </Text>
                  <Text variant="headingMd" as="p">
                    ${selectedProduct.originalPrice.toFixed(2)}
                  </Text>
                </BlockStack>

                <BlockStack gap="050">
                  <Text variant="bodyXs" tone="subdued" as="p">
                    Current Price
                  </Text>
                  <Text variant="headingMd" tone="success" as="p">
                    ${selectedProduct.currentPrice.toFixed(2)}
                  </Text>
                </BlockStack>

                <BlockStack gap="050">
                  <Text variant="bodyXs" tone="subdued" as="p">
                    Current Margin Gain
                  </Text>
                  <Text variant="headingMd" tone="success" as="p">
                    +${(selectedProduct.currentPrice - selectedProduct.originalPrice).toFixed(2)} / unit
                  </Text>
                </BlockStack>
              </InlineStack>

              <Box background="bg-surface-secondary" padding="400" borderRadius="200">
                <BlockStack gap="200">
                  <Text variant="headingSm" as="h4">
                    Product Status
                  </Text>
                  <Text variant="bodySm" as="p">
                    <strong>Total Sales Logged:</strong> {selectedProduct.salesCount} units
                  </Text>
                  <Text variant="bodySm" as="p">
                    <strong>Status:</strong> {selectedProduct.surgeStatus}
                  </Text>
                  {selectedProduct.daysRemaining !== undefined && (
                    <Text variant="bodySm" as="p">
                      <strong>Scheduled Reset:</strong> Resets back to ${selectedProduct.originalPrice.toFixed(2)} in {selectedProduct.daysRemaining} days
                    </Text>
                  )}
                </BlockStack>
              </Box>
            </BlockStack>
          )}
        </Modal.Section>
      </Modal>

      {/* Force Surge Update Modal */}
      <Modal
        open={surgeModalOpen}
        onClose={handleCloseSurgeModal}
        title={targetProduct ? `Update Force Surge: ${targetProduct.title}` : "Update Surge"}
        primaryAction={{
          content: "Apply Price Surge",
          tone: "critical",
          onAction: handleApplyForceSurge,
          loading: isApplyingSurge,
          disabled: isBusy && !isApplyingSurge,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: handleCloseSurgeModal,
            disabled: isApplyingSurge,
          },
        ]}
      >
        <Modal.Section>
          {targetProduct && (
            <BlockStack gap="400">
              <Banner tone="warning">
                <p>
                  Updating force surge will immediately adjust store pricing regardless of automatic surge rules.
                </p>
              </Banner>

              <InlineStack align="space-between">
                <Text variant="bodyMd" as="span">
                  Original Price: <strong>${targetProduct.originalPrice.toFixed(2)}</strong>
                </Text>
                <Text variant="bodyMd" as="span">
                  Current Price: <strong>${targetProduct.currentPrice.toFixed(2)}</strong>
                </Text>
              </InlineStack>

              <Select
                label="Select Surge Increase Percentage"
                options={[
                  { label: "Increase by 5%", value: "5" },
                  { label: "Increase by 10%", value: "10" },
                  { label: "Increase by 15%", value: "15" },
                  { label: "Custom Surge Percentage", value: "custom" },
                ]}
                value={selectedSurgePct}
                onChange={setSelectedSurgePct}
              />

              {selectedSurgePct === "custom" && (
                <TextField
                  label="Enter Custom Surge %"
                  type="number"
                  min={0}
                  suffix="%"
                  value={customPctInput}
                  onChange={setCustomPctInput}
                  autoComplete="off"
                />
              )}

              <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                <InlineStack align="space-between">
                  <Text variant="bodySm" as="span">
                    New Calculated Price:
                  </Text>
                  <Text variant="headingSm" tone="success" as="span">
                    ${liveCalculatedPrice}
                  </Text>
                </InlineStack>
              </Box>
            </BlockStack>
          )}
        </Modal.Section>
      </Modal>
    </Page>
  );
}