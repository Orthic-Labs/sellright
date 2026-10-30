import {
  component$,
  createContextId,
  useContext,
  useContextProvider,
  useStore,
  useOnDocument,
  $,
  Slot,
} from '@qwik.dev/core';
import { CartService, CartError, CART_COUNT_KEY } from '~/services/CartService';
export { COUPON_MAX_LENGTH, INVALID_COUPON_MESSAGE } from '~/services/CartService';
import { bindCartMirror, commitMirror, isDefinitiveCartFailure } from './cart-mirror';
import type { Live } from '~/sellright/types/live';
import { EMPTY_CART, type Cart, type CartLineEnrichment } from '~/sellright/types/cart';

/**
 * Single, server-owned cart context (cart-architecture plan: strangler flag
 * retired — CartService.getCart() is the only source of cart data, always).
 * `cart` mirrors CartService's in-memory snapshot; components never read
 * price/stock/coupon from anywhere else. See `~/sellright/types/cart.ts` for
 * the full API contract and the fail-closed stock rules.
 */

export interface CartContextState extends Live {
  cart: Cart;
  isLoading: boolean;
  lastError: string | null;
  hasLoadedOnce: boolean;
  isRefreshingStock: boolean;
  /** Non-null exactly once, right after a mutation dropped lines the caller
   *  didn't ask to remove — consumers must show this, then clear it. */
  notice: string | null;
  /** The persisted item count from the last session of this browser's cart (null = none). The header badge shows it until
   *  the first server read lands (`hasLoadedOnce`); after that the lines are the count. Never cart data. */
  lastKnownQuantity?: number | null;
}

export const CartContextId = createContextId<CartContextState>('cart-context');

export const CartProvider = component$(() => {
  const cartState = useStore<CartContextState>({
    cart: EMPTY_CART,
    isLoading: true,
    lastError: null,
    hasLoadedOnce: false,
    isRefreshingStock: false,
    notice: null,
    lastKnownQuantity: null,
  });

  // Init on page boot: paint whatever CartService already has in memory (SPA
  // nav — instant), then always refresh from the server in the background so
  // stock/price is live on first paint too (a fresh document load starts
  // CartService with an empty mirror, so this is the only place the real
  // cart — if the sr_cart cookie names one — gets loaded back in).
  useOnDocument(
    'qinit',
    $(() => {
      // Follow the service mirror for the life of the provider: classified failures change it and then throw.
      bindCartMirror(cartState);
      bindCrossTabSync(cartState);
      if (cartState.hasLoadedOnce) return;
      cartState.cart = CartService.getCart();
      // Paint the last known count at once; the bootstrap read below replaces it.
      cartState.lastKnownQuantity = CartService.lastKnownQuantity();
      // V27: a document loaded AT checkout reads the cart once, at checkout entry (`refreshCartLive`): this boot
      // read and the entry read were the same live GET back to back on the same page load. Only the boot is skipped;
      // the entry read is the LOCKED live check and always runs.
      if (deferBootToCheckoutEntry(typeof location === 'undefined' ? '' : location.pathname)) return;
      CartService.bootstrap()
        .then((res) => { applyResult(cartState, res); cartState.hasLoadedOnce = true; })
        .catch((e) => {
          console.error('CartContext: initial cart refresh failed:', e);
          reportError(cartState, e, 'Failed to load cart');
        })
        .finally(() => { cartState.isLoading = false; });
    }),
  );

  useContextProvider(CartContextId, cartState);

  return <Slot />;
});

/** #399: one `storage` listener per page. Cross-tab sync: another tab's cart change rewrites CART_COUNT_KEY (`storage` fires
 *  only in the OTHER tabs; `null` key = storage cleared); re-read the live cart and the mirror binding commits it, so the badge
 *  and the drawer follow adds, quantity changes and removals (the old store's LocalCartService storage sync). Registered from
 *  the provider's qinit handler, not `useOnWindow`: the provider renders only <Slot/>, so a `useOnWindow` binding had no element
 *  to live on and never fired. Before the first read lands the boot read is already the latest; a read that writes the same
 *  count does not wake the sender again. */
