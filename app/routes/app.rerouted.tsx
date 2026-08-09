// app/routes/app.rerouted.tsx

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  IndexTable,
  Badge,
  Text,
  BlockStack,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import db from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Fetch failover audit logs sorted by newest first
  const logs = await db.rerouteLog.findMany({
    where: { shop: session.shop },
    orderBy: { timestamp: "desc" },
  });

  return json({ logs });
};

export default function ReroutedOrdersPage() {
  const { logs } = useLoaderData<typeof loader>();

  return (
    <Page>
      <TitleBar title="Order Reroute Audit Logs" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <Banner title="Automated Failover Engine Active" tone="info">
              <p>
                NexusFulfill continuously monitors order line items and primary supplier stock levels. If a primary vendor experiences stockouts or price spikes exceeding your margin boundaries, orders are automatically rerouted here.
              </p>
            </Banner>
          </Layout.Section>

          <Layout.Section>
            <Card padding="0">
              <IndexTable
                resourceName={{ singular: "reroute log", plural: "reroute logs" }}
                itemCount={logs.length}
                headings={[
                  { title: "Order ID" },
                  { title: "Original Vendor" },
                  { title: "Failover Target" },
                  { title: "Reason / Trigger" },
                  { title: "Timestamp" },
                ]}
                selectable={false}
              >
                {logs.length === 0 ? (
                  <IndexTable.Row id="empty" position={0}>
                    <IndexTable.Cell colSpan={5}>
                      <Text as="p" tone="subdued" alignment="center">
                        No orders have required failover rerouting yet.
                      </Text>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ) : (
                  logs.map((log, index) => (
                    <IndexTable.Row id={log.id} key={log.id} position={index}>
                      <IndexTable.Cell>
                        <Text variant="bodyMd" fontWeight="bold">
                          {log.orderId}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Badge tone="critical">{log.originalVendor}</Badge>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Badge tone="success">{log.newVendor}</Badge>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text variant="bodySm">{log.reason}</Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text variant="bodySm" tone="subdued">
                          {new Date(log.timestamp).toLocaleString()}
                        </Text>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))
                )}
              </IndexTable>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}