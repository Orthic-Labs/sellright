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

export type StripeMode = 'test' | 'live';

export interface StripeCreds { secretKey?: string; webhookSecret?: string; publishableKey?: string }

/** Resolve the env credential set for a mode. Prefer explicit test/live envs,
 *  but fall back to the legacy single-key vars during migration. */
export function stripeCreds(mode: StripeMode): StripeCreds {
  if (mode === 'live') {
    return {
      secretKey: env.STRIPE_SECRET_KEY_LIVE ?? env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET_LIVE ?? env.STRIPE_WEBHOOK_SECRET,
      publishableKey: env.STRIPE_PUBLISHABLE_KEY_LIVE ?? env.STRIPE_PUBLISHABLE_KEY,
    };
  }
  return {
    secretKey: env.STRIPE_SECRET_KEY_TEST ?? env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET_TEST ?? env.STRIPE_WEBHOOK_SECRET,
    publishableKey: env.STRIPE_PUBLISHABLE_KEY_TEST ?? env.STRIPE_PUBLISHABLE_KEY,
  };
}

/** Read the active Stripe mode from a store's config; defaults to 'test'
 *  (fail-safe) until a store explicitly flips to live. */
export function stripeModeFromConfig(config: unknown): StripeMode {
  const m = (config as { stripe?: { mode?: unknown } } | null | undefined)?.stripe?.mode;
  return m === 'live' ? 'live' : 'test';
}

/** A Stripe key embeds its mode (`sk_test_…` / `sk_live_…`, likewise `pk_`/`rk_`).
 *  Guard against a test key sitting in a live slot (or vice-versa) — the legacy
 *  single-key fallback in stripeCreds() means a bare key could otherwise silently
 *  back BOTH modes, so a flip to live could run on a test key (→ Stripe 401). */
function keyMatchesMode(key: string | undefined, mode: StripeMode): boolean {
  if (!key) return false;
  return mode === 'live' ? key.includes('_live_') : key.includes('_test_');
}

// Cache keyed by the resolved secret key (not just mode) so a changed key always
// yields a fresh client. `env` is parsed once at boot so in practice this holds
// one client per mode, but keying by secret is correct even if that changes.
const _clients = new Map<string, Stripe>();
export function stripeClient(mode: StripeMode): Stripe {
  const key = stripeCreds(mode).secretKey;
  if (!key) throw new Error(`STRIPE_SECRET_KEY_${mode === 'live' ? 'LIVE' : 'TEST'} is not configured`);
  let client = _clients.get(key);
  if (!client) { client = new Stripe(key); _clients.set(key, client); }
  return client;
}

/** True only when this mode has a secret key that is actually a secret key
 *  (`sk_`/`rk_`) AND embeds this mode — so a test key in the live slot, or a
 *  publishable key pasted into the secret slot, reads as NOT configured. */
export function stripeConfigured(mode: StripeMode): boolean {
  const sk = stripeCreds(mode).secretKey;
  return !!sk && (sk.startsWith('sk_') || sk.startsWith('rk_')) && keyMatchesMode(sk, mode);
}

export function stripePublishableForClient(mode: StripeMode): string | null {
  const pk = stripeCreds(mode).publishableKey;
  return pk && pk.startsWith('pk_') && keyMatchesMode(pk, mode) ? pk : null;
}

/** A customer can complete a Stripe payment in this mode: both a valid secret
 *  key (mint + verify) and a matching publishable key (Stripe.js confirm) exist.
 *  This is the single gate the storefront (/shop/config) and the payment-intent
 *  endpoint both use, so they can never disagree. */
export function stripeUsable(mode: StripeMode): boolean {
  return stripeConfigured(mode) && !!stripePublishableForClient(mode);
}

