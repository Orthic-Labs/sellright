import paymentMethods from '../data/payment-methods.json';

export interface PaymentMethod {
  id: string;
  code: string;
  enabled: boolean;
  name: string;
  description: string;
  isEligible: boolean; // Required to match EligiblePaymentMethods type
}

/** SellRight/Stripe checkout flag (mirrors the checkout provider). */
const SR_CHECKOUT_ENABLED =
  String(import.meta.env.VITE_SR_CHECKOUT ?? '').toLowerCase() === '1' ||
  String(import.meta.env.VITE_SR_CHECKOUT ?? '').toLowerCase() === 'true';

// Stripe-only payment list for the SellRight path (NMI/Sezzle removed from THIS
// path — they remain in payment-methods.json for the default Vendure path).
const STRIPE_ONLY: PaymentMethod[] = [
  { id: 'stripe', code: 'stripe', enabled: true, name: 'Card', description: 'Pay securely by card', isEligible: true },
];

export class PaymentService {
  static getPaymentMethods(): PaymentMethod[] {
    if (SR_CHECKOUT_ENABLED) return STRIPE_ONLY;
    return paymentMethods.filter(method => method.enabled).map(method => ({
      ...method,
      isEligible: true
    }));
  }

  static getEligiblePaymentMethods(): PaymentMethod[] {
    if (SR_CHECKOUT_ENABLED) return STRIPE_ONLY;
    return paymentMethods.filter(method => method.enabled).map(method => ({
      ...method,
      isEligible: true // All enabled methods are eligible
    }));
  }
}