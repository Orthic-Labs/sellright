import paymentMethods from '../data/payment-methods.json';

export interface PaymentMethod {
  id: string;
  code: string;
  enabled: boolean;
  name: string;
  description: string;
  isEligible: boolean; // Required to match EligiblePaymentMethods type
}

export class PaymentService {
  static getPaymentMethods(): PaymentMethod[] {
    return paymentMethods.filter(method => method.enabled).map(method => ({
      ...method,
      isEligible: true
    }));
  }

  static getEligiblePaymentMethods(): PaymentMethod[] {
    return paymentMethods.filter(method => method.enabled).map(method => ({
      ...method,
      isEligible: true // All enabled methods are eligible
    }));
  }
}