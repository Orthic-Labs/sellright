/**
 * Entitlement reversal (de-fork policy hook onEntitlementReversal; PAYMENT-TIMING §4.5, X-45). A full refund that
 * moves an order to Refunded, and a chargeback recorded as lost, each enqueue one deferred `entitlement_reversal`
 * effect. The effects worker calls every registered policy hook under the order's lock set. Money and order state
 * are recorded before the worker runs and are never rolled back by a policy failure. Runs against a *_test database only.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../../db/client.js';
import * as s from '../../db/schema.js';
import { env } from '../../env.js';
import { _resetPaymentPoliciesForTests, registerPaymentPolicy } from '../policy/host.js';
import type { EntitlementReversalInput, PaymentPolicy } from '../policy/types.js';
import { recordStripeDispute } from '../webhook-reconcile.js';
import { finalizeRefund } from '../refunds.js';
import { MAX_ATTEMPTS, runEffectsPass } from './effects.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`entitlement reversal test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'e7000000-0000-0000-0000-00000000e701';
const calls: EntitlementReversalInput[] = [];
let failWith: Error | null = null;

const spy: PaymentPolicy = {
  id: 'reversal-spy',
  async beforePaymentAttempt() { return { allow: true }; },
  async onEntitlementReversal(_tx, i) {
    calls.push(i);
    if (failWith) throw failWith;
  },
};

async function seedStore(): Promise<void> {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query(`INSERT INTO store (id, slug, name, currency, config) VALUES ($1, 'reversal-a', 'Reversal A', 'USD', '{}'::jsonb)`, [STORE]);
}

async function seedPaidOrder(grandTotal = 1000): Promise<{ orderId: string; paymentId: string }> {
  const orderId = randomUUID();
  return withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO "order" (id, store_id, code, state, grand_total) VALUES (${orderId}, ${STORE}, ${'RV-' + orderId.slice(0, 6)}, 'Paid', ${grandTotal})`);
    const [p] = await tx.insert(s.payment).values({ storeId: STORE, orderId, amount: grandTotal, currency: 'USD', method: 'stripe', providerRef: 'pi_' + orderId.slice(0, 8), state: 'Settled' }).returning({ id: s.payment.id });
    return { orderId, paymentId: p!.id };
  });
}

/** A refund attempt + Pending refund row, ready for finalizeRefund. Returns the attempt id. */
async function seedRefund(orderId: string, paymentId: string, amount: number): Promise<string> {
  return withStore(STORE, async (tx) => {
    const [att] = await tx.insert(s.paymentAttempt).values({
      storeId: STORE, orderId, paymentId, operation: 'refund', method: 'stripe', accountId: 'acct_test', mode: 'test',
      amount, currency: 'USD', idempotencyKey: randomUUID(), fingerprint: randomUUID(), status: 'processing',
    }).returning({ id: s.paymentAttempt.id });
    await tx.insert(s.refund).values({ storeId: STORE, attemptId: att!.id, paymentId, orderId, amount, state: 'Pending', metadata: { actor: 'test' } });
    return att!.id;
  });
}

const settle = (attemptId: string) => withStore(STORE, (tx) => finalizeRefund(tx, STORE, attemptId, { state: 'Settled', providerRef: 're_' + attemptId.slice(0, 8) }));
const orderState = (orderId: string) => withStore(STORE, async (tx) => (await tx.select({ state: s.order.state }).from(s.order).where(sql`id = ${orderId}`))[0]!.state);
const reversalEffects = (opKind: string) => withStore(STORE, (tx) => tx.select().from(s.orderPendingEffect)
  .where(sql`effect_kind = 'entitlement_reversal' AND operation_kind = ${opKind}`));
const refundStates = (orderId: string) => withStore(STORE, (tx) => tx.select({ state: s.refund.state }).from(s.refund).where(sql`order_id = ${orderId}`));

beforeEach(async () => {
  calls.length = 0;
  failWith = null;
  _resetPaymentPoliciesForTests();
  registerPaymentPolicy(spy);
  await seedStore();
});

afterAll(() => { _resetPaymentPoliciesForTests(); });

