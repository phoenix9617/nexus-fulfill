// app/routes/app._index.tsx

import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSubmit, useNavigation } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  BlockStack,
  InlineStack,
  Badge,
  Grid,
  Divider,
  Icon,
} from "@shopify/polaris";
import {
  SearchIcon,
  LinkIcon,
  RefreshIcon,
  AlertBubbleIcon,
  SettingsIcon,
  CheckCircleIcon,
} from "@shopify/polaris-icons";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { syncCJTrackingOrders } from "../services/cjTrackingSync.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // 1. Fetch store settings to verify supplier connection status
  const settings = await db.appSettings.findUnique({
    where: { shop },
  });

  // 2. Fetch live metrics from Prisma models
  // Mapped products count (or product mappings)
  const mappedProductsCount = await db.surgedProduct.count({
    where: { shop },
  });

  // Rerouted or failed orders count
  const reroutedOrdersCount = await db.fulfilledOrder.count({
    where: { shop, status: "REROUTED" },
  });

  // Active surge interventions count
  const surgeInterventionsCount = await db.surgedProduct.count({
    where: { shop, surgeStatus: "AUTO_SURGED" },
  });

  const isSupplierConnected = Boolean(settings?.cjApiKey);

  return json({
    metrics: {
      mappedProductsCount,
      reroutedOrdersCount,
      surgeInterventionsCount,
      isSupplierConnected,
    },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "sync_tracking") {
    try {
      const result = await syncCJTrackingOrders(shop);
      return json({
        success: true,
        message: `Synced ${result.updatedCount} orders from supplier.`,
      });
    } catch (error: any) {
      return json(
        { success: false, error: error.message || "Tracking sync failed." },
        { status: 500 }
      );
    }
  }

  return json({ success: false, error: "Invalid action intent" }, { status: 400 });
};

