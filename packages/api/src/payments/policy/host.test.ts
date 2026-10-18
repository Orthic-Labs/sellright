// Payment policy host: registration, composition, veto and SAVEPOINT isolation (pure, no database).
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tx } from '../../db/client.js';
import type { HeldLocks } from '../../db/locks.js';

const assertHeld = vi.fn(async () => undefined);
vi.mock('../../db/locks.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../db/locks.js')>()), assertHeld: (...a: unknown[]) => assertHeld(...(a as [])) }));

import {
  PaymentPolicyCompositionError, PaymentPolicyMetadataError, PaymentPolicyUnavailableError, PaymentPolicyVetoError, _resetPaymentPoliciesForTests,
  hasCheckoutReplayPolicy, registerPaymentPolicy, registeredPaymentPolicies, runAuthorizeInvoiceEffect, runBeforePaymentAttempt,
  runCheckoutEligibility, runCheckoutReplayAllowed, runEntitlementReversal, runLegacyCheckoutFingerprints, runOnCheckoutOrder, runRevalidateForIssuance,
  runShapeSettlementResponse, runBeforeCapture,
} from './host.js';
import { PaymentPolicyRefusalError } from './registry.js';
import { dispatchReservationTransition } from './transitions.js';
import { SELLRIGHT_DEFAULT_POLICY_ID, installDefaultPaymentPolicy } from './default-policy.js';
import type {
  AuthorizeInvoiceEffectInput, BeforePaymentAttemptInput, CheckoutFingerprintBasis, EntitlementReversalInput, PaymentPolicy, RevalidateForIssuanceInput,
} from './types.js';

const dialect = new PgDialect();
const executed: string[] = [];
const fakeTx = {
  execute: vi.fn(async (q: unknown) => {
    executed.push(dialect.sqlToQuery(q as Parameters<PgDialect['sqlToQuery']>[0]).sql);
    return { rows: [] };
  }),
} as unknown as Tx;
const input = {
  provider: 'stripe', purpose: 'checkout',
  order: { id: 'o1', storeId: 's1', code: 'C1', state: 'PendingPayment', currency: 'USD', grandTotal: 100, customerId: null, metadata: {} },
  reservations: [], held: {} as HeldLocks,
} as BeforePaymentAttemptInput;

const allow = (id: string, calls: string[]): PaymentPolicy => ({
  id, async beforePaymentAttempt() { calls.push(id); return { allow: true }; },
});
const veto = (id: string, calls: string[]): PaymentPolicy => ({
  id, async beforePaymentAttempt() {
    calls.push(id);
    return { allow: false, veto: { code: 'TEST_VETO', message: 'refused', extra: { state: 'Vetoed' } } };
  },
});

beforeEach(() => {
  _resetPaymentPoliciesForTests();
  executed.length = 0;
  assertHeld.mockClear();
});

describe('payment policy registration', () => {
  it('rejects a duplicate policy id at registration', () => {
    registerPaymentPolicy(allow('dup', []));
    expect(() => registerPaymentPolicy(allow('dup', []))).toThrow(/already registered/);
    expect(registeredPaymentPolicies().map((p) => p.id)).toEqual(['dup']);
  });

  it('installs the sellright-default policy once', () => {
    installDefaultPaymentPolicy();
    installDefaultPaymentPolicy();
    expect(registeredPaymentPolicies().map((p) => p.id)).toEqual([SELLRIGHT_DEFAULT_POLICY_ID]);
  });

  it('a plugin cannot take the default id', () => {
    installDefaultPaymentPolicy();
    expect(() => registerPaymentPolicy(allow(SELLRIGHT_DEFAULT_POLICY_ID, []))).toThrow(/already registered/);
  });
});

