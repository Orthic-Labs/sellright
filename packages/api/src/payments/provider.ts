/**
 * PaymentProvider interface (rulebook §12). The order total is computed by
 * SellRight; the provider only confirms payment for that exact amount. Real
 * gateways (NMI tokenized / Sezzle redirect / Stripe intents) implement this
 * and need credentials. Offline/internal tenders stay in the registry for
 * refund/accounting purposes but MUST NOT be able to self-settle a shopper
 * payment simply because a public client named the method.
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
  /** Deterministic key for this logical refund — identical across a retry of
   *  the SAME refund, distinct across different refunds. Stripe returns the
   *  same `re_...` for a repeated key within 24h, so an admin retry after a
   *  transient failure cannot double-refund. Optional so manual/cod (no
   *  gateway call) don't need one. */
  idempotencyKey?: string;
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

function internalTenderFailure(method: string): PaymentResult {
  return {
    state: 'Failed',
    providerRef: null,
    errorMessage: `${method} is an internal/offline tender and cannot be settled from shopper checkout`,
  };
}

/** Manual settlement is admin/offline only. It must never mint paid orders from
 *  a customer-controlled /pay request. Admin accounting can still record manual
 *  payments directly and refunds remain ledger-only below. */
export const manualProvider: PaymentProvider = {
  method: 'manual',
  requiresRedirect: false,
  async createPayment() {
    return internalTenderFailure('manual');
  },
  async refundPayment() {
    // No gateway — the ledger row records it; money is returned offline.
    return { state: 'Settled', providerRef: null };
  },
};

/** Cash on delivery needs a distinct order/fulfillment state machine: promising
 *  to collect cash later is not equivalent to settled money. Until that model
 *  exists, fail closed instead of marking the order Paid (which can issue
 *  digital licenses and make fulfillment eligible immediately). */
export const codProvider: PaymentProvider = {
  method: 'cod',
  requiresRedirect: false,
  async createPayment() {
    return internalTenderFailure('cod');
  },
  async refundPayment() {
    return { state: 'Settled', providerRef: null };
  },
};

/** Gift cards are validated and debited atomically in checkout.ts. The generic
 *  provider registry exists only so refund routing can identify gift-card
 *  tenders; it must not create a synthetic Settled payment without validating
 *  a card and balance. */
export const giftCardProvider: PaymentProvider = {
  method: 'gift_card',
  requiresRedirect: false,
  async createPayment() {
    return internalTenderFailure('gift_card');
  },
  async refundPayment() {
    return { state: 'Settled', providerRef: null };
  },
};

export const SUPPORTED_PAYMENT_METHODS = ['manual', 'cod', 'stripe', 'gift_card'] as const;
export type SupportedPaymentMethod = typeof SUPPORTED_PAYMENT_METHODS[number];

const PROVIDERS: Record<SupportedPaymentMethod, PaymentProvider> = {
  manual: manualProvider,
  cod: codProvider,
  stripe: stripeProvider,
  gift_card: giftCardProvider,
  // nmi / sezzle: implement against this interface (need credentials).
};

export function isSupportedPaymentMethod(method: string): method is SupportedPaymentMethod {
  return (SUPPORTED_PAYMENT_METHODS as readonly string[]).includes(method);
}

/** Payment methods are fail-closed. A store must explicitly opt a supported
 *  method in; missing config never enables a credential-free tender. Note that
 *  internal/offline providers still refuse shopper settlement even if a legacy
 *  store config happens to contain `manual`, `cod`, or `gift_card: true`. */
export function isPaymentMethodEnabled(config: unknown, method: string): boolean {
  if (!isSupportedPaymentMethod(method)) return false;
  const payments = (config as { payments?: Record<string, boolean> } | null | undefined)?.payments;
  return payments?.[method] === true;
}

export function getProvider(method: string): PaymentProvider | null {
  return isSupportedPaymentMethod(method) ? PROVIDERS[method] : null;
}
