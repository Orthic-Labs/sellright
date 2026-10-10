/**
 * Payment policy hooks beyond beforePaymentAttempt (PAYMENT-TIMING §3.1, §3.3, §3.7, §4.5, §4.6, §9),
 * against a real database: reservation creation from policy requests, projections on every reservation
 * transition, placement checks, operator override, purge gate, and the effect gates (authorizeInvoiceEffect,
 * revalidateForIssuance) on the real effects worker. Runs against a *_test database only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../../db/client.js';
import type { Tx } from '../../db/client.js';
import { withLockedSet, type HeldLocks, type LockPlanContribution } from '../../db/locks.js';
import { env } from '../../env.js';
import * as s from '../../db/schema.js';
import { enqueueEffects, runEffectsPass } from '../settlement/effects.js';
import { registerBuiltinEffectHandlers } from '../settlement/handlers.js';
import {
  consumeForSettlement, overrideRelease, purgeBlockedByReservations, purgeReservations, release, releaseOnFullRefund, reserve,
  ReservationRuleError,
} from '../reservation.js';
import {
  _resetPaymentPoliciesForTests, checkPlacement, PaymentPolicyCompositionError, PaymentPolicyUnavailableError, PaymentPolicyVetoError,
  registerPaymentPolicy, runBeforePaymentAttempt,
} from './host.js';
import type { PaymentPolicy, PolicyOrder, ReservationTransition } from './types.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`payment hook test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = '7a000000-0000-0000-0000-00000000a001';
const KIND = 'test.credit';
const O_PENDING = '7a100000-0000-0000-0000-000000000001';
const O_PAID = '7a100000-0000-0000-0000-000000000002';
const O_CANCELLED = '7a100000-0000-0000-0000-000000000003';
const O_REFUNDED = '7a100000-0000-0000-0000-000000000004';
const O_PURGE = '7a100000-0000-0000-0000-000000000005';
const O_PURGE_BLOCKED = '7a100000-0000-0000-0000-000000000006';
const O_EFFECT = '7a100000-0000-0000-0000-000000000007';
const O_EFFECT_OK = '7a100000-0000-0000-0000-000000000008';
const O_LINK = '7a100000-0000-0000-0000-000000000009';
const O_RENEW = '7a100000-0000-0000-0000-00000000000a';
const LICENSE_PLAN = '7a200000-0000-0000-0000-000000000001';
const LICENSE_RENEW = '7a200000-0000-0000-0000-000000000002';

const transitions: ReservationTransition[] = [];
let projectionFails = false;

/** A policy whose projection records every transition and optionally fails. */
const recorder: PaymentPolicy = {
  id: 'hook-recorder',
  async beforePaymentAttempt() { return { allow: true }; },
  async onReservationTransition(_tx, t) {
    if (projectionFails) throw new Error('projection failed');
    transitions.push(t);
  },
};

async function wipe(): Promise<void> {
  await pool.query('TRUNCATE store CASCADE');
}

