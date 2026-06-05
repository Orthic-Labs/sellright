import shippingMethods from '../data/shipping-methods.json';

export interface ShippingMethod {
  id: string;
  code: string;
  name: string;
  description: string;
  price: number;
  priceWithTax: number;
  countryCodes: string[];
  maxSubtotal?: number;
  minSubtotal?: number;
}

export class ShippingService {
  static getEligibleShippingMethods(countryCode: string, subtotal: number): ShippingMethod[] {
    const methods = shippingMethods.filter(method => {
      // Check if the method is available for the given country
      const countryMatch = method.countryCodes.includes(countryCode) || method.countryCodes.includes('*');
      
      // Check if the subtotal is within the method's range
      const maxSubtotalMatch = method.maxSubtotal === undefined || subtotal <= method.maxSubtotal;
      const minSubtotalMatch = method.minSubtotal === undefined || subtotal >= method.minSubtotal;
      
      return countryMatch && maxSubtotalMatch && minSubtotalMatch;
    });
    return methods;
  }
}