describe('runBeforePaymentAttempt', () => {
  it.each(['stripe', 'nmi', 'sezzle', 'manual', 'zero_total', 'gift_card'] as const)('refuses quarantined %s before a plugin or reservation write', async (provider) => {
    const hook = vi.fn(async () => ({ allow: true as const, reserve: [{ kind: 'test', ownerKey: 'one' }] }));
    registerPaymentPolicy({ id: 'would-reserve', beforePaymentAttempt: hook });
    await expect(runBeforePaymentAttempt(fakeTx, { ...input, provider,
      order: { ...input.order, metadata: { vendure: { financialReconciliationV1: null } } },
    })).rejects.toMatchObject({ status: 409, code: 'IMPORTED_FINANCIAL_RECONCILIATION_REQUIRED' });
    expect(hook).not.toHaveBeenCalled();
    expect(executed).toEqual([]);
  });

  it('refuses capture before plugins, even with an already prepared attempt', async () => {
    const capture = vi.fn(async () => ({ action: 'capture' as const }));
    registerPaymentPolicy({ id: 'capture', beforePaymentAttempt: async () => ({ allow: true }), beforeCapture: capture });
    await expect(runBeforeCapture(fakeTx, {
      provider: 'sezzle', order: { ...input.order, metadata: { vendure: { financialReconciliationV1: { version: 1, status: 'required' } } } },
      attempt: { id: 'a', amount: 100, currency: 'USD', providerRef: 'provider-observed' }, reservations: [], held: input.held,
    })).rejects.toMatchObject({ status: 409, code: 'IMPORTED_FINANCIAL_RECONCILIATION_REQUIRED' });
    expect(capture).not.toHaveBeenCalled();
    expect(executed).toEqual([]);
  });

  it('allows when every policy allows (default policy: no veto)', async () => {
    installDefaultPaymentPolicy();
    await expect(runBeforePaymentAttempt(fakeTx, input)).resolves.toBeUndefined();
    expect(assertHeld).toHaveBeenCalledWith(fakeTx, input.held);
  });

  it('runs in registration order and the first veto wins; later policies do not run', async () => {
    const calls: string[] = [];
    registerPaymentPolicy(allow('a', calls));
    registerPaymentPolicy(veto('b', calls));
    registerPaymentPolicy(allow('c', calls));
    const err = await runBeforePaymentAttempt(fakeTx, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentPolicyVetoError);
    expect((err as PaymentPolicyVetoError).veto).toMatchObject({ code: 'TEST_VETO', message: 'refused' });
    expect(calls).toEqual(['a', 'b']);
  });

  it('wraps each hook in a savepoint and releases it on success', async () => {
    registerPaymentPolicy(allow('a', []));
    await runBeforePaymentAttempt(fakeTx, input);
    expect(executed).toEqual(['SAVEPOINT policy_hook', 'RELEASE SAVEPOINT policy_hook']);
  });

  it('a hook error rolls back to its savepoint and surfaces as unavailable', async () => {
    registerPaymentPolicy({
      id: 'broken',
      async beforePaymentAttempt() { throw new Error('boom'); },
    });
    const err = await runBeforePaymentAttempt(fakeTx, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentPolicyUnavailableError);
    expect((err as PaymentPolicyUnavailableError).policyId).toBe('broken');
    expect(executed).toEqual(['SAVEPOINT policy_hook', 'ROLLBACK TO SAVEPOINT policy_hook', 'RELEASE SAVEPOINT policy_hook']);
  });
});