export default function Dashboard() {
  const { metrics } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const submit = useSubmit();
  const navigation = useNavigation();

  const isSyncing =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "sync_tracking";

  const handleManualSync = () => {
    const formData = new FormData();
    formData.append("intent", "sync_tracking");
    submit(formData, { method: "post" });
  };

  return (
    <Page title="NexusFulfill Dashboard">
      <BlockStack gap="500">
        {/* Top Banner / System Status */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <InlineStack gap="200" blockAlign="center">
                <Text variant="headingLg" as="h2">
                  System Status
                </Text>
                <Badge
                  tone={metrics.isSupplierConnected ? "success" : "attention"}
                  progress="complete"
                >
                  {metrics.isSupplierConnected ? "Automation Active" : "Setup Required"}
                </Badge>
              </InlineStack>
              <InlineStack gap="200">
                <Button
                  loading={isSyncing}
                  icon={RefreshIcon}
                  onClick={handleManualSync}
                >
                  Sync Tracking
                </Button>
                <Button
                  variant="plain"
                  icon={SettingsIcon}
                  onClick={() => navigate("/app/settings")}
                >
                  Configure Settings
                </Button>
              </InlineStack>
            </InlineStack>
            <Text as="p" tone="subdued">
              Automated multi-vendor catalog sync, failover routing, and dynamic price surge
              protection for your store.
            </Text>
          </BlockStack>
        </Card>

        {/* Metrics Grid */}
        <Grid>
          <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
            <Card>
              <BlockStack gap="100">
                <Text variant="bodySm" tone="subdued" as="p">
                  Mapped Products
                </Text>
                <Text variant="headingXl" as="p">
                  {metrics.mappedProductsCount}
                </Text>
                <InlineStack gap="100" blockAlign="center">
                  <Icon source={CheckCircleIcon} tone="success" />
                  <Text variant="bodyXs" tone="success" as="span">
                    Sync Active
                  </Text>
                </InlineStack>
              </BlockStack>
            </Card>
          </Grid.Cell>

          <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
            <Card>
              <BlockStack gap="100">
                <Text variant="bodySm" tone="subdued" as="p">
                  Rerouted Orders
                </Text>
                <Text variant="headingXl" as="p">
                  {metrics.reroutedOrdersCount}
                </Text>
                <Text variant="bodyXs" tone="subdued" as="span">
                  Last 30 days
                </Text>
              </BlockStack>
            </Card>
          </Grid.Cell>

          <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
            <Card>
              <BlockStack gap="100">
                <Text variant="bodySm" tone="subdued" as="p">
                  Surge Interventions
                </Text>
                <Text variant="headingXl" as="p">
                  {metrics.surgeInterventionsCount}
                </Text>
                <Text variant="bodyXs" tone="subdued" as="span">
                  Cost spikes prevented
                </Text>
              </BlockStack>
            </Card>
          </Grid.Cell>

          <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 3, lg: 3, xl: 3 }}>
            <Card>
              <BlockStack gap="100">
                <Text variant="bodySm" tone="subdued" as="p">
                  Primary Supplier
                </Text>
                <Text variant="headingMd" as="p">
                  {metrics.isSupplierConnected ? "Connected" : "Not Configured"}
                </Text>
                <Badge tone={metrics.isSupplierConnected ? "info" : "critical"}>
                  {metrics.isSupplierConnected ? "CJ / AliExpress" : "Disconnected"}
                </Badge>
              </BlockStack>
            </Card>
          </Grid.Cell>
        </Grid>

        {/* Quick Access Modules */}
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h3">
                  Quick Actions
                </Text>
                <Divider />
                <Grid>
                  <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                    <Card roundedAbove="sm">
                      <BlockStack gap="200">
                        <InlineStack gap="200" blockAlign="center">
                          <Icon source={SearchIcon} />
                          <Text variant="headingSm" as="h4">
                            Sourcing & Import
                          </Text>
                        </InlineStack>
                        <Text variant="bodySm" tone="subdued" as="p">
                          Search CJ Dropshipping catalog and import high-margin products directly.
                        </Text>
                        <InlineStack align="end">
                          <Button onClick={() => navigate("/app/search")}>
                            Open Sourcing
                          </Button>
                        </InlineStack>
                      </BlockStack>
                    </Card>
                  </Grid.Cell>

                  <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                    <Card roundedAbove="sm">
                      <BlockStack gap="200">
                        <InlineStack gap="200" blockAlign="center">
                          <Icon source={LinkIcon} />
                          <Text variant="headingSm" as="h4">
                            Vendor Mapping
                          </Text>
                        </InlineStack>
                        <Text variant="bodySm" tone="subdued" as="p">
                          Link Shopify variants to primary and secondary fallback supplier SKUs.
                        </Text>
                        <InlineStack align="end">
                          <Button onClick={() => navigate("/app/mapping")}>
                            Manage Mappings
                          </Button>
                        </InlineStack>
                      </BlockStack>
                    </Card>
                  </Grid.Cell>

                  <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                    <Card roundedAbove="sm">
                      <BlockStack gap="200">
                        <InlineStack gap="200" blockAlign="center">
                          <Icon source={RefreshIcon} />
                          <Text variant="headingSm" as="h4">
                            Reroute Audit Logs
                          </Text>
                        </InlineStack>
                        <Text variant="bodySm" tone="subdued" as="p">
                          Review automatically rerouted orders due to stockouts or fulfillment failures.
                        </Text>
                        <InlineStack align="end">
                          <Button onClick={() => navigate("/app/rerouted")}>
                            View Audit Logs
                          </Button>
                        </InlineStack>
                      </BlockStack>
                    </Card>
                  </Grid.Cell>

                  <Grid.Cell columnSpan={{ xs: 6, sm: 6, md: 6, lg: 6, xl: 6 }}>
                    <Card roundedAbove="sm">
                      <BlockStack gap="200">
                        <InlineStack gap="200" blockAlign="center">
                          <Icon source={AlertBubbleIcon} />
                          <Text variant="headingSm" as="h4">
                            Price Surge Engine
                          </Text>
                        </InlineStack>
                        <Text variant="bodySm" tone="subdued" as="p">
                          Monitor supplier price hikes and set margins protection thresholds.
                        </Text>
                        <InlineStack align="end">
                          <Button onClick={() => navigate("/app/surged")}>
                            Open Surge Engine
                          </Button>
                        </InlineStack>
                      </BlockStack>
                    </Card>
                  </Grid.Cell>
                </Grid>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}