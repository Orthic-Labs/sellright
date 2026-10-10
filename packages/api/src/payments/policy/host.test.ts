// Payment policy host: registration, composition, veto and SAVEPOINT isolation (pure, no database).
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tx } from '../../db/client.js';
import type { HeldLocks } from '../../db/locks.js';

const assertHeld = vi.fn(async () => undefined);
vi.mock('../../db/locks.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../db/locks.js')>()), assertHeld: (...a: unknown[]) => assertHeld(...(a as [])) }));

import {
  PaymentPolicyCompositionError, PaymentPolicyUnavailableError, PaymentPolicyVetoError, _resetPaymentPoliciesForTests, registerPaymentPolicy,
  registeredPaymentPolicies, runAuthorizeInvoiceEffect, runBeforePaymentAttempt, runRevalidateForIssuance, runShapeSettlementResponse,
} from './host.js';
import { dispatchReservationTransition } from './transitions.js';
import { SELLRIGHT_DEFAULT_POLICY_ID, installDefaultPaymentPolicy } from './default-policy.js';
import type { AuthorizeInvoiceEffectInput, BeforePaymentAttemptInput, PaymentPolicy, RevalidateForIssuanceInput } from './types.js';

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

