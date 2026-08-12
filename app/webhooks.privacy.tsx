// app/routes/privacy.tsx

import { json, type LoaderFunctionArgs } from "@remix-run/node";

export async function loader({ request }: LoaderFunctionArgs) {
  return json({});
}

export default function PrivacyPolicyPage() {
  return (
    <div style={{ maxWidth: "800px", margin: "40px auto", padding: "0 20px", fontFamily: "system-ui, sans-serif", lineHeight: "1.6", color: "#333" }}>
      <h1 style={{ fontSize: "2rem", marginBottom: "8px" }}>Privacy Policy</h1>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>Last Updated: August 12, 2026</p>

      <hr style={{ border: "0", borderTop: "1px solid #eee", margin: "20px 0" }} />

      <section style={{ marginBottom: "24px" }}>
        <h2>1. Information We Collect</h2>
        <p>When you install <strong>CJ Auto-Fulfill & Surge Pro</strong>, we access certain Shopify store data via official GraphQL Admin APIs to provide our services:</p>
        <ul>
          <li><strong>Merchant Store Information:</strong> Store domain, myshopify.com URL, and access tokens.</li>
          <li><strong>Order & Shipping Data:</strong> Order IDs, line items, supplier SKUs, and buyer shipping addresses necessary for automated order dispatch.</li>
          <li><strong>Product & Variant Data:</strong> Product IDs, variant IDs, inventory status, base prices, compare-at prices, and surge threshold counts.</li>
          <li><strong>Third-Party Credentials:</strong> Encrypted CJ Dropshipping API keys provided by the merchant.</li>
        </ul>
      </section>

      <section style={{ marginBottom: "24px" }}>
        <h2>2. How We Use Your Information</h2>
        <p>Collected data is used strictly for core app operations:</p>
        <ul>
          <li>Fulfilling qualifying supplier orders directly via CJ Dropshipping API hooks.</li>
          <li>Calculating and applying automated price surge rules based on item sales thresholds.</li>
          <li>Executing automated scheduled price resets to baseline prices.</li>
        </ul>
      </section>

      <section style={{ marginBottom: "24px" }}>
        <h2>3. Data Sharing & Third Parties</h2>
        <p>We do not sell, rent, or trade merchant or buyer data. Order and fulfillment data is transmitted exclusively to <strong>CJ Dropshipping</strong> endpoints solely to facilitate dropshipping order fulfillment requested by the merchant.</p>
      </section>

      <section style={{ marginBottom: "24px" }}>
        <h2>4. Data Retention & Mandatory Deletion (GDPR / CCPA)</h2>
        <p>We strictly adhere to global privacy regulations, including GDPR and CCPA:</p>
        <ul>
          <li><strong>Customer Requests:</strong> Customer data redaction requests received via Shopify webhooks are processed within 30 days.</li>
          <li><strong>App Uninstallation:</strong> When you uninstall the app, or upon receiving a <code>SHOP_REDACT</code> request from Shopify, all store sessions, surge configurations, and product records are permanently purged from our databases within 48 hours.</li>
        </ul>
      </section>

      <section style={{ marginBottom: "24px" }}>
        <h2>5. Contact & Support</h2>
        <p>If you have questions regarding this Privacy Policy or wish to exercise your privacy rights, please contact our support team at <strong>support@vyronclothing.com</strong>.</p>
      </section>
    </div>
  );
}