let crossTabBound = false;
function bindCrossTabSync(cartState: CartContextState): void {
  if (crossTabBound || typeof window === 'undefined') return;
  crossTabBound = true;
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== CART_COUNT_KEY) return;
    if (!cartState.hasLoadedOnce) return;
    CartService.syncFromOtherTab().catch((e) => {
      console.error('CartContext: cross-tab cart refresh failed:', e);
      reportError(cartState, e, 'Failed to refresh cart');
    });
  });
}

/** #394: the header badge count. Before the first server read lands it is the persisted count from this browser's
 *  last session (so the badge does not flash 0); after that it is the live lines. Brand headers (layer slots) use the
 *  same helper so every header shows the same number. */
export function cartBadgeCount(state: { hasLoadedOnce?: boolean; lastKnownQuantity?: number | null; cart: { lines: ReadonlyArray<{ quantity: number }> } }): number {
  if (!state.hasLoadedOnce && typeof state.lastKnownQuantity === 'number') return state.lastKnownQuantity;
  return state.cart.lines.reduce((sum, line) => sum + line.quantity, 0);
}

export const useCart = () => useContext(CartContextId);

/** Hook: does the cart contain any pre-order line? */
export const useHasPreOrder = () => {
  const { cart } = useCart();
  return { value: cart.lines.some((l) => !!l.isPreOrder) };
};

/** Hook: a MIXED cart — at least one pre-order AND at least one regular line. */
export const useHasMixedPreOrder = () => {
  const { cart } = useCart();
  const hasPreOrder = cart.lines.some((l) => !!l.isPreOrder);
  const hasRegular = cart.lines.some((l) => !l.isPreOrder);
  return { value: hasPreOrder && hasRegular };
};

function applyResult(cartState: CartContextState, res: { cart: Cart; dropped: string[] }): void {
  // The mirror at commit time, not the returned snapshot: a newer operation may have moved it on since.
  commitMirror(cartState);
  cartState.notice =
    res.dropped.length > 0
      ? `${res.dropped.length} item${res.dropped.length > 1 ? 's' : ''} in your cart ${res.dropped.length > 1 ? 'are' : 'is'} no longer available and ${res.dropped.length > 1 ? 'were' : 'was'} removed.`
      : cartState.notice;
}

function reportError(cartState: CartContextState, error: unknown, fallback: string): void {
  // A classified failure already changed the mirror (converted snapshot installed / missing cart retired).
  commitMirror(cartState);
  cartState.lastError = cartErrorMessage(error, fallback);
}

/** #401: what the shopper reads when a cart call fails. The cart's own classified errors are written for shoppers; anything
 *  else (a 5xx, a network failure, a client exception) shows the plain fallback, never a transport message such as
 *  "Request failed with status 500". */
export function cartErrorMessage(error: unknown, fallback: string): string {
  return error instanceof CartError && error.message ? error.message : fallback;
}

/** V27: the checkout page's own path (not confirmation, alias seeds or the payment redirect). */
export const isCheckoutEntryPath = (pathname: string): boolean => pathname === '/checkout' || pathname === '/checkout/';

/** Set by the provider when it left this document's first cart read to checkout entry; consumed (once) by that entry.
 *  Object holder so the minifier cannot fold it. Not a cache: it holds no cart data, only "nobody has read yet". */
const checkoutBoot: { deferred: boolean } = { deferred: false };

/** Provider side of V27: on a fresh document at the checkout path, skip the boot read and mark it for checkout entry. */
export function deferBootToCheckoutEntry(pathname: string): boolean {
  if (!isCheckoutEntryPath(pathname)) return false;
  checkoutBoot.deferred = true;
  return true;
}

/** Test seam: forget a deferred boot. */
export function resetCheckoutBootForTest(): void {
  checkoutBoot.deferred = false;
}

