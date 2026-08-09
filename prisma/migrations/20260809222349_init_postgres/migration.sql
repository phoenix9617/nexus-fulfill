-- CreateEnum
CREATE TYPE "SurgeStatus" AS ENUM ('NORMAL', 'AUTO_SURGED', 'FORCE_SURGED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSettings" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "cjEmail" TEXT,
    "cjApiKey" TEXT,
    "rapidApiKey" TEXT,
    "aliExpressToken" TEXT,
    "aliExpressApiKey" TEXT,
    "aliExpressSecret" TEXT,
    "failoverEnabled" BOOLEAN NOT NULL DEFAULT true,
    "marginThreshold" DOUBLE PRECISION NOT NULL DEFAULT 15.0,
    "priceStrategy" TEXT NOT NULL DEFAULT 'auto_adjust',
    "pricingStrategy" TEXT NOT NULL DEFAULT 'multiplier',
    "pricingValue" TEXT NOT NULL DEFAULT '1.4',
    "markupEnabled" BOOLEAN NOT NULL DEFAULT true,
    "defaultSurgeMargin" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "autoSyncEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorMapping" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "primaryVendor" TEXT NOT NULL,
    "primarySupplierSku" TEXT NOT NULL,
    "secondaryVendor" TEXT,
    "secondarySupplierSku" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RerouteLog" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "originalVendor" TEXT NOT NULL,
    "newVendor" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RerouteLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SurgeSetting" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "autoSalesThreshold" INTEGER NOT NULL DEFAULT 10,
    "autoSurgePercentage" DOUBLE PRECISION NOT NULL DEFAULT 10.0,
    "autoResetDays" INTEGER NOT NULL DEFAULT 7,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SurgeSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SurgedProduct" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sku" TEXT DEFAULT '',
    "originalPrice" DOUBLE PRECISION NOT NULL,
    "currentPrice" DOUBLE PRECISION NOT NULL,
    "salesCount" INTEGER NOT NULL DEFAULT 0,
    "surgeStatus" "SurgeStatus" NOT NULL DEFAULT 'NORMAL',
    "surgePercentage" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "autoSurgeThreshold" INTEGER NOT NULL DEFAULT 10,
    "resetDays" INTEGER NOT NULL DEFAULT 7,
    "surgedAt" TIMESTAMP(3),
    "resetAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SurgedProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportedProduct" (
    "id" TEXT NOT NULL,
    "shop" TEXT,
    "shopifyProductId" TEXT,
    "title" TEXT NOT NULL,
    "vendor" TEXT,
    "category" TEXT,
    "image" TEXT,
    "landedCost" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "originalRetailPrice" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "retailPrice" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "stockQuantity" INTEGER NOT NULL DEFAULT 0,
    "activeSurgePercentage" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "syncStatus" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportedProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportedVariant" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "shopifyVariantId" TEXT,
    "inventoryItemId" TEXT,
    "cjVid" TEXT,
    "title" TEXT NOT NULL,
    "sku" TEXT,
    "image" TEXT,
    "price" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "originalPrice" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "landedCost" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "stockQuantity" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportedVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FulfilledOrder" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "cjOrderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "trackingNumber" TEXT,
    "trackingUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FulfilledOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "AppSettings_shop_key" ON "AppSettings"("shop");

-- CreateIndex
CREATE INDEX "VendorMapping_shop_idx" ON "VendorMapping"("shop");

-- CreateIndex
CREATE INDEX "VendorMapping_shopifyProductId_idx" ON "VendorMapping"("shopifyProductId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorMapping_shop_shopifyProductId_key" ON "VendorMapping"("shop", "shopifyProductId");

-- CreateIndex
CREATE INDEX "RerouteLog_shop_idx" ON "RerouteLog"("shop");

-- CreateIndex
CREATE INDEX "RerouteLog_orderId_idx" ON "RerouteLog"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "SurgeSetting_shop_key" ON "SurgeSetting"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "SurgedProduct_shopifyVariantId_key" ON "SurgedProduct"("shopifyVariantId");

-- CreateIndex
CREATE INDEX "SurgedProduct_shop_idx" ON "SurgedProduct"("shop");

-- CreateIndex
CREATE INDEX "SurgedProduct_sku_idx" ON "SurgedProduct"("sku");

-- CreateIndex
CREATE INDEX "SurgedProduct_surgeStatus_idx" ON "SurgedProduct"("surgeStatus");

-- CreateIndex
CREATE INDEX "SurgedProduct_resetAt_surgeStatus_idx" ON "SurgedProduct"("resetAt", "surgeStatus");

-- CreateIndex
CREATE UNIQUE INDEX "ImportedProduct_shopifyProductId_key" ON "ImportedProduct"("shopifyProductId");

-- CreateIndex
CREATE INDEX "ImportedProduct_shop_idx" ON "ImportedProduct"("shop");

-- CreateIndex
CREATE INDEX "ImportedProduct_activeSurgePercentage_idx" ON "ImportedProduct"("activeSurgePercentage");

-- CreateIndex
CREATE INDEX "ImportedProduct_syncStatus_idx" ON "ImportedProduct"("syncStatus");

-- CreateIndex
CREATE UNIQUE INDEX "ImportedVariant_shopifyVariantId_key" ON "ImportedVariant"("shopifyVariantId");

-- CreateIndex
CREATE INDEX "ImportedVariant_productId_idx" ON "ImportedVariant"("productId");

-- CreateIndex
CREATE INDEX "ImportedVariant_sku_idx" ON "ImportedVariant"("sku");

-- CreateIndex
CREATE INDEX "ImportedVariant_shopifyVariantId_idx" ON "ImportedVariant"("shopifyVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "FulfilledOrder_shopifyOrderId_key" ON "FulfilledOrder"("shopifyOrderId");

-- CreateIndex
CREATE INDEX "FulfilledOrder_shop_idx" ON "FulfilledOrder"("shop");

-- CreateIndex
CREATE INDEX "FulfilledOrder_status_idx" ON "FulfilledOrder"("status");

-- CreateIndex
CREATE INDEX "FulfilledOrder_cjOrderId_idx" ON "FulfilledOrder"("cjOrderId");

-- AddForeignKey
ALTER TABLE "ImportedVariant" ADD CONSTRAINT "ImportedVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ImportedProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
