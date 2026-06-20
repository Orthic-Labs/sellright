import shippingMethods from '../data/shipping-methods.json';
import { srShippingMethods } from '~/utils/sellright';

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

  /**
   * SellRight path: server-priced shipping methods (GET /v1/shop/shipping-methods).
   * Maps the REST shape onto the storefront ShippingMethod type (rates in cents).
   */
  static async getSellRightShippingMethods(countryCode: string, subtotal: number): Promise<ShippingMethod[]> {
    const { methods } = await srShippingMethods(countryCode, subtotal);
    return methods.map((m) => ({
      id: m.code,
      code: m.code,
      name: m.name,
      description: '',
      price: m.rate,
      priceWithTax: m.rate,
      countryCodes: ['*'],
    }));
  }
}