describe('full refund -> entitlement_reversal', () => {
  it('a full refund enqueues one deferred effect; the worker calls the policy once with full_refund', async () => {
    const { orderId, paymentId } = await seedPaidOrder(1000);
    await settle(await seedRefund(orderId, paymentId, 1000));
    expect(await orderState(orderId)).toBe('Refunded');
    const rows = await reversalEffects('order_refunded');
    expect(rows.map((r) => [r.status, r.operationId])).toEqual([['pending', orderId]]);
    expect(calls).toEqual([]); // deferred: not run in the recording transaction
    await runEffectsPass({ rounds: 2 });
    expect(calls.map((c) => [c.reason, c.orderId, c.operationId, c.storeId])).toEqual([['full_refund', orderId, orderId, STORE]]);
    expect((await reversalEffects('order_refunded'))[0]!.status).toBe('done');
  });

  it('a replayed finalize records no second effect and the policy is still called once', async () => {
    const { orderId, paymentId } = await seedPaidOrder(1000);
    const attemptId = await seedRefund(orderId, paymentId, 1000);
    await settle(attemptId);
    await settle(attemptId);
    expect((await reversalEffects('order_refunded')).length).toBe(1);
    await runEffectsPass({ rounds: 2 });
    expect(calls.length).toBe(1);
  });

  it('a partial refund enqueues no reversal effect', async () => {
    const { orderId, paymentId } = await seedPaidOrder(1000);
    await settle(await seedRefund(orderId, paymentId, 400));
    expect(await orderState(orderId)).toBe('PartiallyRefunded');
    expect(await reversalEffects('order_refunded')).toEqual([]);
    await runEffectsPass({ rounds: 2 });
    expect(calls).toEqual([]);
  });
});

describe('chargeback opened -> entitlement_reversal (fork parity: revoke on open)', () => {
  const disputeOpened = (piId: string | null, disputeId: string) => withStore(STORE, (tx) => recordStripeDispute(tx, STORE, {
    disputeId, amount: 1000, reason: 'fraudulent', status: 'needs_response', piId,
  }));
  const openedEffects = () => reversalEffects('dispute_opened');

  it('a dispute created against a stored payment enqueues one effect; the policy is called once with chargeback', async () => {
    const { orderId } = await seedPaidOrder(1000);
    const pi = 'pi_' + orderId.slice(0, 8);
    await disputeOpened(pi, 'dp_open_1');
    const rows = await openedEffects();
    expect(rows.map((r) => [r.operationId, r.status])).toEqual([['stripe_dispute:dp_open_1', 'pending']]);
    expect(await orderState(orderId)).toBe('Paid'); // no money or order-state change on a chargeback
    expect(calls).toEqual([]); // deferred
    await runEffectsPass({ rounds: 2 });
    expect(calls.map((c) => [c.reason, c.orderId, c.operationId])).toEqual([['chargeback', orderId, 'stripe_dispute:dp_open_1']]);
  });

  it('a duplicate webhook delivery records no second effect and the policy is called once', async () => {
    const { orderId } = await seedPaidOrder(1000);
    const pi = 'pi_' + orderId.slice(0, 8);
    await disputeOpened(pi, 'dp_dup_1');
    await disputeOpened(pi, 'dp_dup_1');
    expect((await openedEffects()).length).toBe(1);
    await runEffectsPass({ rounds: 2 });
    expect(calls.length).toBe(1);
  });

  it('a dispute with no matching payment records no effect', async () => {
    await seedPaidOrder(1000);
    await disputeOpened('pi_no_such_payment', 'dp_orphan_1');
    expect(await openedEffects()).toEqual([]);
    await runEffectsPass({ rounds: 2 });
    expect(calls).toEqual([]);
  });
});

describe('policy failure isolation', () => {
  it('a throwing policy is retried, then terminal with an admin_review task; refund row and order state are untouched', async () => {
    const { orderId, paymentId } = await seedPaidOrder(1000);
    await settle(await seedRefund(orderId, paymentId, 1000));
    failWith = new Error('policy down');
    const [effect] = await reversalEffects('order_refunded');
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      await withStore(STORE, (tx) => tx.execute(sql`UPDATE order_pending_effect SET next_attempt_at = now() - interval '1 second' WHERE status = 'pending'`));
      await runEffectsPass({ rounds: 1 });
    }
    const [after] = await withStore(STORE, (tx) => tx.select().from(s.orderPendingEffect).where(sql`id = ${effect!.id}`));
    expect(after!.status).toBe('terminal');
    expect(after!.attempts).toBe(MAX_ATTEMPTS);
    const reviews = await withStore(STORE, (tx) => tx.select().from(s.orderPendingEffect)
      .where(sql`operation_kind = 'order_refunded' AND operation_id = ${orderId} AND effect_kind = 'admin_review'`));
    expect(reviews.map((r) => r.status)).toEqual(['terminal']);
    const audits = await withStore(STORE, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'effect_terminal' AND entity_id = ${effect!.id}`));
    expect((audits.rows[0] as { n: number }).n).toBe(1);
    expect(await refundStates(orderId)).toEqual([{ state: 'Settled' }]);
    expect(await orderState(orderId)).toBe('Refunded');
  });
});