export const loadCartIfNeeded = $(async (cartState: CartContextState) => {
  if (cartState.hasLoadedOnce) return;
  // Someone else (e.g. a cart open) booted first: checkout entry then makes its own live read after this boot (V27).
  checkoutBoot.deferred = false;
  const result = await CartService.bootstrap();
  applyResult(cartState, result);
  cartState.hasLoadedOnce = true;
});

/** V27: checkout entry asks whether the provider left this document's boot to it. When true, the entry skips
 *  `loadCartIfNeeded` and its `refreshCartLive` IS the boot (one live GET instead of two identical ones). */
export function isBootDeferredToCheckoutEntry(cartState: { hasLoadedOnce: boolean }): boolean {
  return checkoutBoot.deferred && !cartState.hasLoadedOnce;
}

/** Live stock/price/coupon refresh — LOCKED to fire on cart open, checkout
 *  entry, and pre-submit. No cache, no TTL, no debounce, ever. */
export const refreshCartStock = $(async (cartState: CartContextState) => {
  if (!cartState.cart.lines.length) return;
  if (cartState.isRefreshingStock) return;

  cartState.isRefreshingStock = true;
  try {
    const res = await CartService.refresh();
    applyResult(cartState, res);
  } catch (error) {
    console.error('CartContext: Failed to refresh stock levels:', error);
    reportError(cartState, error, 'Failed to refresh stock levels');
  } finally {
    cartState.isRefreshingStock = false;
  }
});

/** Live cart read that does not need lines in the mirror: checkout entry on a freshly loaded document starts with an
 *  empty mirror, and a converted cart must be recognised before any gate. Same live read as `refreshCartStock`; no
 *  cache, TTL or debounce. Resolves to `'failed'` when the read failed WITHOUT a definitive outcome (network, timeout,
 *  5xx): the mirror then proves nothing, and the caller must not pick the normal checkout from it. A classified
 *  outcome (cart gone / merged / converted) is `'ok'` — the mirror already carries the answer. */
export const refreshCartLive = $(async (cartState: CartContextState): Promise<'ok' | 'failed'> => {
  // V27: on a document loaded at checkout the provider skipped its boot read; this live read is the boot
  // (`CartService.bootstrap()`: legacy-intent migration, then the same live GET). Consumed once; every later call, and
  // every call on any other document, is the plain live read. Never a reused result or promise.
  const boot = isBootDeferredToCheckoutEntry(cartState);
  checkoutBoot.deferred = false;
  try {
    const res = boot ? await CartService.bootstrap() : await CartService.refresh();
    applyResult(cartState, res);
    if (boot) cartState.hasLoadedOnce = true;
    return 'ok';
  } catch (error) {
    console.error('CartContext: Failed to read the live cart:', error);
    reportError(cartState, error, 'Failed to load cart');
    return isDefinitiveCartFailure(error) ? 'ok' : 'failed';
  } finally {
    if (boot) cartState.isLoading = false;
  }
});

export const addToCart = $(async (cartState: CartContextState, sku: string, quantity: number, enrichment?: CartLineEnrichment) => {
  await loadCartIfNeeded(cartState);
  cartState.isLoading = true;
  cartState.lastError = null;
  try {
    const res = await CartService.addLine(sku, quantity, enrichment);
    applyResult(cartState, res);
  } catch (error) {
    reportError(cartState, error, ADD_FAILED_MESSAGE);
  } finally {
    cartState.isLoading = false;
  }
});

/** What one configurator add did, from its own server response (brand views PR2 §5). Plain data: the controller maps it to an AddResult. */
export type AddOutcome =
  | { kind: 'applied'; line: { quantity: number; available: boolean; availableQuantity: number | null } | null }
  | { kind: 'not-applied' }
  | { kind: 'error'; message: string | null };

/** `addToCart` with an outcome: the same state handling (mirror, notice, lastError, isLoading), plus what the add's own response
 *  says. A thrown cart error, a response for a cart this tab no longer points at, and a missing line never read as success. */