async function seed(): Promise<void> {
  await pool.query(`INSERT INTO store (id, slug, name, currency, config) VALUES ($1, 'hooks-a', 'Hooks A', 'USD', '{}'::jsonb)`, [STORE]);
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO "order" (id, store_id, code, state, grand_total) VALUES
      (${O_PENDING}, ${STORE}, 'HK-1', 'PendingPayment', 1000),
      (${O_PAID}, ${STORE}, 'HK-2', 'Paid', 1000),
      (${O_CANCELLED}, ${STORE}, 'HK-3', 'PendingPayment', 1000),
      (${O_REFUNDED}, ${STORE}, 'HK-4', 'Paid', 1000),
      (${O_PURGE}, ${STORE}, 'HK-5', 'PendingPayment', 1000),
      (${O_PURGE_BLOCKED}, ${STORE}, 'HK-6', 'PendingPayment', 1000),
      (${O_EFFECT}, ${STORE}, 'HK-7', 'Paid', 1000),
      (${O_EFFECT_OK}, ${STORE}, 'HK-8', 'Paid', 1000),
      (${O_LINK}, ${STORE}, 'HK-9', 'Paid', 1000),
      (${O_RENEW}, ${STORE}, 'HK-10', 'Paid', 1000)`);
  });
}

const policyOrder = (id: string, state: string, code = 'X'): PolicyOrder => ({
  id, storeId: STORE, code, state, currency: 'USD', grandTotal: 1000, customerId: null, metadata: {},
});

const setState = (orderId: string, state: string) => withStore(STORE, (tx) => tx.execute(sql`UPDATE "order" SET state = ${state}::order_state WHERE id = ${orderId}`));
const reservationsOf = (orderId: string) => withStore(STORE, (tx) => tx.select().from(s.orderReservation).where(eq(s.orderReservation.orderId, orderId)));

/** Runs fn inside the order's lock set, the way every payment path does. */
const underOrderSet = <T>(orderId: string, fn: (tx: Tx, held: HeldLocks, plan: LockPlanContribution) => Promise<T>) =>
  withLockedSet(STORE, { kind: 'order', orderId }, fn);

beforeAll(() => {
  registerBuiltinEffectHandlers();
});

beforeEach(async () => {
  _resetPaymentPoliciesForTests();
  transitions.length = 0;
  projectionFails = false;
  await wipe();
  await seed();
});

afterAll(async () => {
  _resetPaymentPoliciesForTests();
  await wipe();
});

describe('policy reserve requests (PAYMENT-TIMING §3.1 hook 1, §3.3 R1)', () => {
  it('an allowing policy\'s reserve request creates a held row in the same transaction, projected as reserved', async () => {
    registerPaymentPolicy(recorder);
    registerPaymentPolicy({
      id: 'reserver',
      async beforePaymentAttempt() {
        return { allow: true, reserve: [{ kind: KIND, ownerKey: 'src-1', holder: { source: 'lic-1' } }] };
      },
    });
    await underOrderSet(O_PENDING, (tx, held) => runBeforePaymentAttempt(tx, {
      provider: 'stripe', purpose: 'checkout', order: policyOrder(O_PENDING, 'PendingPayment'), reservations: [], held,
    }));
    const rows = await reservationsOf(O_PENDING);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: KIND, ownerKey: 'src-1', state: 'held', holder: { source: 'lic-1' } });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ from: null, to: 'held', cause: 'reserved' });
  });

  it('a duplicate (kind, ownerKey) across policies is a composition error and nothing is created', async () => {
    registerPaymentPolicy({ id: 'a', async beforePaymentAttempt() { return { allow: true, reserve: [{ kind: KIND, ownerKey: 'dup' }] }; } });
    registerPaymentPolicy({ id: 'b', async beforePaymentAttempt() { return { allow: true, reserve: [{ kind: KIND, ownerKey: 'dup' }] }; } });
    const err = await underOrderSet(O_PENDING, (tx, held) => runBeforePaymentAttempt(tx, {
      provider: 'stripe', purpose: 'checkout', order: policyOrder(O_PENDING, 'PendingPayment'), reservations: [], held,
    })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentPolicyCompositionError);
    expect(await reservationsOf(O_PENDING)).toHaveLength(0);
    expect(transitions).toHaveLength(0);
  });

  it('a veto by a later policy discards the earlier policy\'s reservation (the whole attempt rolls back)', async () => {
    registerPaymentPolicy({ id: 'reserver', async beforePaymentAttempt() { return { allow: true, reserve: [{ kind: KIND, ownerKey: 'v-1' }] }; } });
    registerPaymentPolicy({ id: 'vetoer', async beforePaymentAttempt() { return { allow: false, veto: { code: 'NO', message: 'no' } }; } });
    await expect(underOrderSet(O_PENDING, async (tx, held) => {
      await runBeforePaymentAttempt(tx, { provider: 'stripe', purpose: 'checkout', order: policyOrder(O_PENDING, 'PendingPayment'), reservations: [], held });
    })).rejects.toBeInstanceOf(PaymentPolicyVetoError);
    expect(await reservationsOf(O_PENDING)).toHaveLength(0);
  });

  it('a failing projection aborts the transition: the reservation does not persist', async () => {
    projectionFails = true;
    registerPaymentPolicy(recorder);
    registerPaymentPolicy({ id: 'reserver', async beforePaymentAttempt() { return { allow: true, reserve: [{ kind: KIND, ownerKey: 'p-1' }] }; } });
    await expect(underOrderSet(O_PENDING, async (tx, held) => {
      await runBeforePaymentAttempt(tx, { provider: 'stripe', purpose: 'checkout', order: policyOrder(O_PENDING, 'PendingPayment'), reservations: [], held });
    })).rejects.toBeInstanceOf(PaymentPolicyUnavailableError);
    expect(await reservationsOf(O_PENDING)).toHaveLength(0);
  });
});

describe('lockPlan contributor (STOREKIT §5.3)', () => {
  it('a policy\'s lockPlan joins the plan of every set that covers the order', async () => {
    registerPaymentPolicy({
      id: 'planner',
      async beforePaymentAttempt() { return { allow: true }; },
      async lockPlan(): Promise<LockPlanContribution> {
        return { purchases: [], licenseIds: [LICENSE_PLAN], orderIds: [] };
      },
    });
    const plan = await underOrderSet(O_PENDING, async (_tx, _held, p) => p);
    expect(plan.licenseIds).toContain(LICENSE_PLAN);
  });
});

describe('reservation transitions are projected (PAYMENT-TIMING §3.3)', () => {
  it('consume on a Paid order is projected as consumed', async () => {
    registerPaymentPolicy(recorder);
    await underOrderSet(O_PAID, (tx, held) => reserve(tx, held, { storeId: STORE, orderId: O_PAID, kind: KIND, ownerKey: 'c-1' }));
    transitions.length = 0;
    await withStore(STORE, (tx) => consumeForSettlement(tx, { storeId: STORE, orderId: O_PAID, paymentId: null, operationId: 'op-consume-1' }));
    expect(transitions).toEqual([expect.objectContaining({ from: 'held', to: 'consumed', cause: 'consumed' })]);
  });

  it('a projection failure during settlement consume never aborts the settlement (X-45): consumed, audited', async () => {
    await underOrderSet(O_PAID, (tx, held) => reserve(tx, held, { storeId: STORE, orderId: O_PAID, kind: KIND, ownerKey: 'c-2' }));
    registerPaymentPolicy(recorder);
    projectionFails = true;
    // consume leaves the rollback projection unchanged (§3.3 R2), so the money-recording tx must still commit
    const out = await withStore(STORE, (tx) => consumeForSettlement(tx, { storeId: STORE, orderId: O_PAID, paymentId: null, operationId: 'op-consume-2' }));
    expect(out).toHaveLength(1);
    expect((await reservationsOf(O_PAID))[0]!.state).toBe('consumed');
    const audit = await withStore(STORE, (tx) => tx.execute(sql`SELECT action, data FROM audit_log WHERE entity_id = ${O_PAID} AND action = 'reservation_projection_failed'`));
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ data: { cause: 'consumed', operationId: 'op-consume-2' } });
  });

  it('a cancelled order\'s requested release is projected as order_cancelled', async () => {
    await underOrderSet(O_CANCELLED, (tx, held) => reserve(tx, held, { storeId: STORE, orderId: O_CANCELLED, kind: KIND, ownerKey: 'x-1' }));
    await setState(O_CANCELLED, 'Cancelled');
    registerPaymentPolicy(recorder);
    const out = await underOrderSet(O_CANCELLED, (tx, held) => release(tx, held, {
      storeId: STORE, orderId: O_CANCELLED, reason: 'admin_cancel', stripeDiscoverable: false,
    }));
    expect(out.released).toHaveLength(1);
    expect(transitions).toEqual([expect.objectContaining({ from: 'held', to: 'released', cause: 'order_cancelled' })]);
  });

  it('a full refund releases a consumed reservation that asked for it: projected as order_refunded', async () => {
    await underOrderSet(O_REFUNDED, (tx, held) => reserve(tx, held, {
      storeId: STORE, orderId: O_REFUNDED, kind: KIND, ownerKey: 'r-1', releaseOnFullRefund: true,
    }));
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE order_reservation SET state = 'consumed', consumed_at = now(), provider_terminal_at = now() WHERE order_id = ${O_REFUNDED}`));
    await setState(O_REFUNDED, 'Refunded');
    registerPaymentPolicy(recorder);
    const rows = await underOrderSet(O_REFUNDED, (tx, held) => releaseOnFullRefund(tx, held, { storeId: STORE, orderId: O_REFUNDED }));
    expect(rows).toHaveLength(1);
    expect(transitions).toEqual([expect.objectContaining({ from: 'consumed', to: 'released', cause: 'order_refunded' })]);
  });
});