// constructEvent is pure crypto (no API call), so webhook signature verification
// must NOT depend on the mode's API secret key being present — only the webhook
// secret. A throwaway client is fine for this.
let _webhookVerifier: Stripe | null = null;
export function verifyStripeWebhook(rawBody: string, signature: string, webhookSecret: string): Stripe.Event {
  _webhookVerifier ??= new Stripe('sk_test_webhook_verify_only');
  return _webhookVerifier.webhooks.constructEvent(rawBody, signature, webhookSecret);
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
    // No silent default to 'test' — routing live money through the test client (or
    // vice-versa) must fail loudly, not silently mis-charge.
    if (!input.stripeMode) return { state: 'Failed', providerRef: null, errorMessage: 'stripeMode is required for Stripe payments' };
    let pi: Stripe.PaymentIntent;
    try {
      pi = await stripeClient(input.stripeMode).paymentIntents.retrieve(intentId);
    } catch (e) {
      return { state: 'Failed', providerRef: intentId, errorMessage: e instanceof Error ? e.message : 'retrieve failed' };
    }
    return verifyIntent(pi as unknown as IntentLike, input);
  },
  async refundPayment(input: RefundInput): Promise<RefundResult> {
    if (!input.providerRef) return { state: 'Failed', providerRef: null, errorMessage: 'no payment_intent to refund' };
    if (!input.stripeMode) return { state: 'Failed', providerRef: null, errorMessage: 'stripeMode is required for Stripe refunds' };
    try {
      const r = await stripeClient(input.stripeMode).refunds.create({ payment_intent: input.providerRef, amount: input.amount });
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
export async function createPaymentIntent(opts: { orderCode: string; storeId: string; amount: number; currency: string; mode: StripeMode; idempotencyKey?: string }): Promise<{ clientSecret: string; intentId: string }> {
  // Idempotent on the order: Stripe returns the SAME PaymentIntent (same
  // client_secret) for a repeated `idempotencyKey` within 24h, so a double-click
  // / retry of /payment-intent reuses the order's open PI instead of minting a
  // duplicate. The key is keyed on the order id by the caller.
  const pi = await stripeClient(opts.mode).paymentIntents.create({
    amount: opts.amount,
    currency: opts.currency.toLowerCase(),
    metadata: { orderCode: opts.orderCode, storeId: opts.storeId },
    automatic_payment_methods: { enabled: true },
  }, opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined);
  return { clientSecret: pi.client_secret ?? '', intentId: pi.id };
}

/**
 * Create a Stripe Checkout Session in `subscription` mode for a recurring plan.
 * The metadata ({storeId, orderCode, customerId?}) is set BOTH on the session
 * (so `checkout.session.completed` can resolve our backing order + tenant) AND
 * on `subscription_data.metadata` — Stripe copies the latter onto every
 * invoice's `subscription_details.metadata`, a bonus path for invoice events.
 * The primary tenant anchor is still OUR subscription row (see
 * resolveStoreIdForSubscriptionEvent), so the implementation does not DEPEND on
 * that propagation.
 */
export async function createSubscriptionCheckout(mode: StripeMode, args: {
  priceId: string; successUrl: string; cancelUrl: string;
  customerEmail?: string; metadata: Record<string, string>; // {storeId, orderCode, customerId?}
}): Promise<{ url: string; sessionId: string }> {
  const stripe = stripeClient(mode);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: args.priceId, quantity: 1 }],
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    customer_email: args.customerEmail,
    subscription_data: { metadata: args.metadata },
    metadata: args.metadata,
  });
  if (!session.url) throw new Error('stripe did not return a checkout url');
  return { url: session.url, sessionId: session.id };
}

/** Open a Stripe Customer Portal session for self-serve cancel / card update. */
export async function createBillingPortal(mode: StripeMode, args: { customerId: string; returnUrl: string }): Promise<string> {
  const stripe = stripeClient(mode);
  const ps = await stripe.billingPortal.sessions.create({ customer: args.customerId, return_url: args.returnUrl });
  return ps.url;
}
