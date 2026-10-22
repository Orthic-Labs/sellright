import type { EligibleShippingMethods } from '~/types';
import { getShippingQuote } from '~/providers/shop/checkout/checkout';

export interface CartShippingQuote {
 /** The cheapest eligible method, or null ("Not available"). */
 method: EligibleShippingMethods | null;
 /** The server's nearest free-shipping tier, or null. */
 freeShipping: { threshold: number; remaining: number } | null;
}

/**
 * Cart shipping, quoted by the server from the cart's items and coupons (`POST /v1/shop/shipping-methods`), picking the
 * cheapest eligible method: the same selection checkout submits as shippingMethodCode. The storefront holds no rates,
 * thresholds or fallbacks. No method, or a failed quote, is a null method, and the cart shows "Not available".
 */
export const fetchCartShipping = async (
 countryCode: string,
 items: readonly { sku: string; quantity: number }[],
 couponCodes: readonly string[] = [],
): Promise<CartShippingQuote> => {
 try {
  const { methods, freeShipping } = await getShippingQuote(countryCode, items, couponCodes);
  if (!methods.length) return { method: null, freeShipping };
  const cheapest = methods.reduce((a, b) => (b.rate < a.rate ? b : a));
  return {
   method: {
    id: cheapest.code,
    name: cheapest.name,
    description: cheapest.name,
    price: cheapest.rate,
    priceWithTax: cheapest.rate,
   } as EligibleShippingMethods,
   freeShipping,
  };
 } catch (e) {
  console.warn('[Cart] Server shipping quote failed:', e);
  return { method: null, freeShipping: null };
 }
};