describe('composition of the new hooks (pure)', () => {
  it('a duplicate reservation identity across policies is a composition error, raised before any reservation is created', async () => {
    const req = { kind: 'k', ownerKey: 'o' };
    registerPaymentPolicy({ id: 'first', async beforePaymentAttempt() { return { allow: true, reserve: [req] }; } });
    registerPaymentPolicy({ id: 'second', async beforePaymentAttempt() { return { allow: true, reserve: [req] }; } });
    const err = await runBeforePaymentAttempt(fakeTx, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentPolicyCompositionError);
    expect((err as PaymentPolicyCompositionError).policyIds).toEqual(['first', 'second']);
  });

  it('issuance metadata patches merge in registration order; no patch keeps the default ok result', async () => {
    expect(await runRevalidateForIssuance(fakeTx, { held: {} as HeldLocks } as RevalidateForIssuanceInput)).toEqual({ ok: true });
    registerPaymentPolicy({ id: 'p1', async beforePaymentAttempt() { return { allow: true }; }, async revalidateForIssuance() { return { ok: true, metadataPatch: { a: 1 } }; } });
    registerPaymentPolicy({ id: 'p2', async beforePaymentAttempt() { return { allow: true }; }, async revalidateForIssuance() { return { ok: true }; } });
    registerPaymentPolicy({ id: 'p3', async beforePaymentAttempt() { return { allow: true }; }, async revalidateForIssuance() { return { ok: true, metadataPatch: { b: 'x' } }; } });
    expect(await runRevalidateForIssuance(fakeTx, { held: {} as HeldLocks } as RevalidateForIssuanceInput)).toEqual({ ok: true, metadataPatch: { a: 1, b: 'x' } });
  });

  it('the same metadata key patched by two policies is a composition error', async () => {
    registerPaymentPolicy({ id: 'p1', async beforePaymentAttempt() { return { allow: true }; }, async revalidateForIssuance() { return { ok: true, metadataPatch: { k: 1 } }; } });
    registerPaymentPolicy({ id: 'p2', async beforePaymentAttempt() { return { allow: true }; }, async revalidateForIssuance() { return { ok: true, metadataPatch: { k: 2 } }; } });
    const err = await runRevalidateForIssuance(fakeTx, { held: {} as HeldLocks } as RevalidateForIssuanceInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentPolicyCompositionError);
    expect((err as PaymentPolicyCompositionError).policyIds).toEqual(['p1', 'p2']);
  });

  it('a failed issuance revalidation wins over patches from earlier policies', async () => {
    registerPaymentPolicy({ id: 'p1', async beforePaymentAttempt() { return { allow: true }; }, async revalidateForIssuance() { return { ok: true, metadataPatch: { k: 1 } }; } });
    registerPaymentPolicy({ id: 'p2', async beforePaymentAttempt() { return { allow: true }; }, async revalidateForIssuance() { return { ok: false, code: 'NOPE' }; } });
    expect(await runRevalidateForIssuance(fakeTx, { held: {} as HeldLocks } as RevalidateForIssuanceInput)).toEqual({ ok: false, code: 'NOPE' });
  });

  it('a terminal invoice decision wins in registration order; the default is apply', async () => {
    const seen: string[] = [];
    registerPaymentPolicy({ id: 'ok', async beforePaymentAttempt() { return { allow: true }; }, async authorizeInvoiceEffect() { seen.push('ok'); return { decision: 'apply' }; } });
    registerPaymentPolicy({ id: 'stop', async beforePaymentAttempt() { return { allow: true }; }, async authorizeInvoiceEffect() { seen.push('stop'); return { decision: 'terminal', code: 'X', adminTask: { title: 't', detail: 'd' } }; } });
    registerPaymentPolicy({ id: 'late', async beforePaymentAttempt() { return { allow: true }; }, async authorizeInvoiceEffect() { seen.push('late'); return { decision: 'apply' }; } });
    const out = await runAuthorizeInvoiceEffect(fakeTx, { held: {} as HeldLocks } as AuthorizeInvoiceEffectInput);
    expect(out).toMatchObject({ decision: 'terminal', code: 'X' });
    expect(seen).toEqual(['ok', 'stop']);
  });

  it('no policy answering terminal means apply, and a failing authorisation hook is unavailable', async () => {
    expect(await runAuthorizeInvoiceEffect(fakeTx, { held: {} as HeldLocks } as AuthorizeInvoiceEffectInput)).toEqual({ decision: 'apply' });
    registerPaymentPolicy({ id: 'broken', async beforePaymentAttempt() { return { allow: true }; }, async authorizeInvoiceEffect() { throw new Error('x'); } });
    await expect(runAuthorizeInvoiceEffect(fakeTx, { held: {} as HeldLocks } as AuthorizeInvoiceEffectInput)).rejects.toBeInstanceOf(PaymentPolicyUnavailableError);
  });

  it('the first failed issuance revalidation wins; the default is ok', async () => {
    expect(await runRevalidateForIssuance(fakeTx, { held: {} as HeldLocks } as RevalidateForIssuanceInput)).toEqual({ ok: true });
    registerPaymentPolicy({ id: 'bad', async beforePaymentAttempt() { return { allow: true }; }, async revalidateForIssuance() { return { ok: false, code: 'BAD' }; } });
    registerPaymentPolicy({ id: 'later', async beforePaymentAttempt() { return { allow: true }; }, async revalidateForIssuance() { return { ok: false, code: 'LATER' }; } });
    expect(await runRevalidateForIssuance(fakeTx, { held: {} as HeldLocks } as RevalidateForIssuanceInput)).toEqual({ ok: false, code: 'BAD' });
  });

  it('response shaping: the first override wins; a failing shaping hook is no override and never throws', async () => {
    registerPaymentPolicy({ id: 'broken', async beforePaymentAttempt() { return { allow: true }; }, async shapeSettlementResponse() { throw new Error('x'); } });
    registerPaymentPolicy({ id: 'first', async beforePaymentAttempt() { return { allow: true }; }, async shapeSettlementResponse() { return { status: 409, code: 'ORDER_NOT_PAYABLE' }; } });
    registerPaymentPolicy({ id: 'second', async beforePaymentAttempt() { return { allow: true }; }, async shapeSettlementResponse() { return { status: 409, code: 'OTHER' }; } });
    const out = await runShapeSettlementResponse(fakeTx, { route: 'pay', order: {} as never, recordedPaymentId: null, held: {} as HeldLocks });
    expect(out).toEqual({ status: 409, code: 'ORDER_NOT_PAYABLE' });
  });

  it('a transition projection failure surfaces as unavailable (the transition must not commit without its projection)', async () => {
    registerPaymentPolicy({ id: 'proj', async beforePaymentAttempt() { return { allow: true }; }, async onReservationTransition() { throw new Error('x'); } });
    const row = { id: 'r' } as never;
    await expect(dispatchReservationTransition(fakeTx, { reservation: row, from: null, to: 'held', cause: 'reserved' })).rejects.toBeInstanceOf(PaymentPolicyUnavailableError);
  });
});


