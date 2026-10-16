// Brand views, plan §2.3 `cart.free-shipping-progress`: the two values a brand's free-shipping rule needs and the base cart already
// knows: the shopper's shipping country and the discounted merchandise amount. Pure, so the drawer, the checkout summary and the tests
// share one definition.

/** max(0, subtotal - discountTotal): the amount a free-shipping threshold applies to (the formula of components/cart/Cart.tsx). */
export const discountedSubtotalCents = (subtotal: number, discountTotal?: number | null): number => Math.max(0, subtotal - (discountTotal || 0));

/** APP_STATE.shippingAddress.countryCode, or null until the shopper's country is known. */
export const shippingCountry = (countryCode?: string | null): string | null => (countryCode ? countryCode : null);
