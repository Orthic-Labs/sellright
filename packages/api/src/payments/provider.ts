/**
 * PaymentProvider interface (rulebook §12). The order total is computed by
 * SellRight; the provider only confirms payment for that exact amount. Real
 * gateways (NMI tokenized / Sezzle redirect / Stripe intents) implement this
 * and need credentials; `manual` is the credential-free test/admin path.
 */
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
}

export interface PaymentProvider {
  readonly method: string;
  readonly requiresRedirect: boolean;
  createPayment(input: CreatePaymentInput): Promise<PaymentResult>;
}

/** Manual / test provider — records a settled payment with no external call. */
export const manualProvider: PaymentProvider = {
  method: 'manual',
  requiresRedirect: false,
  async createPayment(input) {
    return { state: 'Settled', providerRef: `manual-${input.orderCode}`, metadata: { manual: true } };
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
};

const PROVIDERS: Record<string, PaymentProvider> = {
  manual: manualProvider,
  cod: codProvider,
  // nmi / sezzle / stripe: implement against this interface (need credentials).
};

export function getProvider(method: string): PaymentProvider | null {
  return PROVIDERS[method] ?? null;
}
