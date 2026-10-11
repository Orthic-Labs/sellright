/**
 * Keeps the Qwik cart context equal to the CartService mirror. Qwik-free on purpose, so the sync is unit-testable.
 *
 * The service's error boundary changes the mirror and THEN throws (a converted 409 installs the converted snapshot,
 * a missing cart retires the local cart). A context that only copied the mirror after a successful operation would
 * keep showing the old active cart after those failures, so it is synced on both paths: from the service's change
 * notification (`bindCartMirror`) and explicitly in every catch path (`commitMirror`).
 */
import { CartError, CartService } from '~/services/CartService';
import type { Cart } from '~/sellright/types/cart';

export interface MirroredCartState {
  cart: Cart;
}

/** Quantity shown by the header badge for a cart. */
export const totalQuantityOf = (cart: Cart): number => cart.lines.reduce((a, l) => a + l.quantity, 0);

/** Copy the service mirror into the context and announce it. Idempotent; reads the mirror at call time. */
export function commitMirror(cartState: MirroredCartState): Cart {
  const cart = CartService.getCart();
  cartState.cart = cart;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('cart-updated', { detail: { totalQuantity: totalQuantityOf(cart) } }));
  }
  return cart;
}

let unsubscribe: (() => void) | null = null;

/** Follow every mirror change for `cartState`. Single subscription: binding again replaces the previous one. */
export function bindCartMirror(cartState: MirroredCartState): void {
  unsubscribe?.();
  unsubscribe = CartService.onChange(() => {
    commitMirror(cartState);
  });
}

/**
 * Did a failed live cart read leave the cart state DEFINITIVELY known? A classified outcome (the cart is gone, merged
 * into an account, or converted) already changed the mirror, so the caller reads the answer from it. Anything else
 * (network, timeout, 5xx, another 404) says nothing about the cart: it must not be treated as an empty or active cart.
 */
export const isDefinitiveCartFailure = (error: unknown): boolean =>
	error instanceof CartError && (error.code === 'not_found' || error.code === 'merged' || error.code === 'converted');
