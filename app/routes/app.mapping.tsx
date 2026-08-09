// app/routes/app.mapping.tsx

import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  IndexTable,
  Badge,
  Button,
  Modal,
  TextField,
  FormLayout,
  BlockStack,
  InlineStack,
  Text,
  Banner,
  EmptyState,
  Icon,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const mappings = await db.vendorMapping.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
  });

  return json({ mappings });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const intent = formData.get("intent") as string;
  const mappingId = formData.get("mappingId") as string;
  const primaryName = formData.get("primaryName") as string;
  const primarySku = formData.get("primarySku") as string;
  const secondaryName = formData.get("secondaryName") as string;
  const secondarySku = formData.get("secondarySku") as string;

  if (!mappingId) {
    return json({ success: false, error: "Missing required mapping ID" }, { status: 400 });
  }

  // Intent 1: Remove backup supplier
  if (intent === "removeBackup") {
    await db.vendorMapping.update({
      where: { id: mappingId },
      data: {
        secondaryVendor: null,
        secondarySupplierSku: null,
      },
    });
    return json({ success: true, message: "Backup supplier removed successfully." });
  }

  // Intent 2: Save/Update mapping suppliers
  if (intent === "saveBackup" || intent === "saveMapping") {
    if (secondarySku && !secondarySku.trim()) {
      return json({ success: false, error: "Secondary SKU cannot be empty string." }, { status: 400 });
    }

    await db.vendorMapping.update({
      where: { id: mappingId },
      data: {
        ...(primaryName ? { primaryVendor: primaryName.trim() } : {}),
        ...(primarySku ? { primarySupplierSku: primarySku.trim() } : {}),
        secondaryVendor: secondaryName ? secondaryName.trim() : "Backup Supplier",
        secondarySupplierSku: secondarySku ? secondarySku.trim() : null,
      },
    });

    return json({ success: true, message: "Supplier routing updated successfully." });
  }

  return json({ success: false, error: "Invalid action intent" }, { status: 400 });
};

