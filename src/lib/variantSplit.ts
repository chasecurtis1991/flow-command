import { invoke } from "@tauri-apps/api/core";
import type { StoreId } from "./shopify";

export interface SplitVariant {
  id: string;
  title: string;
  variantTitle: string;
  sku: string | null;
  price: string;
  compareAtPrice: string | null;
  currency: string;
  imageUrl: string | null;
}
export interface SplitPreview {
  planId: string;
  storeId: StoreId;
  productTitle: string;
  variants: SplitVariant[];
  locations: string[];
  warnings: string[];
}
export interface SplitResult {
  productId: string;
  title: string;
  existing: boolean;
  warnings: string[];
  status: string;
}
export const prepareVariantSplit = (storeId: StoreId, productId: string) =>
  invoke<SplitPreview>("prepare_variant_split", { storeId, productId });
export const splitProductVariant = (planId: string, variantId: string) =>
  invoke<SplitResult>("split_product_variant", { planId, variantId });
export const releaseVariantSplit = (planId: string) => invoke<void>("release_variant_split", { planId });
