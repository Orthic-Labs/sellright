import type { EligibleShippingMethods } from '~/types';
import { srShippingMethods } from '~/utils/sellright';

/**
 * Cart-page shipping ESTIMATE. The server is authoritative — this query hits
 * GET /v1/shop/shipping-methods and picks the cheapest eligible method (the
 * same selection the checkout submits as shippingMethodCode). When the server
 * offers no method, or the quote fails, the answer is null and the cart shows
 * "Not available": it never invents a rate, since checkout cannot honour one.
 */
export const fetchCartShippingMethod = async (
 countryCode: string,
 orderTotalAfterDiscount: number,
): Promise<EligibleShippingMethods | null> => {
 try {
  const { methods } = await srShippingMethods(countryCode, Math.max(orderTotalAfterDiscount, 0));
  if (!methods.length) return null;
  const cheapest = methods.reduce((a, b) => (b.rate < a.rate ? b : a));
  return {
   id: cheapest.code,
   name: cheapest.name,
   description: cheapest.name,
   price: cheapest.rate,
   priceWithTax: cheapest.rate,
  } as EligibleShippingMethods;
 } catch (e) {
  console.warn('[Cart] Server shipping quote failed:', e);
  return null;
 }
};
