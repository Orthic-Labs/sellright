/**
 * WP3: Stripe provider. Two-phase model — the storefront confirms a
 * PaymentIntent client-side (Stripe.js handles 3DS), then calls `/pay` with the
 * intent id as `token`; the provider VERIFIES the intent server-side rather than
 * charging (never trust client-reported success). Amount/currency/orderCode are
 * re-checked against the SellRight-computed order before settling.
 *
 * No key configured → createPayment/refund fail loudly; the route layer gates on
 * isPaymentMethodEnabled so this only runs when a store has stripe turned on.
 */
import Stripe from 'stripe';
import { env } from '../env.js';
import type { PaymentProvider, CreatePaymentInput, PaymentResult, RefundInput, RefundResult } from './provider.js';

let _client: Stripe | null = null;
/** Lazy singleton — constructed only when a key is present (keeps dev/test boot keyless). */
export function stripeClient(): Stripe {
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not configured');
  if (!_client) _client = new Stripe(env.STRIPE_SECRET_KEY);
  return _client;
}

export function stripeConfigured(): boolean {
  return !!env.STRIPE_SECRET_KEY;
}

/** The minimal PaymentIntent shape the verification reads (keeps verifyIntent SDK-free + unit-testable). */
export interface IntentLike {
  id: string;
  amount: number;
  currency: string;
  status: string;
  metadata?: Record<string, string> | null;
  latest_charge?: unknown;
}

/**
 * PURE server-side verification — the security core. Given the retrieved intent
 * and the SellRight order facts, decide the PaymentResult. Never trusts the
 * client: an intent whose amount/currency/orderCode doesn't match the order is
 * Failed, regardless of what the client claims.
 */
export function verifyIntent(pi: IntentLike, input: CreatePaymentInput): PaymentResult {
  if (pi.amount !== input.amount || pi.currency.toUpperCase() !== input.currency.toUpperCase()) {
    return { state: 'Failed', providerRef: pi.id, errorMessage: 'amount/currency mismatch' };
  }
  if (pi.metadata?.orderCode !== input.orderCode) {
    return { state: 'Failed', providerRef: pi.id, errorMessage: 'order mismatch' };
  }
  if (pi.status === 'succeeded') return { state: 'Settled', providerRef: pi.id, metadata: { latest_charge: pi.latest_charge ?? null } };
  if (pi.status === 'requires_capture') return { state: 'Authorized', providerRef: pi.id };
  return { state: 'Declined', providerRef: pi.id, errorMessage: `status: ${pi.status}` };
}

export const stripeProvider: PaymentProvider = {
  method: 'stripe',
  requiresRedirect: false,
  async createPayment(input: CreatePaymentInput): Promise<PaymentResult> {
    const intentId = typeof input.token === 'string'
      ? input.token
      : (input.token as { paymentIntentId?: string } | undefined)?.paymentIntentId;
    if (!intentId) return { state: 'Failed', providerRef: null, errorMessage: 'missing paymentIntentId' };
    let pi: Stripe.PaymentIntent;
    try {
      pi = await stripeClient().paymentIntents.retrieve(intentId);
    } catch (e) {
      return { state: 'Failed', providerRef: intentId, errorMessage: e instanceof Error ? e.message : 'retrieve failed' };
    }
    return verifyIntent(pi as unknown as IntentLike, input);
  },
  async refundPayment(input: RefundInput): Promise<RefundResult> {
    if (!input.providerRef) return { state: 'Failed', providerRef: null, errorMessage: 'no payment_intent to refund' };
    try {
      const r = await stripeClient().refunds.create({ payment_intent: input.providerRef, amount: input.amount });
      const state: RefundResult['state'] = r.status === 'succeeded' ? 'Settled' : r.status === 'pending' ? 'Pending' : 'Failed';
      return { state, providerRef: r.id, errorMessage: state === 'Failed' ? `refund status: ${r.status}` : null };
    } catch (e) {
      return { state: 'Failed', providerRef: null, errorMessage: e instanceof Error ? e.message : 'refund failed' };
    }
  },
};

/**
 * Mint a PaymentIntent for an order, server-side. Amount comes from the order
 * row (never the client); orderCode + storeId go in metadata so the inbound
 * webhook and verifyIntent can bind the intent back to exactly this order.
 */
export async function createPaymentIntent(opts: { orderCode: string; storeId: string; amount: number; currency: string }): Promise<{ clientSecret: string; intentId: string }> {
  const pi = await stripeClient().paymentIntents.create({
    amount: opts.amount,
    currency: opts.currency.toLowerCase(),
    metadata: { orderCode: opts.orderCode, storeId: opts.storeId },
    automatic_payment_methods: { enabled: true },
  });
  return { clientSecret: pi.client_secret ?? '', intentId: pi.id };
}
