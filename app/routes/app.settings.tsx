// app/routes/app.settings.tsx

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useActionData, useSubmit, useNavigation } from "@remix-run/react";
import { useState, useCallback, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  TextField,
  Button,
  InlineStack,
  Divider,
  Select,
  Checkbox,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import db from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let settings = await db.appSettings.findUnique({
    where: { shop },
  });

  if (!settings) {
    settings = await db.appSettings.create({
      data: {
        shop,
      },
    });
  }

  const surgeSetting = await db.surgeSetting.findUnique({
    where: { shop },
  });

  return json({
    settings: {
      cjEmail: settings.cjEmail || "",
      cjApiKey: settings.cjApiKey || "",
      rapidApiKey: settings.rapidApiKey || "",
      aliExpressToken: settings.aliExpressToken || "",
      failoverEnabled: settings.failoverEnabled ?? true,
      marginThreshold: settings.marginThreshold ?? 15,
      priceStrategy: settings.priceStrategy || "auto_adjust",
      cronSecret: process.env.CRON_SECRET || "",
    },
    surgeSetting: {
      isEnabled: surgeSetting?.isEnabled ?? true,
      autoSalesThreshold: surgeSetting?.autoSalesThreshold ?? 10,
      autoSurgePercentage: surgeSetting?.autoSurgePercentage ?? 10.0,
      autoResetDays: surgeSetting?.autoResetDays ?? 7,
    },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();

  // App Settings Inputs
  const cjEmail = String(formData.get("cjEmail") || "").trim();
  const cjApiKey = String(formData.get("cjApiKey") || "").trim();
  const rapidApiKey = String(formData.get("rapidApiKey") || "").trim();
  const aliExpressToken = String(formData.get("aliExpressToken") || rapidApiKey).trim();
  const failoverEnabled = formData.get("failoverEnabled") === "true";
  const marginThreshold = parseFloat(String(formData.get("marginThreshold") || "15"));
  const priceStrategy = String(formData.get("priceStrategy") || "auto_adjust");

  // Surge Settings Inputs
  const surgeIsEnabled = formData.get("surgeIsEnabled") === "true";
  const autoSalesThreshold = parseInt(String(formData.get("autoSalesThreshold") || "10"), 10);
  const autoSurgePercentage = parseFloat(String(formData.get("autoSurgePercentage") || "10.0"));
  const autoResetDays = parseInt(String(formData.get("autoResetDays") || "7"), 10);

  // Validation
  if (isNaN(marginThreshold) || marginThreshold < 0) {
    return json({ success: false, error: "Margin threshold must be a valid non-negative number." }, { status: 400 });
  }

  if (isNaN(autoSalesThreshold) || autoSalesThreshold < 1) {
    return json({ success: false, error: "Sales threshold must be at least 1 order." }, { status: 400 });
  }

  if (isNaN(autoSurgePercentage) || autoSurgePercentage < 0) {
    return json({ success: false, error: "Surge percentage must be a non-negative number." }, { status: 400 });
  }

  try {
    // 1. Update App Settings
    await db.appSettings.upsert({
      where: { shop },
      update: {
        cjEmail,
        cjApiKey,
        rapidApiKey,
        aliExpressToken,
        failoverEnabled,
        marginThreshold,
        priceStrategy,
      },
      create: {
        shop,
        cjEmail,
        cjApiKey,
        rapidApiKey,
        aliExpressToken,
        failoverEnabled,
        marginThreshold,
        priceStrategy,
      },
    });

    // 2. Update Surge Settings
    await db.surgeSetting.upsert({
      where: { shop },
      update: {
        isEnabled: surgeIsEnabled,
        autoSalesThreshold,
        autoSurgePercentage,
        autoResetDays,
      },
      create: {
        shop,
        isEnabled: surgeIsEnabled,
        autoSalesThreshold,
        autoSurgePercentage,
        autoResetDays,
      },
    });

    return json({ success: true, error: null });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "An unexpected error occurred while saving settings.";
    console.error("[Settings Action Error]:", error);
    return json({ success: false, error: message }, { status: 500 });
  }
};

export default function SettingsPage() {
  const { settings, surgeSetting } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSaving = navigation.state === "submitting";

  // Supplier & Security State
  const [cjEmail, setCjEmail] = useState(settings.cjEmail);
  const [cjApiKey, setCjApiKey] = useState(settings.cjApiKey);
  const [rapidApiKey, setRapidApiKey] = useState(settings.rapidApiKey || settings.aliExpressToken);
  const [cronSecret, setCronSecret] = useState(settings.cronSecret);
  const [failoverEnabled, setFailoverEnabled] = useState(settings.failoverEnabled);
  const [marginThreshold, setMarginThreshold] = useState(String(settings.marginThreshold));
  const [priceStrategy, setPriceStrategy] = useState(settings.priceStrategy);

  // Dynamic Surge Engine State
  const [surgeIsEnabled, setSurgeIsEnabled] = useState(surgeSetting.isEnabled);
  const [autoSalesThreshold, setAutoSalesThreshold] = useState(String(surgeSetting.autoSalesThreshold));
  const [autoSurgePercentage, setAutoSurgePercentage] = useState(String(surgeSetting.autoSurgePercentage));
  const [autoResetDays, setAutoResetDays] = useState(String(surgeSetting.autoResetDays));

  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    if (navigation.state === "idle" && actionData) {
      setShowBanner(true);
      if (actionData.success) {
        const timer = setTimeout(() => setShowBanner(false), 4000);
        return () => clearTimeout(timer);
      }
    }
  }, [navigation.state, actionData]);

  const handleSave = useCallback(() => {
    const formData = new FormData();
    formData.append("cjEmail", cjEmail);
    formData.append("cjApiKey", cjApiKey);
    formData.append("rapidApiKey", rapidApiKey);
    formData.append("aliExpressToken", rapidApiKey);
    formData.append("cronSecret", cronSecret);
    formData.append("failoverEnabled", String(failoverEnabled));
    formData.append("marginThreshold", marginThreshold);
    formData.append("priceStrategy", priceStrategy);

    formData.append("surgeIsEnabled", String(surgeIsEnabled));
    formData.append("autoSalesThreshold", autoSalesThreshold);
    formData.append("autoSurgePercentage", autoSurgePercentage);
    formData.append("autoResetDays", autoResetDays);

    submit(formData, { method: "post" });
  }, [
    cjEmail,
    cjApiKey,
    rapidApiKey,
    cronSecret,
    failoverEnabled,
    marginThreshold,
    priceStrategy,
    surgeIsEnabled,
    autoSalesThreshold,
    autoSurgePercentage,
    autoResetDays,
    submit,
  ]);

  const priceStrategyOptions = [
    { label: "Auto-Adjust Retail Price to Protect Margin", value: "auto_adjust" },
    { label: "Notify Only (Pause Orders on Cost Surge)", value: "notify_only" },
    { label: "Absorb Cost Surge (Maintain Fixed Customer Price)", value: "absorb" },
  ];

  return (
    <Page>
      <TitleBar title="Settings & API Configuration" />
      <BlockStack gap="500">
        {showBanner && actionData?.success && (
          <Banner title="Settings saved" tone="success" onDismiss={() => setShowBanner(false)}>
            <p>Your API credentials, dynamic surge rules, cron tokens, and failover options have been updated.</p>
          </Banner>
        )}

        {showBanner && actionData?.success === false && (
          <Banner title="Failed to save settings" tone="critical" onDismiss={() => setShowBanner(false)}>
            <p>{actionData.error || "An unexpected error occurred while saving your settings."}</p>
          </Banner>
        )}

        <Layout>
          {/* Supplier API Integrations */}
          <Layout.Section>
            <Card padding="500">
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  🔑 Supplier API Integrations
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Connect your primary fulfillment provider accounts for real-time inventory sync and automated order routing.
                </Text>

                <TextField
                  label="CJ Dropshipping Account Email"
                  value={cjEmail}
                  onChange={setCjEmail}
                  autoComplete="email"
                  type="email"
                  placeholder="user@example.com"
                  helpText="The account email associated with your CJ Dropshipping API user."
                />

                <TextField
                  label="CJ Dropshipping API Key / Password"
                  value={cjApiKey}
                  onChange={setCjApiKey}
                  autoComplete="off"
                  type="password"
                  placeholder="cj_live_..."
                  helpText="Found in your CJ Dropshipping Account Settings > API Access."
                />

                <TextField
                  label="RapidAPI Key (AliExpress Datahub)"
                  value={rapidApiKey}
                  onChange={setRapidApiKey}
                  autoComplete="off"
                  type="password"
                  placeholder="34a9b..."
                  helpText="Found in your RapidAPI Dashboard under the AliExpress Datahub endpoint subscription."
                />
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* Dynamic Failover & Margin Rules */}
          <Layout.Section>
            <Card padding="500">
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  ⚡ Dynamic Failover & Margin Rules
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Configure automated fallback routing when primary vendors run out of stock or increase prices.
                </Text>

                <Checkbox
                  label="Enable Automatic Failover Routing"
                  checked={failoverEnabled}
                  onChange={setFailoverEnabled}
                  helpText="Automatically reroute orders to secondary suppliers if primary stock drops to 0."
                />

                <Divider />

                <TextField
                  label="Minimum Profit Margin Threshold (%)"
                  type="number"
                  value={marginThreshold}
                  onChange={setMarginThreshold}
                  autoComplete="off"
                  suffix="%"
                  helpText="If supplier price changes reduce your net profit margin below this level, the surge engine triggers."
                />

                <Select
                  label="Cost Surge Action Strategy"
                  options={priceStrategyOptions}
                  onChange={setPriceStrategy}
                  value={priceStrategy}
                />
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* Auto-Surge Pricing Engine Defaults */}
          <Layout.Section>
            <Card padding="500">
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  📈 Auto-Surge Pricing Engine Defaults
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Configure high-demand sales volume triggers to automatically mark up variant prices.
                </Text>

                <Checkbox
                  label="Enable Sales Volume Auto-Surge Engine"
                  checked={surgeIsEnabled}
                  onChange={setSurgeIsEnabled}
                  helpText="Automatically surge variant retail prices when order velocity crosses threshold."
                />

                <Divider />

                <TextField
                  label="Sales Volume Threshold"
                  type="number"
                  value={autoSalesThreshold}
                  onChange={setAutoSalesThreshold}
                  autoComplete="off"
                  helpText="Number of sales required before a product enters surge pricing."
                  disabled={!surgeIsEnabled}
                />

                <TextField
                  label="Surge Markup Percentage (%)"
                  type="number"
                  value={autoSurgePercentage}
                  onChange={setAutoSurgePercentage}
                  autoComplete="off"
                  suffix="%"
                  helpText="Percentage price increase applied during surge status."
                  disabled={!surgeIsEnabled}
                />

                <TextField
                  label="Surge Duration (Days)"
                  type="number"
                  value={autoResetDays}
                  onChange={setAutoResetDays}
                  autoComplete="off"
                  suffix="Days"
                  helpText="Duration before surge pricing automatically reverts to normal baseline."
                  disabled={!surgeIsEnabled}
                />
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* Background Cron Security */}
          <Layout.Section>
            <Card padding="500">
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  🔐 Cron Security Secret Token
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Secures background task execution endpoints (<code>/api/cron/reset-prices</code> and <code>/api/cron/tracking</code>).
                </Text>

                <TextField
                  label="Cron Secret Key"
                  type="password"
                  value={cronSecret}
                  onChange={setCronSecret}
                  autoComplete="off"
                  placeholder="enter_secure_secret_key"
                  helpText="Must match the Authorization Bearer or ?key= query parameter used in your external cron service."
                />
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* Action Footer */}
          <Layout.Section>
            <InlineStack align="end">
              <Button
                variant="primary"
                size="large"
                loading={isSaving}
                onClick={handleSave}
              >
                Save Settings
              </Button>
            </InlineStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}