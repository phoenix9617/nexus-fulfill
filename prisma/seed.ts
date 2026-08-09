// prisma/seed.ts

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const shop = "quickstart-demo.myshopify.com";

  console.log("🌱 Seeding NexusFulfill database...");

  // Available client models diagnostic check
  const availableModels = Object.keys(prisma).filter(
    (key) => !key.startsWith("_") && !key.startsWith("$")
  );
  console.log("Detected Prisma Models:", availableModels);

  // Helper to grab model safely
  const getModel = (name: string) => {
    const target = (prisma as any)[name];
    if (!target) {
      throw new Error(
        `Model '${name}' not found on PrismaClient. Available models are: ${availableModels.join(", ")}`
      );
    }
    return target;
  };

  // Find models by standard Prisma camelCase or PascalCase names
  const appSettings =
    (prisma as any).appSettings || (prisma as any).AppSettings;
  const vendorMapping =
    (prisma as any).vendorMapping || (prisma as any).VendorMapping;
  const rerouteLog =
    (prisma as any).rerouteLog || (prisma as any).RerouteLog;
  const costSurgeLog =
    (prisma as any).costSurgeLog || (prisma as any).CostSurgeLog;

  // 1. App Settings
  if (appSettings) {
    await appSettings.upsert({
      where: { shop },
      update: {},
      create: {
        shop,
        cjApiKey: "cj_demo_key_992183",
        aliExpressToken: "ali_demo_token_88123",
        failoverEnabled: true,
        marginThreshold: 15.0,
        priceStrategy: "auto_adjust",
      },
    });
    console.log("✔ AppSettings seeded");
  }

  // 2. Vendor Mappings
  let mapping1: any;
  let mapping2: any;

  if (vendorMapping) {
    mapping1 = await vendorMapping.create({
      data: {
        shop,
        shopifyProductId: "gid://shopify/Product/881234123",
        primaryVendor: "CJ Dropshipping",
        primarySupplierSku: "CJ-MOUSE-01",
        secondaryVendor: "AliExpress Backup",
        secondarySupplierSku: "ALI-MOUSE-99",
      },
    });

    mapping2 = await vendorMapping.create({
      data: {
        shop,
        shopifyProductId: "gid://shopify/Product/881234124",
        primaryVendor: "AliExpress Primary",
        primarySupplierSku: "ALI-HUB-44",
        secondaryVendor: "CJ Dropshipping",
        secondarySupplierSku: "CJ-HUB-88",
      },
    });
    console.log("✔ VendorMappings seeded");
  }

  // 3. Reroute Logs
  if (rerouteLog) {
    await rerouteLog.create({
      data: {
        shop,
        orderId: "#1001",
        originalVendor: "CJ Dropshipping",
        newVendor: "AliExpress Backup",
        reason: "Primary vendor out of stock (CJ-MOUSE-01)",
      },
    });

    await rerouteLog.create({
      data: {
        shop,
        orderId: "#1004",
        originalVendor: "AliExpress Primary",
        newVendor: "CJ Dropshipping",
        reason: "Shipping delay alert on primary route",
      },
    });
    console.log("✔ RerouteLogs seeded");
  }

  // 4. Cost Surge Logs
  if (costSurgeLog && mapping1 && mapping2) {
    await costSurgeLog.create({
      data: {
        shop,
        productId: mapping1.shopifyProductId,
        productMappingId: mapping1.id,
        previousCost: 12.0,
        newCost: 16.5,
        previousRetail: 24.99,
        newRetail: 29.99,
      },
    });

    await costSurgeLog.create({
      data: {
        shop,
        productId: mapping2.shopifyProductId,
        productMappingId: mapping2.id,
        previousCost: 8.5,
        newCost: 11.2,
        previousRetail: 19.99,
        newRetail: 22.99,
      },
    });
    console.log("✔ CostSurgeLogs seeded");
  }

  console.log("🎉 Seeding complete!");
}

main()
  .catch((e) => {
    console.error("❌ Seed error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });