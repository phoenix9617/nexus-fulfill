import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { updateShopifyVariantPrice } from "./shopifyPrice.server";

export async function processExpiredSurges(): Promise<{
  processed: number;
  reverted: number;
  errors: number; }> {
  const now = new Date();

  // Fetch all products with an active surge past their reset date
  const expiredProducts = await db.surgedProduct.findMany({
    where: {
      surgeStatus: { in: ["AUTO_SURGED", "FORCE_SURGED"] },
      resetAt: { lte: now },
    },
  });

  let reverted = 0;
  let errors = 0;

  for (const product of expiredProducts) {
    try {
      const { admin } = await unauthenticated.admin(product.shop);

      const targetPrice = Number(product.originalPrice ?? 0);
      if (targetPrice <= 0) {
        console.warn(
          `[Surge Reset] Skipped variant ${product.shopifyVariantId}: Invalid original price ($${targetPrice}).`
        );
        continue;
      }

      const res = await updateShopifyVariantPrice({
        admin,
        variantId: product.shopifyVariantId,
        productId: product.shopifyProductId,
        newPrice: targetPrice,
      });

      if (res.success) {
        await db.surgedProduct.update({
          where: { id: product.id },
          data: {
            currentPrice: targetPrice,
            surgeStatus: "NORMAL",
            salesCount: 0, // Reset cycle sales counter
            surgedAt: null,
            resetAt: null,
          },
        });

        console.log(
          `[Surge Reset] Successfully reverted variant ${product.shopifyVariantId} back to base price $${targetPrice.toFixed(2)}.`
        );
        reverted++;
      } else {
        console.error(
          `[Surge Reset Failed] Could not revert variant ${product.shopifyVariantId}: ${res.error}`
        );
        errors++;
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      console.error(
        `[Surge Reset Exception] Variant ${product.shopifyVariantId}: ${errorMsg}`
      );
      errors++;
    }
  }

  return { processed: expiredProducts.length, reverted, errors };
}