/** #401: the add-to-cart failure every PDP shows (announced via role=alert). */
export const ADD_FAILED_MESSAGE = "Couldn't add to cart. Please try again.";

export const addToCartWithOutcome = $(async (cartState: CartContextState, sku: string, quantity: number, enrichment?: CartLineEnrichment): Promise<AddOutcome> => {
  await loadCartIfNeeded(cartState);
  cartState.isLoading = true;
  cartState.lastError = null;
  try {
    const res = await CartService.addLine(sku, quantity, enrichment);
    applyResult(cartState, res);
    if (!res.applied) return { kind: 'not-applied' };
    const l = res.line;
    return {
      kind: 'applied',
      line: l
        ? {
            quantity: Number(l.quantity),
            available: l.available === true,
            availableQuantity: typeof l.availableQuantity === 'number' && Number.isFinite(l.availableQuantity) ? l.availableQuantity : l.availableQuantity === null ? null : 0,
          }
        : null,
    };
  } catch (error) {
    reportError(cartState, error, ADD_FAILED_MESSAGE);
    return { kind: 'error', message: cartState.lastError };
  } finally {
    cartState.isLoading = false;
  }
});

export const updateCartLineQuantity = $(async (cartState: CartContextState, sku: string, quantity: number) => {
  await loadCartIfNeeded(cartState);
  cartState.isLoading = true;
  cartState.lastError = null;
  try {
    const res = await CartService.updateLine(sku, quantity);
    applyResult(cartState, res);
  } catch (error) {
    reportError(cartState, error, 'Failed to update quantity');
  } finally {
    cartState.isLoading = false;
  }
});

export const removeCartLine = $(async (cartState: CartContextState, sku: string) => {
  await loadCartIfNeeded(cartState);
  cartState.lastError = null;
  try {
    const res = await CartService.removeLine(sku);
    applyResult(cartState, res);
  } catch (error) {
    reportError(cartState, error, 'Failed to remove item');
  }
});

/** Free the cart slot once the order behind it is finished: under the cart lock, re-read the cookie's cart, look up its
 *  original order and retire it only if that order is settled or cancelled and — when `expectedCode` is given (the
 *  confirmation page) — is the order named by that page. Anything else (a newer cart, another order, a failed lookup,
 *  an unpaid order, no Web Locks) leaves the cart alone. Resolves to whether the cart was retired. */
export const retireSettledCart = $(async (cartState: CartContextState, expectedCode?: string): Promise<boolean> => {
  try {
    const retired = await CartService.retireSettled(expectedCode);
    commitMirror(cartState);
    if (retired) {
      cartState.lastError = null;
      cartState.notice = null;
    }
    return retired;
  } catch (error) {
    reportError(cartState, error, 'Failed to update your cart');
    return false;
  }
});

/** #370: the drawer's "Edit cart" — reopen a converted cart whose order is unpaid or cancelled, items kept. A refusal
 *  (the order is paid, or a payment is in flight) leaves the cart as it is and shows why. */
export const reopenCart = $(async (cartState: CartContextState): Promise<boolean> => {
  try {
    const res = await CartService.reopen();
    commitMirror(cartState);
    if (res.ok) {
      cartState.lastError = null;
      cartState.notice = null;
      return true;
    }
    cartState.lastError = res.message;
    return false;
  } catch (error) {
    reportError(cartState, error, 'Failed to update your cart');
    return false;
  }
});

export const applyCoupon = $(async (cartState: CartContextState, code: string): Promise<{ valid: boolean; reason?: string }> => {
  try {
    const res = await CartService.applyCoupon(code);
    commitMirror(cartState);
    return res;
  } catch (error) {
    reportError(cartState, error, 'Failed to validate coupon');
    return { valid: false, reason: cartState.lastError ?? 'Failed to validate coupon' };
  }
});

export const removeCoupon = $(async (cartState: CartContextState, code?: string) => {
  try {
    const res = await CartService.removeCoupon(code);
    applyResult(cartState, res);
  } catch (error) {
    reportError(cartState, error, 'Failed to remove coupon');
  }
});