describe('entitlement reversal hook (pure)', () => {
  const reversal = { storeId: 's1', orderId: 'o1', reason: 'full_refund', operationId: 'o1', held: {} as HeldLocks } as EntitlementReversalInput;

  it('an absent hook is a no-op: no savepoint, no error (standalone SellRight behaviour)', async () => {
    registerPaymentPolicy(allow('plain', []));
    await expect(runEntitlementReversal(fakeTx, reversal)).resolves.toBeUndefined();
    expect(executed).toEqual([]);
  });

  it('calls every registered policy in registration order, each inside its own savepoint', async () => {
    const calls: string[] = [];
    const hook = (id: string): PaymentPolicy => ({
      id, async beforePaymentAttempt() { return { allow: true }; },
      async onEntitlementReversal(_tx, i) { calls.push(`${id}:${i.reason}:${i.operationId}`); },
    });
    registerPaymentPolicy(hook('first'));
    registerPaymentPolicy(allow('plain', []));
    registerPaymentPolicy(hook('second'));
    await runEntitlementReversal(fakeTx, reversal);
    expect(calls).toEqual(['first:full_refund:o1', 'second:full_refund:o1']);
    expect(executed.filter((q) => q.includes('SAVEPOINT policy_hook')).length).toBe(4);
  });

  it('a throwing hook surfaces as unavailable and the savepoint is rolled back', async () => {
    registerPaymentPolicy({
      id: 'broken', async beforePaymentAttempt() { return { allow: true }; },
      async onEntitlementReversal() { throw new Error('boom'); },
    });
    await expect(runEntitlementReversal(fakeTx, reversal)).rejects.toBeInstanceOf(PaymentPolicyUnavailableError);
    expect(executed.some((q) => q.includes('ROLLBACK TO SAVEPOINT policy_hook'))).toBe(true);
  });
});

