import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { refundStateFromStripe, refundTargetState, reconcileStripeRefund } from './webhook-reconcile.js';

describe('refundStateFromStripe', () => {
  it('maps Stripe refund status → our refund_state enum', () => {
    expect(refundStateFromStripe('succeeded')).toBe('Settled');
    expect(refundStateFromStripe('pending')).toBe('Pending');
    expect(refundStateFromStripe('failed')).toBe('Failed');
    expect(refundStateFromStripe('canceled')).toBe('Failed');
    expect(refundStateFromStripe('requires_action')).toBe('Failed');
  });
});

describe('refundTargetState', () => {
  it('no settled refunds → no transition', () => {
    expect(refundTargetState(0, 10000)).toBeNull();
    expect(refundTargetState(-5, 10000)).toBeNull();
  });
  it('partial refund → PartiallyRefunded', () => {
    expect(refundTargetState(2500, 10000)).toBe('PartiallyRefunded');
    expect(refundTargetState(9999, 10000)).toBe('PartiallyRefunded');
  });
  it('full (or over) refund → Refunded', () => {
    expect(refundTargetState(10000, 10000)).toBe('Refunded');
    expect(refundTargetState(10001, 10000)).toBe('Refunded'); // over-refund still terminal
  });
});

// ── DB-gated: reconcileStripeRefund (dashboard/API refund reconciliation) ────
// New coverage below is skipIf-gated (not a hard throw) on purpose: this file
// is otherwise a pure-function suite that runs under the plain `test` script
// with no DB. This module's `test` script excludes are an explicit file list
// in package.json — which is out of scope to edit here — so skipIf keeps
// `pnpm test` green with no DB reachable (tests report skipped, not failed)
// while still running for real under a genuine `_test` DATABASE_URL (e.g.
// `pnpm test:db` after adding this file to that list, or any CI wired to a
// live sellright_test).
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
const isTestDb = /_test(\b|$|\?)/.test(DB);

const STORE = '11111111-1111-1111-1111-111111111111';
const SLUG = 'webhook-reconcile-test-store';

async function wipe() { await pool.query('TRUNCATE store CASCADE'); }

async function seedPaidOrderWithEndpoint(code: string, piId: string, grandTotal = 2000): Promise<{ orderId: string }> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`
      INSERT INTO store (id, slug, name, currency, config)
      VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING`);
    // Subscribed to '*' so emitEvent('order.refunded', ...) always enqueues a
    // delivery row — the observable proof that the event actually fired.
    await tx.execute(sql`
      INSERT INTO webhook_endpoint (id, store_id, url, topics, secret)
      VALUES (gen_random_uuid(), ${STORE}, 'https://example.test/hook', ARRAY['*'], 'whsec_test')
      ON CONFLICT DO NOTHING`);
  });
  const orderId = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, grand_total)
      VALUES (gen_random_uuid(), ${STORE}, ${code}, 'Paid'::order_state, 'USD', ${grandTotal})
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`
      INSERT INTO payment (id, store_id, order_id, amount, method, state, provider_ref)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, ${grandTotal}, 'stripe', 'Settled', ${piId})`);
  });
  return { orderId };
}

async function refundDeliveryCount(): Promise<number> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT count(*)::int AS n FROM webhook_delivery WHERE topic = 'order.refunded'`);
    return (r.rows[0] as { n: number }).n;
  });
}

async function orderState(orderId: string): Promise<string> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT state FROM "order" WHERE id = ${orderId}`);
    return (r.rows[0] as { state: string }).state;
  });
}

describe.skipIf(!isTestDb)('reconcileStripeRefund — DB integration', () => {
  beforeEach(async () => { await wipe(); });
  afterAll(async () => { await wipe(); });

  it('a SECOND still-partial dashboard refund still emits order.refunded (FSM has no PartiallyRefunded self-edge, but the event must not be suppressed)', async () => {
    const { orderId } = await seedPaidOrderWithEndpoint('SR-WHR-1', 'pi_whr_1', 4000);

    await withStore(STORE, (tx) => reconcileStripeRefund(tx, STORE, { reId: 're_1', amount: 1000, status: 'succeeded', piId: 'pi_whr_1' }));
    expect(await orderState(orderId)).toBe('PartiallyRefunded');
    expect(await refundDeliveryCount()).toBe(1); // first refund emits

    // Second refund: total refunded (2000) is still < grandTotal (4000), so
    // target state is AGAIN 'PartiallyRefunded' — the exact case the FSM has
    // no self-edge for. Before the fix this returned early and skipped the
    // event entirely.
    await withStore(STORE, (tx) => reconcileStripeRefund(tx, STORE, { reId: 're_2', amount: 1000, status: 'succeeded', piId: 'pi_whr_1' }));
    expect(await orderState(orderId)).toBe('PartiallyRefunded'); // state write correctly a no-op
    expect(await refundDeliveryCount()).toBe(2); // but the event STILL fired
  });

  it('a refund.* event whose payment_intent has no matching payment row throws (rolls back, forces a Stripe retry) instead of silently dropping the refund', async () => {
    await seedPaidOrderWithEndpoint('SR-WHR-2', 'pi_whr_2_known', 2000);
    await expect(
      withStore(STORE, (tx) => reconcileStripeRefund(tx, STORE, { reId: 're_orphan', amount: 500, status: 'succeeded', piId: 'pi_NEVER_SEEN' })),
    ).rejects.toThrow();
    // Nothing was recorded — no partial/incorrect ledger state was left behind.
    const n = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT count(*)::int AS n FROM refund WHERE provider_ref = 're_orphan'`);
      return (r.rows[0] as { n: number }).n;
    });
    expect(n).toBe(0);
  });
});
