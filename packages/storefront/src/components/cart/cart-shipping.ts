import type { EligibleShippingMethods } from '~/types';
import { srShippingMethods } from '~/utils/sellright';

/**
 * Cart-page shipping ESTIMATE. The server is authoritative — this query hits
 * GET /v1/shop/shipping-methods and picks the cheapest eligible method (the
 * same selection the checkout submits as shippingMethodCode). The local table
 * below is only a fallback when the quote can't be fetched — an estimate is
 * better than a blank, and checkout re-prices server-side regardless.
 */

const SHIPPING_METHODS = {
 US_PR_UNDER_100: {
  id: 'usps',
  name: 'USPS First Class',
  description: 'Standard shipping',
  price: 800,
  priceWithTax: 800,
 },
 US_PR_OVER_100: {
  id: 'free-shipping',
  name: 'Free Shipping',
  price: 0,
  priceWithTax: 0,
 },
 INTERNATIONAL: {
  id: 'usps-int',
  name: 'USPS First Class International',
  description: 'Flat rate international shipping',
  price: 2000,
  priceWithTax: 2000,
 },
};

/** Local fallback table — the pre-migration DD rates. Estimate only. */
const localFallback = (
 countryCode: string,
 orderTotalAfterDiscount: number,
): EligibleShippingMethods => {
 if (countryCode === 'US' || countryCode === 'PR') {
  return (orderTotalAfterDiscount >= 10000
   ? SHIPPING_METHODS.US_PR_OVER_100
   : SHIPPING_METHODS.US_PR_UNDER_100) as EligibleShippingMethods;
 }
 return SHIPPING_METHODS.INTERNATIONAL as EligibleShippingMethods;
};

/** Sync version kept for callers that can't await (dormant path). */
export const getCartShippingMethod = localFallback;

/** Server-authoritative estimate: cheapest eligible method for the
 *  destination + subtotal. Falls back to the local table on any error. */
export const fetchCartShippingMethod = async (
 countryCode: string,
 orderTotalAfterDiscount: number,
): Promise<EligibleShippingMethods> => {
 try {
  const { methods } = await srShippingMethods(countryCode, Math.max(orderTotalAfterDiscount, 0));
  if (methods.length) {
   const cheapest = methods.reduce((a, b) => (b.rate < a.rate ? b : a));
   return {
    id: cheapest.code,
    name: cheapest.name,
    description: cheapest.name,
    price: cheapest.rate,
    priceWithTax: cheapest.rate,
   } as EligibleShippingMethods;
  }
 } catch (e) {
  console.warn('[Cart] Server shipping quote failed, using local estimate:', e);
 }
 return localFallback(countryCode, orderTotalAfterDiscount);
};