// ── checkout hooks (X-57 wire parity) ─────────────────────────────────────────────────────────────────
const held = {} as HeldLocks;
const policyOrder = { id: 'o1', storeId: 's1', code: 'C1', state: 'PendingPayment', currency: 'USD', grandTotal: 100, customerId: null, metadata: {} };
const bare = (id: string, hooks: Partial<PaymentPolicy> = {}): PaymentPolicy => ({ id, async beforePaymentAttempt() { return { allow: true }; }, ...hooks });
const replayInput = (origin: 'idempotency_key' | 'converted_cart' | 'unique_violation' = 'idempotency_key') =>
  ({ existingOrder: policyOrder, extensions: {}, customer: null, origin, held });
const checkoutInput = { order: policyOrder, lines: [], extensions: {}, customer: null, intent: { couponCode: 'C', giftCardCode: 'G', redeemPoints: 5 }, held };

describe('runCheckoutReplayAllowed', () => {
  it('no policy, or every policy allowing, is true', async () => {
    await expect(runCheckoutReplayAllowed(fakeTx, replayInput())).resolves.toBe(true);
    registerPaymentPolicy(bare('a', { async checkoutReplayAllowed() { return true; } }));
    await expect(runCheckoutReplayAllowed(fakeTx, replayInput())).resolves.toBe(true);
  });

  it('a bare false is the engine\'s generic 422 LEGAL_ACCEPTANCE_REQUIRED refusal', async () => {
    registerPaymentPolicy(bare('a', { async checkoutReplayAllowed() { return false; } }));
    await expect(runCheckoutReplayAllowed(fakeTx, replayInput())).resolves.toEqual({ status: 422, code: 'LEGAL_ACCEPTANCE_REQUIRED', message: 'checkout replay refused by payment policy' });
  });

  it('a structured refusal keeps the policy message; status and code default to 422 LEGAL_ACCEPTANCE_REQUIRED', async () => {
    registerPaymentPolicy(bare('a', { async checkoutReplayAllowed() { return { allow: false, message: 'owner only' }; } }));
    await expect(runCheckoutReplayAllowed(fakeTx, replayInput())).resolves.toEqual({ status: 422, code: 'LEGAL_ACCEPTANCE_REQUIRED', message: 'owner only' });
  });

  it('a structured refusal may set its own status, code and extras', async () => {
    registerPaymentPolicy(bare('a', { async checkoutReplayAllowed() { return { allow: false, message: 'm', code: 'X', status: 409, extra: { reason: 'r' } }; } }));
    await expect(runCheckoutReplayAllowed(fakeTx, replayInput())).resolves.toEqual({ status: 409, code: 'X', message: 'm', extra: { reason: 'r' } });
  });

  it('passes the replay origin to the policy and the first refusal wins', async () => {
    const seen: string[] = [];
    registerPaymentPolicy(bare('a', { async checkoutReplayAllowed(_tx, i) { seen.push(`a:${i.origin}`); return { allow: false, message: `a-${i.origin}` }; } }));
    registerPaymentPolicy(bare('b', { async checkoutReplayAllowed(_tx, i) { seen.push(`b:${i.origin}`); return false; } }));
    for (const origin of ['idempotency_key', 'converted_cart', 'unique_violation'] as const) {
      await expect(runCheckoutReplayAllowed(fakeTx, replayInput(origin))).resolves.toMatchObject({ message: `a-${origin}` });
    }
    expect(seen).toEqual(['a:idempotency_key', 'a:converted_cart', 'a:unique_violation']);
  });

  it('an invalid refusal status or an empty message fails closed', async () => {
    registerPaymentPolicy(bare('a', { async checkoutReplayAllowed() { return { allow: false, message: 'm', status: 500 as unknown as 409 }; } }));
    await expect(runCheckoutReplayAllowed(fakeTx, replayInput())).rejects.toBeInstanceOf(PaymentPolicyMetadataError);
    _resetPaymentPoliciesForTests();
    registerPaymentPolicy(bare('b', { async checkoutReplayAllowed() { return { allow: false, message: ' ' }; } }));
    await expect(runCheckoutReplayAllowed(fakeTx, replayInput())).rejects.toBeInstanceOf(PaymentPolicyMetadataError);
  });
});

