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
      if (cartState.hasLoadedOnce) return;
      cartState.cart = CartService.getCart();
      cartState.hasLoadedOnce = true;
      CartService.refresh()
        .then((res) => applyResult(cartState, res))
        .catch((e) => {
          console.error('CartContext: initial cart refresh failed:', e);
          cartState.lastError = 'Failed to load cart';
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
  cartState.cart = res.cart;
  cartState.notice =
    res.dropped.length > 0
      ? `${res.dropped.length} item${res.dropped.length > 1 ? 's' : ''} in your cart ${res.dropped.length > 1 ? 'are' : 'is'} no longer available and ${res.dropped.length > 1 ? 'were' : 'was'} removed.`
      : cartState.notice;
}

function reportError(cartState: CartContextState, error: unknown, fallback: string): void {
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

export const addToCart = $(async (cartState: CartContextState, sku: string, quantity: number, enrichment?: CartLineEnrichment) => {
  await loadCartIfNeeded(cartState);
  cartState.isLoading = true;
  cartState.lastError = null;
  try {
    const res = await CartService.addLine(sku, quantity, enrichment);
    applyResult(cartState, res);
    if (typeof window !== 'undefined') {
      const total = res.cart.lines.reduce((a, l) => a + l.quantity, 0);
      window.dispatchEvent(new CustomEvent('cart-updated', { detail: { totalQuantity: total } }));
    }
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
    if (typeof window !== 'undefined') {
      const total = res.cart.lines.reduce((a, l) => a + l.quantity, 0);
      window.dispatchEvent(new CustomEvent('cart-updated', { detail: { totalQuantity: total } }));
    }
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
    if (typeof window !== 'undefined') {
      const total = res.cart.lines.reduce((a, l) => a + l.quantity, 0);
      window.dispatchEvent(new CustomEvent('cart-updated', { detail: { totalQuantity: total } }));
    }
  } catch (error) {
    reportError(cartState, error, 'Failed to remove item');
  }
});

/** Discard the cart after a successful order — the server cart is terminal
 *  (converted) at this point, so this drops the local token/mirror rather
 *  than mutating a cart that no longer accepts writes. */
export const clearCart = $(async (cartState: CartContextState) => {
  CartService.discard();
  cartState.cart = CartService.getCart();
  cartState.lastError = null;
  cartState.notice = null;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('cart-updated', { detail: { totalQuantity: 0 } }));
  }
});

export const applyCoupon = $(async (cartState: CartContextState, code: string): Promise<{ valid: boolean; reason?: string }> => {
  try {
    const res = await CartService.applyCoupon(code);
    cartState.cart = CartService.getCart();
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
