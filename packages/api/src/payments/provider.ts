/**
 * PaymentProvider interface (rulebook §12). The order total is computed by
 * SellRight; the provider only confirms payment for that exact amount. Real
 * gateways (NMI tokenized / Sezzle redirect / Stripe intents) implement this
 * and need credentials; `manual` is the credential-free test/admin path.
 */
import { stripeProvider } from './stripe.js';

export interface PaymentResult {
  state: 'Settled' | 'Authorized' | 'Declined' | 'Failed';
  providerRef: string | null;
  metadata?: unknown;
  errorMessage?: string | null;
}

export interface CreatePaymentInput {
  orderCode: string;
  amount: number; // cents
  currency: string;
  /** Tokenized input from the client (never raw PAN). Shape is provider-specific. */
  token?: unknown;
  stripeMode?: 'test' | 'live';
}

export interface RefundInput {
  /** The settled payment's provider reference (e.g. Stripe payment_intent id). */
  providerRef: string | null;
  amount: number; // cents
  currency: string;
  stripeMode?: 'test' | 'live';
}

export interface RefundResult {
  state: 'Settled' | 'Pending' | 'Failed';
  providerRef: string | null; // e.g. Stripe refund id (re_...)
  errorMessage?: string | null;
}

export interface PaymentProvider {
  readonly method: string;
  readonly requiresRedirect: boolean;
  createPayment(input: CreatePaymentInput): Promise<PaymentResult>;
  /** Reverse a settled payment at the gateway. Optional: manual/cod no-op
   *  (money is handled offline); real gateways move money. The refund handler
   *  calls this BEFORE writing the ledger row, so a gateway failure aborts. */
  refundPayment?(input: RefundInput): Promise<RefundResult>;
}

/** Manual / test provider — records a settled payment with no external call. */
export const manualProvider: PaymentProvider = {
  method: 'manual',
  requiresRedirect: false,
  async createPayment(input) {
    return { state: 'Settled', providerRef: `manual-${input.orderCode}`, metadata: { manual: true } };
  },
  async refundPayment() {
    // No gateway — the ledger row records it; money is returned offline.
    return { state: 'Settled', providerRef: null };
  },
};

/** Cash on delivery — order is confirmed now, cash collected at delivery.
 *  Settles the order so it's fulfillable; the actual cash is handled offline. */
export const codProvider: PaymentProvider = {
  method: 'cod',
  requiresRedirect: false,
  async createPayment(input) {
    return { state: 'Settled', providerRef: `cod-${input.orderCode}`, metadata: { cod: true, collectOnDelivery: input.amount } };
  },
  async refundPayment() {
    return { state: 'Settled', providerRef: null };
  },
};

export const SUPPORTED_PAYMENT_METHODS = ['manual', 'cod', 'stripe'] as const;
export type SupportedPaymentMethod = typeof SUPPORTED_PAYMENT_METHODS[number];

const PROVIDERS: Record<SupportedPaymentMethod, PaymentProvider> = {
  manual: manualProvider,
  cod: codProvider,
  stripe: stripeProvider,
  // nmi / sezzle: implement against this interface (need credentials).
};

export function isSupportedPaymentMethod(method: string): method is SupportedPaymentMethod {
  return (SUPPORTED_PAYMENT_METHODS as readonly string[]).includes(method);
}

export function isPaymentMethodEnabled(config: unknown, method: string): boolean {
  if (!isSupportedPaymentMethod(method)) return false;
  const payments = (config as { payments?: Record<string, boolean> } | null | undefined)?.payments;
  if (payments && Object.prototype.hasOwnProperty.call(payments, method)) return payments[method] === true;
  return method === 'manual' || method === 'cod';
}

export function getProvider(method: string): PaymentProvider | null {
  return isSupportedPaymentMethod(method) ? PROVIDERS[method] : null;
}