export default function VendorMappingPage() {
  const { mappings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [searchQuery, setSearchQuery] = useState("");
  const [activeMappingId, setActiveMappingId] = useState<string | null>(null);
  const [primaryName, setPrimaryName] = useState("");
  const [primarySku, setPrimarySku] = useState("");
  const [backupName, setBackupName] = useState("");
  const [backupSku, setBackupSku] = useState("");

  const isSubmitting = fetcher.state === "submitting";

  const handleOpenModal = (
    id: string,
    curPrimaryName?: string | null,
    curPrimarySku?: string | null,
    curBackupName?: string | null,
    curBackupSku?: string | null
  ) => {
    setActiveMappingId(id);
    setPrimaryName(curPrimaryName || "");
    setPrimarySku(curPrimarySku || "");
    setBackupName(curBackupName || "");
    setBackupSku(curBackupSku || "");
  };

  const handleCloseModal = () => {
    setActiveMappingId(null);
    setPrimaryName("");
    setPrimarySku("");
    setBackupName("");
    setBackupSku("");
  };

  const handleSaveBackup = () => {
    if (!activeMappingId) return;

    fetcher.submit(
      {
        intent: "saveMapping",
        mappingId: activeMappingId,
        primaryName,
        primarySku,
        secondaryName: backupName,
        secondarySku: backupSku,
      },
      { method: "post" }
    );
    handleCloseModal();
  };

  const handleRemoveBackup = (mappingId: string) => {
    fetcher.submit(
      {
        intent: "removeBackup",
        mappingId,
      },
      { method: "post" }
    );
  };

  const filteredMappings = mappings.filter((map) => {
    const query = searchQuery.toLowerCase();
    const prodId = (map.shopifyProductId || "").toLowerCase();
    const pSku = (map.primarySupplierSku || "").toLowerCase();
    const sSku = (map.secondarySupplierSku || "").toLowerCase();
    return prodId.includes(query) || pSku.includes(query) || sSku.includes(query);
  });

  return (
    <Page
      title="Multi-Vendor Mapping Table"
      subtitle="Configure primary and secondary failover suppliers for each SKU"
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {fetcher.data?.error && (
              <Banner tone="critical" title="Error Updating Routing">
                <p>{fetcher.data.error}</p>
              </Banner>
            )}

            {fetcher.data?.success && fetcher.data?.message && (
              <Banner tone="success" title="Success">
                <p>{fetcher.data.message}</p>
              </Banner>
            )}

            <Card padding="0">
              <BlockStack gap="300">
                {mappings.length > 0 && (
                  <div style={{ padding: "16px 16px 0 16px" }}>
                    <TextField
                      label=""
                      labelHidden
                      placeholder="Search mappings by Product ID or SKU..."
                      value={searchQuery}
                      onChange={setSearchQuery}
                      prefix={<Icon source={SearchIcon} />}
                      clearButton
                      onClearButtonClick={() => setSearchQuery("")}
                      autoComplete="off"
                    />
                  </div>
                )}

                {filteredMappings.length === 0 ? (
                  <EmptyState
                    heading={searchQuery ? "No matching mappings found" : "No product mappings found"}
                    image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                  >
                    <p>
                      {searchQuery
                        ? "Try adjusting your search query."
                        : "Import products from CJ Dropshipping or AliExpress to generate target vendor mappings."}
                    </p>
                  </EmptyState>
                ) : (
                  <IndexTable
                    resourceName={{ singular: "Mapping", plural: "Mappings" }}
                    itemCount={filteredMappings.length}
                    headings={[
                      { title: "Shopify Product / Variant" },
                      { title: "Primary Supplier Target" },
                      { title: "Backup Supplier (Failover)" },
                      { title: "Actions" },
                    ]}
                    selectable={false}
                  >
                    {filteredMappings.map((map, index) => (
                      <IndexTable.Row id={map.id} key={map.id} position={index}>
                        <IndexTable.Cell>
                          <Text variant="bodyMd" fontWeight="bold" as="span">
                            {map.shopifyProductId
                              ? map.shopifyProductId.replace("gid://shopify/Product/", "Product #")
                              : "Unlinked Product"}
                          </Text>
                        </IndexTable.Cell>

                        <IndexTable.Cell>
                          <BlockStack gap="100">
                            <Badge tone="info">{map.primaryVendor || "Unassigned"}</Badge>
                            <Text variant="bodySm" as="span">
                              SKU: {map.primarySupplierSku || "N/A"}
                            </Text>
                          </BlockStack>
                        </IndexTable.Cell>

                        <IndexTable.Cell>
                          {map.secondaryVendor ? (
                            <BlockStack gap="100">
                              <Badge tone="success">{map.secondaryVendor}</Badge>
                              <Text variant="bodySm" as="span">
                                SKU: {map.secondarySupplierSku}
                              </Text>
                            </BlockStack>
                          ) : (
                            <Badge tone="attention">No Backup Assigned</Badge>
                          )}
                        </IndexTable.Cell>

                        <IndexTable.Cell>
                          <InlineStack gap="200">
                            <Button
                              onClick={() =>
                                handleOpenModal(
                                  map.id,
                                  map.primaryVendor,
                                  map.primarySupplierSku,
                                  map.secondaryVendor,
                                  map.secondarySupplierSku
                                )
                              }
                              size="slim"
                            >
                              {map.secondaryVendor ? "Edit Routing" : "+ Add Backup"}
                            </Button>

                            {map.secondaryVendor && (
                              <Button
                                tone="critical"
                                variant="plain"
                                size="slim"
                                onClick={() => handleRemoveBackup(map.id)}
                              >
                                Remove Backup
                              </Button>
                            )}
                          </InlineStack>
                        </IndexTable.Cell>
                      </IndexTable.Row>
                    ))}
                  </IndexTable>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      {/* SHARED MODAL FOR BACKUP CONFIGURATION */}
      <Modal
        open={Boolean(activeMappingId)}
        onClose={handleCloseModal}
        title="Configure Vendor Routing & Failover"
        primaryAction={{
          content: "Save Routing",
          loading: isSubmitting,
          onAction: handleSaveBackup,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: handleCloseModal,
          },
        ]}
      >
        <Modal.Section>
          <FormLayout>
            <Text variant="headingSm" as="h3">
              Primary Supplier
            </Text>
            <FormLayout.Group>
              <TextField
                label="Primary Supplier Name"
                value={primaryName}
                onChange={setPrimaryName}
                placeholder="e.g. CJ Dropshipping"
                autoComplete="off"
              />
              <TextField
                label="Primary Supplier SKU"
                value={primarySku}
                onChange={setPrimarySku}
                placeholder="e.g. CJ-SKU-10293"
                autoComplete="off"
              />
            </FormLayout.Group>

            <Text variant="headingSm" as="h3">
              Backup Supplier (Failover)
            </Text>
            <FormLayout.Group>
              <TextField
                label="Backup Supplier Name"
                value={backupName}
                onChange={setBackupName}
                placeholder="e.g. AliExpress"
                autoComplete="off"
              />
              <TextField
                label="Backup Variant SKU"
                value={backupSku}
                onChange={setBackupSku}
                placeholder="e.g. ALT-SKU-9921"
                autoComplete="off"
              />
            </FormLayout.Group>
          </FormLayout>
        </Modal.Section>
      </Modal>
    </Page>
  );
}