describe('purge and operator override (PAYMENT-TIMING §3.5, §5.3)', () => {
  it('purge of an order with no provider work projects order_purged and deletes its reservations', async () => {
    await underOrderSet(O_PURGE, (tx, held) => reserve(tx, held, { storeId: STORE, orderId: O_PURGE, kind: KIND, ownerKey: 'p-1' }));
    registerPaymentPolicy(recorder);
    const blocked = await withStore(STORE, (tx) => purgeBlockedByReservations(tx, STORE, O_PURGE, { stripeDiscoverable: false }));
    expect(blocked).toBe(false);
    await underOrderSet(O_PURGE, (tx, held) => purgeReservations(tx, held, { storeId: STORE, orderId: O_PURGE }));
    expect(transitions).toEqual([expect.objectContaining({ from: 'held', to: 'released', cause: 'order_purged' })]);
    expect(await reservationsOf(O_PURGE)).toHaveLength(0);
  });

  it('purge is refused while a held reservation has non-quiescent provider work (an open Stripe intent)', async () => {
    await underOrderSet(O_PURGE_BLOCKED, (tx, held) => reserve(tx, held, { storeId: STORE, orderId: O_PURGE_BLOCKED, kind: KIND, ownerKey: 'pb-1' }));
    await withStore(STORE, (tx) => tx.execute(sql`INSERT INTO payment_attempt
      (store_id, order_id, operation, method, account_id, mode, amount, currency, idempotency_key, fingerprint, status)
      VALUES (${STORE}, ${O_PURGE_BLOCKED}, 'intent', 'stripe', 'acct', 'test', 1000, 'USD', 'pb-intent', 'fp', 'open')`));
    expect(await withStore(STORE, (tx) => purgeBlockedByReservations(tx, STORE, O_PURGE_BLOCKED, { stripeDiscoverable: false }))).toBe(true);
  });

  it('operator override releases a held reservation of a Cancelled order with unverified provider state and a reason', async () => {
    await underOrderSet(O_CANCELLED, (tx, held) => reserve(tx, held, { storeId: STORE, orderId: O_CANCELLED, kind: KIND, ownerKey: 'o-1' }));
    await setState(O_CANCELLED, 'Cancelled');
    registerPaymentPolicy(recorder);
    const rows = await underOrderSet(O_CANCELLED, (tx, held) => overrideRelease(tx, held, {
      storeId: STORE, orderId: O_CANCELLED, reason: 'provider confirmed no charge on dashboard',
    }));
    expect(rows[0]).toMatchObject({ state: 'released', releasedUnverified: true });
    expect(rows[0]!.releaseReason).toMatch(/^operator_override: /);
    expect(transitions).toEqual([expect.objectContaining({ from: 'held', to: 'released', cause: 'operator_override' })]);
  });

  it('operator override requires a Cancelled order and a reason of at least 10 characters', async () => {
    await underOrderSet(O_PENDING, (tx, held) => reserve(tx, held, { storeId: STORE, orderId: O_PENDING, kind: KIND, ownerKey: 'o-2' }));
    await expect(underOrderSet(O_PENDING, (tx, held) => overrideRelease(tx, held, {
      storeId: STORE, orderId: O_PENDING, reason: 'long enough reason here',
    }))).rejects.toBeInstanceOf(ReservationRuleError);
    await expect(underOrderSet(O_PENDING, (tx, held) => overrideRelease(tx, held, {
      storeId: STORE, orderId: O_PENDING, reason: 'short',
    }))).rejects.toBeInstanceOf(ReservationRuleError);
  });
});

