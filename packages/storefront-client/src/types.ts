/**
 * Friendly domain types — ALL derived from `generated/schema.d.ts` (produced
 * from the API's own OpenAPI contract), never hand-duplicated. Most of the
 * API's response schemas are defined inline in their route files (no
 * `.openapi('Name')` call registering a reusable named component — see
 * packages/api/src/routes/*.ts), so openapi-typescript inlines their shapes
 * directly into `paths[...]`. `SuccessBody<Path, Method, Status>` below is
 * the one small piece of hand-written plumbing that extracts those inline
 * shapes back out as named types — it's a type-level lookup, not a
 * duplicated shape: change a Zod schema in the API and these types change
 * with it the next time `pnpm generate` runs.
 *
 * The few schemas that DO have an `.openapi('Name')` (currently
 * `GatewayAttempt`, `GatewayVerifyResult`) are re-exported directly from
 * `components["schemas"]` instead.
 */
import type { components, paths } from './generated/schema.js';

/** The `application/json` response body for `paths[Path][Method]`'s given
 *  status code (200 by default). Resolves to `never` if that path/method/
 *  status combination doesn't exist or isn't JSON — a compile error at the
 *  type alias below, not a silent `any`, if the API's contract changes
 *  shape. */
export type SuccessBody<
  Path extends keyof paths,
  Method extends keyof paths[Path],
  Status extends number = 200,
> = paths[Path][Method] extends { responses: infer R }
  ? Status extends keyof R
    ? R[Status] extends { content: { 'application/json': infer Body } }
      ? Body
      : never
    : never
  : never;

// ─────────────────────────────────────────────────────────────────────────────
// Catalog
// ─────────────────────────────────────────────────────────────────────────────

export type Product = SuccessBody<'/v1/shop/catalog/products/{slug}', 'get'>;
export type ProductSearchResult = SuccessBody<'/v1/shop/catalog/products', 'get'>;
/** A single line of `Product["variants"]` — `availableQuantity` is the
 *  live-stock-derived signal (see the zero-cache-stock rule: it's read fresh
 *  on every product-detail fetch, never cached client-side). */
export type Variant = Product extends { variants: (infer V)[] } ? V : never;
export type Collection = SuccessBody<'/v1/shop/collections/{slug}', 'get'>;
export type CollectionList = SuccessBody<'/v1/shop/catalog/collections', 'get'>;
export type ProductStock = SuccessBody<'/v1/shop/catalog/products/{slug}/stock', 'get'>;

// ─────────────────────────────────────────────────────────────────────────────
// Cart / checkout
// ─────────────────────────────────────────────────────────────────────────────

/** `revision` is the optimistic-concurrency counter — echo it back as
 *  `expectedRevision` on every non-append cart mutation (see cart.ts's
 *  CartConflictOut / the client's cart line-update calls). */
export type Cart = SuccessBody<'/v1/shop/cart', 'post'>;
export type CartLine = Cart extends { lines: (infer L)[] } ? L : never;
export type CartEstimate = SuccessBody<'/v1/shop/cart/estimate', 'post'>;
export type CheckoutResult = SuccessBody<'/v1/shop/checkout', 'post'>;
export type ShopConfig = SuccessBody<'/v1/shop/config', 'get'>;

// ─────────────────────────────────────────────────────────────────────────────
// Gateway payments — the two named components (see generated/schema.d.ts's
// `components.schemas`; every other type here is a path lookup instead).
// ─────────────────────────────────────────────────────────────────────────────

export type GatewayAttempt = components['schemas']['GatewayAttempt'];
export type GatewayVerifyResult = components['schemas']['GatewayVerifyResult'];
/** Every stable code a shop-facing route can put in `error.code` (see
 *  packages/api/src/lib/api-error.ts's SHOP_API_ERROR_CODES, drift-tested
 *  against every route's `errJson` call site). `ApiError.code` itself stays
 *  typed as plain `string` (an admin/legacy call site can still emit an
 *  arbitrary slugified code) — this union is for a consumer that wants to
 *  exhaustively `switch` on the codes the shop surface actually documents. */
export type ApiErrorCode = components['schemas']['ApiErrorCode'];

// ─────────────────────────────────────────────────────────────────────────────
// Auth / account
// ─────────────────────────────────────────────────────────────────────────────

export type Customer = SuccessBody<'/v1/shop/auth/me', 'get'>;
export type AuthResult = SuccessBody<'/v1/shop/auth/login', 'post'>;
export type Address = SuccessBody<'/v1/shop/account/addresses', 'get'> extends (infer A)[] ? A : never;
export type LoyaltyBalance = SuccessBody<'/v1/shop/account/loyalty', 'get'>;

/** List item — order summaries only (no line/payment detail). For the full
 *  breakdown, fetch `Order` by code. */
export type OrderSummary = SuccessBody<'/v1/shop/account/orders', 'get'> extends { items: (infer O)[] }
  ? O
  : never;
/** Full order detail INCLUDING payment facts (method/state/amount per
 *  attempt) — see order-facts.ts's loadOrderPayments, the source of this
 *  shape's `payments` field. */
export type Order = SuccessBody<'/v1/shop/account/orders/{code}', 'get'>;

// ─────────────────────────────────────────────────────────────────────────────
// Content
// ─────────────────────────────────────────────────────────────────────────────

export type BlogPostList = SuccessBody<'/v1/shop/blog', 'get'>;
export type BlogPost = SuccessBody<'/v1/shop/blog/{slug}', 'get'>;
export type StoreIdentity = SuccessBody<'/v1/shop/identity', 'get'>;

// Manifest v2 (catalog.ts) native types are NOT part of this API's OpenAPI
// contract (they're published as static JSON, not an HTTP endpoint) — see
// manifest.ts for those, generated by hand from the API source instead.
export type {
  NativeCatalogManifestV2,
  NativeImage,
  NativeMoney,
  NativeProductDetailV2,
  NativeProductManifestEntryV2,
  NativeVariantV2,
} from './manifest.js';
