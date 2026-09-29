/**
 * PaymentProvider interface (rulebook §12). The order total is computed by
 * SellRight; the provider only confirms payment for that exact amount. Real
 * gateways (NMI tokenized / Sezzle redirect / Stripe intents) implement this
 * and need credentials. Offline/internal tenders stay in the registry for
 * refund/accounting purposes but MUST NOT be able to self-settle a shopper
 * payment simply because a public client named the method.
 */
import { stripeProvider } from './stripe.js';
import { nmiProvider } from './nmi.js';
import { sezzleProvider } from './sezzle.js';
import type { GatewayAccount } from './gateway-account.js';

export interface PaymentResult {
  state: 'Settled' | 'Authorized' | 'Pending' | 'Declined' | 'Failed';
  providerRef: string | null;
  metadata?: unknown;
  errorMessage?: string | null;
}

export interface CreatePaymentInput {
  orderCode: string;
  storeId?: string;
  attemptId?: string;
  gateway?: GatewayAccount;
  billingAddress?: Record<string, unknown>;
  amount: number; // cents
  currency: string;
  /** Tokenized input from the client (never raw PAN). Shape is provider-specific. */
  token?: unknown;
  stripeMode?: 'test' | 'live';
}

export interface RefundInput {
  gateway?: GatewayAccount;
  /** The settled payment's provider reference (e.g. Stripe payment_intent id). */
  providerRef: string | null;
  amount: number; // cents
  currency: string;
  stripeMode?: 'test' | 'live';
  /** Required by the Stripe provider (env>db credential resolution, WS-A);
   *  nmi/sezzle resolve credentials via `gateway` instead and ignore this. */
  storeId?: string;
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

export const SUPPORTED_PAYMENT_METHODS = ['manual', 'cod', 'stripe', 'gift_card', 'nmi', 'sezzle'] as const;
export type SupportedPaymentMethod = typeof SUPPORTED_PAYMENT_METHODS[number];

const PROVIDERS: Record<SupportedPaymentMethod, PaymentProvider> = {
  manual: manualProvider,
  cod: codProvider,
  stripe: stripeProvider,
  gift_card: giftCardProvider,
  nmi: nmiProvider,
  sezzle: sezzleProvider,
};

export function isSupportedPaymentMethod(method: string): method is SupportedPaymentMethod {
  return (SUPPORTED_PAYMENT_METHODS as readonly string[]).includes(method);
}

/** Payment methods are fail-closed. A store must explicitly opt a supported
 *  method in; missing config never enables a credential-free tender. Note that
 *  internal/offline providers still refuse shopper settlement even if a legacy
 *  store config happens to contain `manual`, `cod`, or `gift_card: true`.
 *
 *  Two config shapes are accepted for `payments.<method>`:
 *    - `true` / `false`                      (legacy toggle; mode defaults to test)
 *    - `{ enabled: true, mode: 'live'|'test', <mode>: { verifiedAt } }`
 *  The object shape is what gatewayModeFromConfig() and the settings-verify
 *  writer (readiness `verifiedAt`) read, so both must be honored here. */
export function paymentMethodSetting(config: unknown, method: string): { enabled: boolean; mode?: 'test' | 'live' } {
  const payments = (config as { payments?: Record<string, unknown> } | null | undefined)?.payments;
  const raw = payments && typeof payments === 'object' ? (payments as Record<string, unknown>)[method] : undefined;
  if (raw === true) return { enabled: true };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { enabled: false };
  const obj = raw as { enabled?: unknown; mode?: unknown };
  return {
    enabled: obj.enabled === true,
    ...(obj.mode === 'live' || obj.mode === 'test' ? { mode: obj.mode } : {}),
  };
}

export function isPaymentMethodEnabled(config: unknown, method: string): boolean {
  if (!isSupportedPaymentMethod(method)) return false;
  return paymentMethodSetting(config, method).enabled;
}

/** Merge an admin patch (`true`/`false` or `{enabled?, mode?}`) into an
 *  existing `payments.<method>` value without discarding the object shape's
 *  other keys (per-mode `verifiedAt` readiness markers). A legacy boolean is
 *  kept boolean when the patch is a plain boolean and nothing else is stored. */
export function mergePaymentMethodSetting(
  existing: unknown, patch: boolean | { enabled?: boolean; mode?: 'test' | 'live' },
): unknown {
  const base: Record<string, unknown> = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...(existing as Record<string, unknown>) }
    : existing === true ? { enabled: true } : {};
  if (typeof patch === 'boolean') {
    if (!existing || typeof existing !== 'object') return patch;
    return { ...base, enabled: patch };
  }
  return {
    ...base,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
  };
}

export function getProvider(method: string): PaymentProvider | null {
  return isSupportedPaymentMethod(method) ? PROVIDERS[method] : null;
}
