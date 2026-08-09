import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  DeliveryMethod,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

// Plan Name Constant for app billing checks
export const MONTHLY_PLAN = "Monthly Pro Subscription";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.January25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,

  // --- Mandatory Shopify Billing ---
  billing: {
    [MONTHLY_PLAN]: {
      lineItems: [
        {
          amount: 19.99,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
  },

  // --- Mandatory Compliance & Uninstall Webhooks ---
  webhooks: {
    APP_UNINSTALLED: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks",
    },
    CUSTOMERS_DATA_REQUEST: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks",
    },
    CUSTOMERS_REDACT: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks",
    },
    SHOP_REDACT: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks",
    },
  },

  // --- Auto-register webhooks after auth ---
  hooks: {
    afterAuth: async ({ session }) => {
      shopify.registerWebhooks({ session });
    },
  },

  future: {
    unstable_newEmbeddedAuthStrategy: true,
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.January25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;