describe('placement hooks (PAYMENT-TIMING §4.6, §3.6)', () => {
  it('a placement veto throws PaymentPolicyVetoError so the caller\'s transaction rolls back', async () => {
    registerPaymentPolicy({ id: 'placement-veto', async beforePaymentAttempt() { return { allow: false, veto: { code: 'PLACE_NO', message: 'no tender' } }; } });
    const err = await withStore(STORE, (tx) => checkPlacement(tx, STORE, policyOrder(O_PENDING, 'PendingPayment'), 'zero_total')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentPolicyVetoError);
  });

  it('a placement check on an allowing policy with a reserve request creates the reservation in the caller\'s transaction', async () => {
    registerPaymentPolicy({ id: 'placement-reserver', async beforePaymentAttempt() { return { allow: true, reserve: [{ kind: KIND, ownerKey: 'pl-1' }] }; } });
    await withStore(STORE, (tx) => checkPlacement(tx, STORE, policyOrder(O_PENDING, 'PendingPayment'), 'gift_card'));
    expect(await reservationsOf(O_PENDING)).toHaveLength(1);
  });
});

/** Effect rows for the real worker: a settlement_operation FK target plus one deferred effect. */
async function enqueue(orderId: string, kind: 'license_issue' | 'license_extend', payload: Record<string, unknown>, operationKind: string, operationId: string) {
  return withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO settlement_operation (store_id, operation_kind, operation_id, order_id) VALUES (${STORE}, ${operationKind}, ${operationId}, ${orderId}) ON CONFLICT DO NOTHING`);
    return enqueueEffects(tx, STORE, { kind: operationKind, id: operationId }, [{ kind, payload }]);
  });
}
const effectRow = (id: string) => withStore(STORE, async (tx) => (await tx.select().from(s.orderPendingEffect).where(eq(s.orderPendingEffect.id, id)).limit(1))[0]!);
const adminTasks = (action: string) => withStore(STORE, (tx) => tx.select().from(s.auditLog).where(eq(s.auditLog.action, action)));
const drain = () => runEffectsPass({ rounds: 3 });

describe('issuance effects are gated by the policy (PAYMENT-TIMING §3.7.5)', () => {
  it('revalidateForIssuance ok ⇒ the issuance effect completes', async () => {
    const [eff] = await enqueue(O_EFFECT_OK, 'license_issue', { orderId: O_EFFECT_OK, customerId: null, paidAt: new Date().toISOString() }, 'order_paid_transition', 'op-ok-1');
    registerPaymentPolicy({ id: 'reval-ok', async beforePaymentAttempt() { return { allow: true }; }, async revalidateForIssuance() { return { ok: true }; } });
    await drain();
    expect((await effectRow(eff!.id)).status).toBe('done');
  });

  it('revalidateForIssuance failure ⇒ the effect is terminal with an admin review row, and the audit records the policy audit', async () => {
    const [eff] = await enqueue(O_EFFECT, 'license_issue', { orderId: O_EFFECT, customerId: null, paidAt: new Date().toISOString() }, 'order_paid_transition', 'op-bad-1');
    registerPaymentPolicy({
      id: 'reval-bad', async beforePaymentAttempt() { return { allow: true }; },
      async revalidateForIssuance() {
        return { ok: false, code: 'CREDIT_INVALID', audit: { action: 'blocked_upgrade', data: { reason: 'source revoked' } } };
      },
    });
    await drain();
    const row = await effectRow(eff!.id);
    expect(row).toMatchObject({ status: 'terminal', lastError: 'CREDIT_INVALID' });
    const review = await withStore(STORE, (tx) => tx.select().from(s.orderPendingEffect).where(eq(s.orderPendingEffect.effectKind, 'admin_review')));
    expect(review.some((r) => r.operationId === 'op-bad-1' && r.status === 'terminal')).toBe(true);
    expect((await adminTasks('blocked_upgrade')).length).toBeGreaterThan(0);
  });

  it('a policy that cannot answer keeps the issuance effect pending (bounded retry), and the order is untouched', async () => {
    const [eff] = await enqueue(O_EFFECT, 'license_issue', { orderId: O_EFFECT, customerId: null, paidAt: new Date().toISOString() }, 'order_paid_transition', 'op-unav-1');
    registerPaymentPolicy({ id: 'reval-broken', async beforePaymentAttempt() { return { allow: true }; }, async revalidateForIssuance() { throw new Error('boom'); } });
    await drain();
    expect(await effectRow(eff!.id)).toMatchObject({ status: 'pending', lastError: 'policy_unavailable' });
    expect((await withStore(STORE, (tx) => tx.select().from(s.order).where(eq(s.order.id, O_EFFECT)).limit(1)))[0]!.state).toBe('Paid');
  });

  it('authorizeInvoiceEffect terminal on a first-cycle subscription issuance ⇒ terminal with the policy admin task, no entitlement change', async () => {
    const seen: string[] = [];
    registerPaymentPolicy({
      id: 'auth-first-cycle', async beforePaymentAttempt() { return { allow: true }; },
      async authorizeInvoiceEffect(_tx, i) {
        seen.push(`${i.effectKind}:${i.cycle}:${i.invoice.id}:${i.subscription.status}`);
        return { decision: 'terminal', code: 'LICENCE_REVOKED', adminTask: { title: 'Review first cycle', detail: 'source revoked' } };
      },
    });
    const [eff] = await enqueue(O_LINK, 'license_issue', {
      orderId: O_LINK, customerId: null, paidAt: new Date().toISOString(),
      link: { operationKind: 'stripe_invoice_paid', operationId: 'stripe_invoice_paid:in_link_1', stripeSubscriptionId: 'sub_link_1' },
    }, 'stripe_invoice_paid', 'stripe_invoice_paid:in_link_1');
    await drain();
    expect(seen).toEqual(['issuance:first_cycle:in_link_1:absent']);
    expect(await effectRow(eff!.id)).toMatchObject({ status: 'terminal', lastError: 'LICENCE_REVOKED' });
    expect((await adminTasks('policy_admin_task')).length).toBe(1);
  });

  it('authorizeInvoiceEffect terminal on a renewal ⇒ the licence expiry does not move; the renewal effect is terminal', async () => {
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`INSERT INTO license (id, store_id, app_key, license_key, status, source, order_id, expires_at)
        VALUES (${LICENSE_RENEW}, ${STORE}, 'app', 'key-renew', 'active', 'order', ${O_RENEW}, '2030-01-01T00:00:00Z')`);
      await tx.execute(sql`INSERT INTO subscription (store_id, stripe_subscription_id, status, license_id)
        VALUES (${STORE}, 'sub_renew_1', 'active', ${LICENSE_RENEW})`);
    });
    registerPaymentPolicy({
      id: 'auth-renewal', async beforePaymentAttempt() { return { allow: true }; },
      async authorizeInvoiceEffect(_tx, i) {
        expect(i.license?.id).toBe(LICENSE_RENEW);
        return { decision: 'terminal', code: 'LICENCE_REVOKED', adminTask: { title: 'Review renewal', detail: 'revoked' } };
      },
    });
    const [eff] = await enqueue(O_RENEW, 'license_extend', { stripeSubscriptionId: 'sub_renew_1', invoiceId: 'in_renew_1' }, 'stripe_invoice_paid', 'stripe_invoice_paid:in_renew_1');
    await drain();
    expect(await effectRow(eff!.id)).toMatchObject({ status: 'terminal', lastError: 'LICENCE_REVOKED' });
    const [lic] = await withStore(STORE, (tx) => tx.select().from(s.license).where(eq(s.license.id, LICENSE_RENEW)).limit(1));
    expect(lic!.expiresAt!.toISOString()).toBe('2030-01-01T00:00:00.000Z');
  });
});

describe('issuance metadata patch and gate on a licensed order (PAYMENT-TIMING §3.7.5)', () => {
  const O_QTY2 = '7a100000-0000-0000-0000-00000000000b';
  const O_NOPATCH = '7a100000-0000-0000-0000-00000000000c';
  const O_CONFLICT = '7a100000-0000-0000-0000-00000000000d';
  const O_BLOCKED = '7a100000-0000-0000-0000-00000000000e';

  /** A Paid order with one licence line of `qty` seats: the real issuance creates `qty` licence rows. */
  async function seedLicensedOrder(orderId: string, code: string, qty: number): Promise<void> {
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`INSERT INTO "order" (id, store_id, code, state, grand_total) VALUES (${orderId}, ${STORE}, ${code}, 'Paid', 1000)`);
      const p = (await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE}, ${'p-' + code}, 'P', 'active') RETURNING id`)).rows[0] as { id: string };
      const v = (await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, app_key, fulfillment_type)
        VALUES (gen_random_uuid(), ${STORE}, ${p.id}, ${'SKU-' + code}, 'Lic', 1000, 'app', 'license') RETURNING id`)).rows[0] as { id: string };
      await tx.execute(sql`INSERT INTO order_line (store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total)
        VALUES (${STORE}, ${orderId}, ${v.id}, ${'SKU-' + code}, 'Lic', ${qty}, 1000, ${1000 * qty}, ${1000 * qty})`);
    });
  }
  const licencesOf = (orderId: string) => withStore(STORE, (tx) => tx.select().from(s.license).where(eq(s.license.orderId, orderId)));
  /** Forces the effect's next attempt to be the terminal one (attempts = MAX_ATTEMPTS - 1, due now). */
  const primeLastAttempt = (effectId: string) => withStore(STORE, (tx) => tx.execute(sql`UPDATE order_pending_effect SET attempts = 7, next_attempt_at = now() WHERE id = ${effectId}`));
  const issuePayload = (orderId: string) => ({ orderId, customerId: null, paidAt: new Date().toISOString() });

  it('a patch from the policy is shallow-merged into every licence the order has', async () => {
    await seedLicensedOrder(O_QTY2, 'LIC-Q2', 2);
    registerPaymentPolicy({
      id: 'patcher', async beforePaymentAttempt() { return { allow: true }; },
      async revalidateForIssuance() { return { ok: true, metadataPatch: { mobile_upgrade_order_id: O_QTY2, patched: true } }; },
    });
    const [eff] = await enqueue(O_QTY2, 'license_issue', issuePayload(O_QTY2), 'order_paid_transition', 'op-patch-1');
    await drain();
    expect((await effectRow(eff!.id)).status).toBe('done');
    const rows = await licencesOf(O_QTY2);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.metadata).toMatchObject({ mobile_upgrade_order_id: O_QTY2, patched: true });
  });

  it('no patch from any policy leaves licence metadata untouched', async () => {
    await seedLicensedOrder(O_NOPATCH, 'LIC-NP', 1);
    registerPaymentPolicy({ id: 'no-patch', async beforePaymentAttempt() { return { allow: true }; }, async revalidateForIssuance() { return { ok: true }; } });
    const [eff] = await enqueue(O_NOPATCH, 'license_issue', issuePayload(O_NOPATCH), 'order_paid_transition', 'op-nopatch-1');
    await drain();
    expect((await effectRow(eff!.id)).status).toBe('done');
    const rows = await licencesOf(O_NOPATCH);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata ?? {}).not.toHaveProperty('patched');
  });

  it('conflicting patch keys are a composition error: no licence rows, retried, then terminal', async () => {
    await seedLicensedOrder(O_CONFLICT, 'LIC-CF', 1);
    registerPaymentPolicy({ id: 'cf-a', async beforePaymentAttempt() { return { allow: true }; }, async revalidateForIssuance() { return { ok: true, metadataPatch: { k: 'a' } }; } });
    registerPaymentPolicy({ id: 'cf-b', async beforePaymentAttempt() { return { allow: true }; }, async revalidateForIssuance() { return { ok: true, metadataPatch: { k: 'b' } }; } });
    const [eff] = await enqueue(O_CONFLICT, 'license_issue', issuePayload(O_CONFLICT), 'order_paid_transition', 'op-cf-1');
    await drain();
    expect(await effectRow(eff!.id)).toMatchObject({ status: 'pending', lastError: expect.stringContaining('composition conflict') });
    expect(await licencesOf(O_CONFLICT)).toHaveLength(0);
    await primeLastAttempt(eff!.id);
    await drain();
    expect(await effectRow(eff!.id)).toMatchObject({ status: 'terminal', lastError: expect.stringContaining('composition conflict') });
    expect(await licencesOf(O_CONFLICT)).toHaveLength(0);
  });

  it('ok:false blocks issuance before any licence row is written, and the policy audit is recorded', async () => {
    await seedLicensedOrder(O_BLOCKED, 'LIC-BK', 1);
    registerPaymentPolicy({
      id: 'blocker', async beforePaymentAttempt() { return { allow: true }; },
      async revalidateForIssuance() { return { ok: false, code: 'SOURCE_GONE', audit: { action: 'blocked_upgrade', data: { reason: 'gone' } } }; },
    });
    const [eff] = await enqueue(O_BLOCKED, 'license_issue', issuePayload(O_BLOCKED), 'order_paid_transition', 'op-bk-1');
    await drain();
    expect(await effectRow(eff!.id)).toMatchObject({ status: 'terminal', lastError: 'SOURCE_GONE' });
    expect(await licencesOf(O_BLOCKED)).toHaveLength(0);
    const audits = await withStore(STORE, (tx) => tx.select().from(s.auditLog).where(eq(s.auditLog.action, 'blocked_upgrade')));
    expect(audits.some((a) => a.entityId === O_BLOCKED && a.actor === 'system:policy')).toBe(true);
  });
});
