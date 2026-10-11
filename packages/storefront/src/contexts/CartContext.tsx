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
import { CartService, CartError } from '~/services/CartService';
import { bindCartMirror, commitMirror, isDefinitiveCartFailure } from './cart-mirror';
import { EMPTY_CART, type Cart, type CartLineEnrichment } from '~/sellright/types/cart';

/**
 * Single, server-owned cart context (cart-architecture plan: strangler flag
 * retired — CartService.getCart() is the only source of cart data, always).
 * `cart` mirrors CartService's in-memory snapshot; components never read
 * price/stock/coupon from anywhere else. See `~/sellright/types/cart.ts` for
 * the full API contract and the fail-closed stock rules.
 */

export interface CartContextState {
  cart: Cart;
  isLoading: boolean;
  lastError: string | null;
  hasLoadedOnce: boolean;
  isRefreshingStock: boolean;
  /** Non-null exactly once, right after a mutation dropped lines the caller
   *  didn't ask to remove — consumers must show this, then clear it. */
  notice: string | null;
}

export const CartContextId = createContextId<CartContextState>('cart-context');

export const CartProvider = component$(() => {
  const cartState = useStore<CartContextState>({
    cart: EMPTY_CART,
    isLoading: false,
    lastError: null,
    hasLoadedOnce: false,
    isRefreshingStock: false,
    notice: null,
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
      if (cartState.hasLoadedOnce) return;
      cartState.cart = CartService.getCart();
      cartState.hasLoadedOnce = true;
      CartService.refresh()
        .then((res) => applyResult(cartState, res))
        .catch((e) => {
          console.error('CartContext: initial cart refresh failed:', e);
          reportError(cartState, e, 'Failed to load cart');
        });
    }),
  );

  useContextProvider(CartContextId, cartState);

  return <Slot />;
});

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
  cartState.lastError = error instanceof CartError ? error.message : error instanceof Error ? error.message : fallback;
}

export const loadCartIfNeeded = $(async (cartState: CartContextState) => {
  if (cartState.hasLoadedOnce) return;
  cartState.cart = CartService.getCart();
  cartState.hasLoadedOnce = true;
});

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
  try {
    const res = await CartService.refresh();
    applyResult(cartState, res);
    return 'ok';
  } catch (error) {
    console.error('CartContext: Failed to read the live cart:', error);
    reportError(cartState, error, 'Failed to load cart');
    return isDefinitiveCartFailure(error) ? 'ok' : 'failed';
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
    reportError(cartState, error, 'Failed to add item to cart');
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

export const removeCoupon = $(async (cartState: CartContextState) => {
  try {
    const res = await CartService.removeCoupon();
    applyResult(cartState, res);
  } catch (error) {
    reportError(cartState, error, 'Failed to remove coupon');
  }
});
