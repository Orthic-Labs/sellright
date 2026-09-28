/**
 * Native cart types — derived directly from `@sellright/storefront-client`'s
 * generated OpenAPI paths (re-exported by `~/sellright/client`) so they can
 * never drift from the live API. The API's OpenAPI document has no named
 * `components.schemas` entries (every shape is inlined per-path), so
 * `ServerCart`/`ServerCartLine` are extracted by indexing into
 * `paths[...]['...']['responses'][200]['content']['application/json']`
 * instead of via `Schemas['Cart']`. Regenerate the client package's schema
 * (`pnpm --filter @sellright/storefront-client run generate`) and these
 * types follow automatically — never hand-edit a shape here.
 *
 * ─── The cart API (src/services/CartService.ts) ───────────────────────────
 * One server-owned cart. The server is the only source of truth for
 * price / stock / coupon / revision; the client never computes any of them
 * and never caches them beyond the current in-memory mirror.
 *
 *   CartService.getCart(): Cart                    — current in-memory mirror (sync, never stale-served)
 *   CartService.token(): string | null              — the sr_cart cookie value, if a cart exists
 *   CartService.revision(): number                  — optimistic-concurrency counter for the mirror
 *   CartService.refresh(): Promise<CartMutationResult>            — re-fetch live price/stock/coupon
 *   CartService.addLine(sku, qty, enrichment?)       — blind append (commutative, no revision needed)
 *   CartService.updateLine(sku, qty, enrichment?)    — absolute set, revisioned; qty <= 0 removes the line
 *   CartService.removeLine(sku)                      — sugar for updateLine(sku, 0)
 *   CartService.applyCoupon(code): Promise<{ valid; reason? }>
 *   CartService.removeCoupon(): Promise<CartMutationResult>
 *   CartService.captureEmail(email): Promise<CartMutationResult>   — abandoned-cart capture
 *   CartService.merge(): Promise<CartMutationResult>                — fold the guest cart into the
 *                                                                      logged-in customer; call once, right after auth
 *   CartService.checkoutSnapshot(): Promise<{ token; revision; status } | null>
 *                                                     — live base for checkout; `status` distinguishes
 *                                                       'converted' (replay for payment recovery) from
 *                                                       'merged' (terminal — discard)
 *   CartService.adoptConflict(cart): void            — adopt a cart handed back inside a checkout 409
 *   CartService.discard(): void                      — drop token + mirror locally, no network call
 *                                                       (terminal cart / 404 / explicit logout-style reset)
 *   CartService.onChange(cb): () => void             — subscribe to mirror updates; returns an unsubscribe fn
 *
 * Every mutation resolves to `{ cart, dropped }`. `dropped` lists SKUs that
 * left the cart WITHOUT the caller asking for their removal (a variant went
 * away server-side, a merge collapsed a duplicate line, etc.) — callers MUST
 * surface a notice when it is non-empty. Never treat a shrunk cart as
 * unremarkable; a cart never silently loses lines.
 *
 * Stock is read fail-closed straight off the server response, never cached:
 *   - `line.available !== true` → unavailable. A missing/undefined value is
 *     treated the same as `false` — never assume purchasable by default.
 *   - `line.availableQuantity === null` → uncapped (no ceiling to enforce).
 *   - any other `availableQuantity` value is the hard cap for that line.
 * Use `isLineAvailable` / `remainingQuantity` / `canRequestQuantity` below
 * rather than re-deriving these rules at call sites.
 *
 * On a 409 revision conflict, CartService adopts the server's authoritative
 * snapshot (price/stock/coupon all re-derived from it) and retries the
 * mutation exactly once with the fresh revision before surfacing an error —
 * callers never retry themselves and never loop.
 */
import type { paths } from '../client';

type CartLinesEndpoint = paths['/v1/shop/cart/{token}/lines']['patch'];
type CreateCartEndpoint = paths['/v1/shop/cart']['post'];

/** The cart exactly as every cart endpoint returns it (create / get / patch
 *  lines / patch email / merge all share this shape). */
export type ServerCart = CreateCartEndpoint['responses'][200]['content']['application/json'];
export type ServerCartLine = ServerCart['lines'][number];

/** The `{ sku, quantity }` pair every cart-mutating request body carries. */
export type CartLineInput = NonNullable<CartLinesEndpoint['requestBody']>['content']['application/json']['lines'][number];

/** The 409 body for a terminal / stale / missing-revision cart mutation. */
export type CartConflict = CartLinesEndpoint['responses'][409]['content']['application/json'];

/**
 * Client-only display metadata the API doesn't carry — the cart row has no
 * join to the product catalog, so slug/image/options/pre-order framing are
 * attached locally, keyed by SKU, on `addLine`/`updateLine`. Never sent to
 * the server and never treated as authoritative for price or availability.
 */
export interface CartLineEnrichment {
  slug?: string;
  image?: string | null;
  name?: string;
  options?: string;
  isPreOrder?: boolean;
  shipDate?: string;
}

export type CartLine = ServerCartLine & CartLineEnrichment;
export type Cart = Omit<ServerCart, 'lines'> & { lines: CartLine[] };

export interface CartMutationResult {
  cart: Cart;
  /** SKUs dropped from the cart without the caller requesting their removal.
   *  Always empty on a caller-initiated removal for that same SKU. */
  dropped: string[];
}

/** Fail-closed availability: only an explicit `true` counts as purchasable. */
export const isLineAvailable = (line: Pick<ServerCartLine, 'available'>): boolean => line.available === true;

/** `null` = uncapped. Anything else that isn't a finite number fails closed to 0. */
export const remainingQuantity = (line: Pick<ServerCartLine, 'availableQuantity'>): number | null => {
  if (line.availableQuantity === null) return null;
  return typeof line.availableQuantity === 'number' && Number.isFinite(line.availableQuantity)
    ? line.availableQuantity
    : 0;
};

/** Whether `qty` can be requested for this line under the fail-closed stock rules above. */
export const canRequestQuantity = (line: ServerCartLine, qty: number): boolean => {
  if (!isLineAvailable(line)) return false;
  const remaining = remainingQuantity(line);
  return remaining === null ? true : qty <= remaining;
};

export const EMPTY_CART: Cart = {
  currency: 'USD',
  lines: [],
  subtotal: 0,
  discountTotal: 0,
  shippingTotal: 0,
  taxTotal: 0,
  grandTotal: 0,
  unavailable: [],
  coupon: null,
  token: '',
  status: 'active',
  email: null,
  customerId: null,
  revision: 0,
};
