/**
 * Types for the native catalog manifest v2 (packages/api/src/manifest/
 * catalog.ts's `NativeProductManifestEntryV2`/`NativeProductDetailV2`).
 *
 * The manifest is published as static JSON files (shop-catalog.v2.json,
 * products-v2/{slug}.json under the API's CATALOG_DIR) served directly by
 * the ops layer (nginx/CDN), not over a documented HTTP endpoint — so
 * unlike every other type in this package, these are NOT generated from
 * `/v1/openapi.json` (openapi-typescript has nothing to read). They're
 * mirrored here by hand from the API's source and MUST be kept in sync
 * manually when catalog.ts's native shapes change.
 *
 * Followup: extract these into `@sellright/shared` (a real, already
 * `exports`-based workspace package both `@sellright/api` and this package
 * could depend on with no fragile relative-path source coupling) so they
 * stop being two hand-synced copies. Deferred out of this PR to avoid
 * widening its footprint into the API's dependency graph.
 *
 * `inStock` is the ONLY availability signal on either shape — never a stock
 * number. Consuming code must still re-check LIVE stock at cart/checkout
 * regardless of what the manifest said (the zero-cache-stock rule applies to
 * every consumer of this manifest, not just the API that generates it).
 */

export interface NativeMoney {
  amount: number;
  currency: string;
  taxInclusive: boolean;
}

export interface NativeImage {
  url: string;
  alt: string | null;
  position: number;
}

export interface NativeVariantV2 {
  id: string;
  sku: string;
  name: string;
  price: NativeMoney;
  compareAtPrice: NativeMoney | null;
  salePrice: NativeMoney | null;
  preOrderPrice: NativeMoney | null;
  isPreOrder: boolean;
  shipDate: string | null;
  // position: merchant-controlled order (migration 0080) — groupPosition
  // orders the groups, position orders values within that group. Arrives
  // pre-sorted by both; carried through so a consumer that re-groups
  // client-side still sorts correctly without re-deriving order itself.
  options: Array<{ group: string; groupId: string; groupPosition: number; code: string; name: string; position: number }>;
  images: NativeImage[];
}

export interface NativeProductManifestEntryV2 {
  id: string;
  slug: string;
  name: string;
  tags: string[];
  priceRange: { min: NativeMoney; max: NativeMoney };
  /** Opt-in display range including disabled choices; never a purchase quote. */
  displayPriceRange?: { min: NativeMoney; max: NativeMoney };
  hasMultiplePrices: boolean;
  inStock: boolean;
  images: NativeImage[];
  /** Approved-review aggregate (REWARDS-1); present only when the product has reviews. */
  rating?: { average: number; count: number };
}

export interface NativeProductDetailV2 extends NativeProductManifestEntryV2 {
  lastUpdated: string;
  description: string | null;
  variants: NativeVariantV2[];
  /** Opt-in disabled choices for crossed-out display only. Never purchasable. */
  displayOnlyVariants?: NativeVariantV2[];
}

export interface NativeCatalogManifestV2 {
  lastUpdated: string;
  totalItems: number;
  defaultSort: string;
  products: NativeProductManifestEntryV2[];
}
