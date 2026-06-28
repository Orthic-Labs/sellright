import type { EligibleShippingMethods } from '~/types';

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

export const getCartShippingMethod = (
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
