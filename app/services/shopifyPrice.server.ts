import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

export interface UpdateShopifyVariantPriceParams {
  admin: AdminApiContext;
  variantId: string;
  newPrice: number;
  compareAtPrice?: number | null;
  productId?: string; // Optional parent product GID enables bulk update strategy
}

export interface UpdateShopifyVariantPriceResult {
  success: boolean;
  error?: string;
  price?: number;
  compareAtPrice?: number | null;
}

interface ShopifyUserError {
  field?: string[];
  message: string;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface BulkUpdateData {
  productVariantsBulkUpdate?: {
    productVariants?: Array<{
      id: string;
      price: string;
      compareAtPrice: string | null;
    }>;
    userErrors?: ShopifyUserError[];
  };
}

interface SingleUpdateData {
  productVariantUpdate?: {
    productVariant?: {
      id: string;
      price: string;
      compareAtPrice: string | null;
    };
    userErrors?: ShopifyUserError[];
  };
}

const BULK_UPDATE_MUTATION = `#graphql
  mutation updateVariantPriceBulk($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        price
        compareAtPrice
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const SINGLE_UPDATE_MUTATION = `#graphql
  mutation updateSingleVariantPrice($input: ProductVariantInput!) {
    productVariantUpdate(input: $input) {
      productVariant {
        id
        price
        compareAtPrice
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Updates a product variant's price in Shopify using GraphQL Admin API.
 * Uses productVariantsBulkUpdate if productId is available, automatically falling
 * back to productVariantUpdate if required.
 */
export async function updateShopifyVariantPrice({
  admin,
  variantId,
  newPrice,
  compareAtPrice,
  productId,
}: UpdateShopifyVariantPriceParams): Promise<UpdateShopifyVariantPriceResult> {
  // Defensive guard against invalid numerical values
  const safeNewPrice = typeof newPrice === "number" && !Number.isNaN(newPrice) ? newPrice : 0;
  const formattedPrice = safeNewPrice.toFixed(2);

  let formattedComparePrice: string | null | undefined = undefined;
  if (typeof compareAtPrice === "number" && !Number.isNaN(compareAtPrice)) {
    formattedComparePrice = compareAtPrice.toFixed(2);
  } else if (compareAtPrice === null) {
    formattedComparePrice = null;
  }

  // 1. Primary Strategy: Bulk update if parent productId GID is provided
  if (productId) {
    try {
      const variantInput: { id: string; price: string; compareAtPrice?: string | null } = {
        id: variantId,
        price: formattedPrice,
      };

      if (formattedComparePrice !== undefined) {
        variantInput.compareAtPrice = formattedComparePrice;
      }

      const response = await admin.graphql(BULK_UPDATE_MUTATION, {
        variables: {
          productId,
          variants: [variantInput],
        },
      });

      const responseJson = (await response.json()) as GraphQLResponse<BulkUpdateData>;

      if (responseJson.errors && responseJson.errors.length > 0) {
        const topLevelError = responseJson.errors.map((e) => e.message).join(", ");
        console.warn(
          `[Shopify Price Update] Bulk GraphQL error for variant ${variantId}: ${topLevelError}. Falling back to single mutation...`
        );
      } else {
        const userErrors = responseJson.data?.productVariantsBulkUpdate?.userErrors || [];

        if (userErrors.length === 0) {
          const updatedVariant = responseJson.data?.productVariantsBulkUpdate?.productVariants?.[0];
          console.log(
            `[Shopify Price Update] Successfully bulk-updated variant ${variantId} to $${formattedPrice}`
          );
          return {
            success: true,
            price: updatedVariant?.price ? parseFloat(updatedVariant.price) : safeNewPrice,
            compareAtPrice: updatedVariant?.compareAtPrice
              ? parseFloat(updatedVariant.compareAtPrice)
              : formattedComparePrice === null
              ? null
              : undefined,
          };
        }

        const errorMsg = userErrors
          .map((e) => `${e.field?.join(".") || "field"}: ${e.message}`)
          .join(", ");
        console.warn(
          `[Shopify Price Update] Bulk userErrors for variant ${variantId}: ${errorMsg}. Falling back to single mutation...`
        );
      }
    } catch (error: unknown) {
      const errMessage = error instanceof Error ? error.message : "Unknown error";
      console.warn(
        `[Shopify Price Update] Bulk mutation exception for variant ${variantId}: ${errMessage}. Falling back to single mutation...`
      );
    }
  }

  // 2. Secondary Strategy: Update directly via single productVariantUpdate
  try {
    const singleInput: { id: string; price: string; compareAtPrice?: string | null } = {
      id: variantId,
      price: formattedPrice,
    };

    if (formattedComparePrice !== undefined) {
      singleInput.compareAtPrice = formattedComparePrice;
    }

    const response = await admin.graphql(SINGLE_UPDATE_MUTATION, {
      variables: { input: singleInput },
    });

    const responseJson = (await response.json()) as GraphQLResponse<SingleUpdateData>;

    if (responseJson.errors && responseJson.errors.length > 0) {
      const topLevelError = responseJson.errors.map((e) => e.message).join(", ");
      console.error(`[Shopify Price Update] Single GraphQL error for variant ${variantId}:`, topLevelError);
      return { success: false, error: topLevelError };
    }

    const userErrors = responseJson.data?.productVariantUpdate?.userErrors || [];

    if (userErrors.length > 0) {
      const errorMsg = userErrors
        .map((e) => `${e.field?.join(".") || "field"}: ${e.message}`)
        .join(", ");
      console.error(`[Shopify Price Update] Single userErrors for variant ${variantId}:`, errorMsg);
      return { success: false, error: errorMsg };
    }

    const updatedVariant = responseJson.data?.productVariantUpdate?.productVariant;
    console.log(
      `[Shopify Price Update] Successfully updated single variant ${variantId} to $${formattedPrice}`
    );
    return {
      success: true,
      price: updatedVariant?.price ? parseFloat(updatedVariant.price) : safeNewPrice,
      compareAtPrice: updatedVariant?.compareAtPrice
        ? parseFloat(updatedVariant.compareAtPrice)
        : formattedComparePrice === null
        ? null
        : undefined,
    };
  } catch (error: unknown) {
    const errMessage = error instanceof Error ? error.message : "GraphQL execution failed";
    console.error(`[Shopify Price Update] Single mutation failed for variant ${variantId}:`, error);
    return { success: false, error: errMessage };
  }
}