describe('hasCheckoutReplayPolicy', () => {
  it('is true for a replay-authorization hook or a legacy-fingerprint hook, false otherwise', () => {
    expect(hasCheckoutReplayPolicy()).toBe(false);
    registerPaymentPolicy(bare('plain'));
    expect(hasCheckoutReplayPolicy()).toBe(false);
    registerPaymentPolicy(bare('legacy', { async legacyCheckoutFingerprint() { return null; } }));
    expect(hasCheckoutReplayPolicy()).toBe(true);
    _resetPaymentPoliciesForTests();
    registerPaymentPolicy(bare('replay', { async checkoutReplayAllowed() { return true; } }));
    expect(hasCheckoutReplayPolicy()).toBe(true);
  });
});

describe('runLegacyCheckoutFingerprints', () => {
  const request: CheckoutFingerprintBasis = {
    v: 1, cartToken: null, items: [{ sku: 'S', quantity: 1 }], couponCode: null, giftCardCode: null, shippingMethodCode: null,
    email: null, shippingAddress: null, billingAddress: null, legalAcceptance: null,
  };
  const legacyInput = { existingOrder: policyOrder, extensions: { a: { x: 1 } }, customer: null, origin: 'unique_violation' as const, request, held };

  it('collects string candidates in registration order, skipping null and empty, and passes request, origin and the policy\'s own block', async () => {
    const seen: unknown[] = [];
    registerPaymentPolicy(bare('a', { async legacyCheckoutFingerprint(_tx, i) { seen.push([i.origin, i.extensions, i.request]); return 'aa'; } }));
    registerPaymentPolicy(bare('none', { async legacyCheckoutFingerprint() { return null; } }));
    registerPaymentPolicy(bare('empty', { async legacyCheckoutFingerprint() { return ''; } }));
    registerPaymentPolicy(bare('plain'));
    registerPaymentPolicy(bare('b', { async legacyCheckoutFingerprint() { return 'bb'; } }));
    await expect(runLegacyCheckoutFingerprints(fakeTx, legacyInput)).resolves.toEqual(['aa', 'bb']);
    expect(seen).toEqual([['unique_violation', { x: 1 }, request]]);
  });

  it('no policy offers nothing; a throwing hook is unavailable', async () => {
    await expect(runLegacyCheckoutFingerprints(fakeTx, legacyInput)).resolves.toEqual([]);
    registerPaymentPolicy(bare('broken', { async legacyCheckoutFingerprint() { throw new Error('boom'); } }));
    await expect(runLegacyCheckoutFingerprints(fakeTx, legacyInput)).rejects.toBeInstanceOf(PaymentPolicyUnavailableError);
  });
});

describe('runCheckoutEligibility', () => {
  const eligibility = { storeId: 's1', currency: 'USD', lines: [], extensions: { a: { y: 2 } }, customer: null, intent: { giftCardCode: 'G' }, held };

  it('passes the intent and the policy\'s own extension block; ok proceeds', async () => {
    const seen: unknown[] = [];
    registerPaymentPolicy(bare('a', { async checkoutEligibility(_tx, i) { seen.push([i.intent, i.extensions, i.currency]); return { ok: true }; } }));
    await expect(runCheckoutEligibility(fakeTx, eligibility)).resolves.toBeUndefined();
    expect(seen).toEqual([[{ giftCardCode: 'G' }, { y: 2 }, 'USD']]);
  });

  it('a refusal throws PaymentPolicyRefusalError carrying status, code, message and extras; later policies do not run', async () => {
    const calls: string[] = [];
    registerPaymentPolicy(bare('a', { async checkoutEligibility() { calls.push('a'); return { ok: false, refusal: { status: 422, code: 'C', message: 'm', extra: { reason: 'r' } } }; } }));
    registerPaymentPolicy(bare('b', { async checkoutEligibility() { calls.push('b'); return { ok: true }; } }));
    const err = await runCheckoutEligibility(fakeTx, eligibility).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentPolicyRefusalError);
    expect((err as PaymentPolicyRefusalError).refusal).toEqual({ status: 422, code: 'C', message: 'm', extra: { reason: 'r' } });
    expect(calls).toEqual(['a']);
  });

  it('no policy with the hook is a no-op (no savepoint); a throwing hook is unavailable', async () => {
    registerPaymentPolicy(bare('plain'));
    await expect(runCheckoutEligibility(fakeTx, eligibility)).resolves.toBeUndefined();
    expect(executed).toEqual([]);
    registerPaymentPolicy(bare('broken', { async checkoutEligibility() { throw new Error('boom'); } }));
    await expect(runCheckoutEligibility(fakeTx, eligibility)).rejects.toBeInstanceOf(PaymentPolicyUnavailableError);
  });
});

describe('runOnCheckoutOrder (refusal, intent, promotion replacement)', () => {
  it('no policy: an empty outcome with no replacement', async () => {
    await expect(runOnCheckoutOrder(fakeTx, checkoutInput)).resolves.toEqual({ metadata: {}, adjustments: [], promotionReplacement: null });
  });

  it('passes the intent as sent', async () => {
    let seen: unknown;
    registerPaymentPolicy(bare('a', { async onCheckoutOrder(_tx, i) { seen = i.intent; return {}; } }));
    await runOnCheckoutOrder(fakeTx, checkoutInput);
    expect(seen).toEqual({ couponCode: 'C', giftCardCode: 'G', redeemPoints: 5 });
  });

  it('a refusal throws PaymentPolicyRefusalError; a veto keeps throwing PaymentPolicyVetoError', async () => {
    registerPaymentPolicy(bare('a', { async onCheckoutOrder() { return { refusal: { status: 409, code: 'C', message: 'm' } }; } }));
    const err = await runOnCheckoutOrder(fakeTx, checkoutInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentPolicyRefusalError);
    expect((err as PaymentPolicyRefusalError).refusal).toEqual({ status: 409, code: 'C', message: 'm' });
    _resetPaymentPoliciesForTests();
    registerPaymentPolicy(bare('b', { async onCheckoutOrder() { return { veto: { code: 'V', message: 'v' } }; } }));
    await expect(runOnCheckoutOrder(fakeTx, checkoutInput)).rejects.toBeInstanceOf(PaymentPolicyVetoError);
  });

  it('a veto and a refusal in one result is a malformed result', async () => {
    registerPaymentPolicy(bare('a', { async onCheckoutOrder() { return { veto: { code: 'V', message: 'v' }, refusal: { status: 422, code: 'R', message: 'r' } }; } }));
    await expect(runOnCheckoutOrder(fakeTx, checkoutInput)).rejects.toBeInstanceOf(PaymentPolicyMetadataError);
  });

  it('a promotion replacement is reported once; 0 is valid; negative, fractional or a second policy is refused', async () => {
    registerPaymentPolicy(bare('a', { async onCheckoutOrder() { return { replacePromotion: { fixedDiscount: 0 } }; } }));
    await expect(runOnCheckoutOrder(fakeTx, checkoutInput)).resolves.toMatchObject({ promotionReplacement: { fixedDiscount: 0 } });
    registerPaymentPolicy(bare('b', { async onCheckoutOrder() { return { replacePromotion: { fixedDiscount: 100 } }; } }));
    await expect(runOnCheckoutOrder(fakeTx, checkoutInput)).rejects.toBeInstanceOf(PaymentPolicyMetadataError);
    for (const bad of [-1, 1.5, Number.NaN]) {
      _resetPaymentPoliciesForTests();
      registerPaymentPolicy(bare('c', { async onCheckoutOrder() { return { replacePromotion: { fixedDiscount: bad } }; } }));
      await expect(runOnCheckoutOrder(fakeTx, checkoutInput)).rejects.toBeInstanceOf(PaymentPolicyMetadataError);
    }
  });
});
