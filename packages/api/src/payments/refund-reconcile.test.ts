/**
 * DB tests — SR-04: provider refund outcomes converge on the SAME durable
 * refund attempt, never a second settled refund row.
 *
 *   - timeout-after-acceptance: requestRefund's provider call resolves to
 *     Pending with NO providerRef (the response was lost). The inbound
 *     refund.* webhook still carries the stamped attempt id (Stripe echoes
 *     refund metadata) and/or matches the unique unbound reservation by
 *     amount — the shared finalizer settles THAT reservation exactly once.
 *   - duplicate + out-of-order webhooks are no-ops (never downgrade Settled).
 *   - ambiguous correlations quarantine to an operator-visible gateway_event
 *     instead of guessing (a wrong bind would apply another refund's stock
 *     effects — irreversible).
 *   - verifyGatewayAttempt's refund branch is the operator recovery path:
 *     it queries the provider read-only and converges via the same finalizer.
 *   - definitive settlement enqueues the 'order-refund-confirmation' email
 *     exactly once (dedupeKey per refund id).
 *
 * The provider boundary is stubbed (getProvider / listStripeRefunds) — no real
 * gateway calls. Runs against a *_test database only.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefundResult } from './provider.js';
import type { StripeRefundLike } from './stripe.js';

// ── Stubbed provider surface (no real gateway calls) ─────────────────────────
let stripeRefundImpl: () => Promise<RefundResult> = async () => ({ state: 'Pending', providerRef: null, errorMessage: 'lost' });
let stripeRefunds: StripeRefundLike[] = [];

vi.mock('./provider.js', async (orig) => {
  const actual = await orig<typeof import('./provider.js')>();
  return {
    ...actual,
    getProvider: (method: string) => {
      if (method !== 'stripe') return actual.getProvider(method);
      return {
        method: 'stripe',
        requiresRedirect: false,
        async createPayment() { throw new Error('not used in this test'); },
        async refundPayment() { return stripeRefundImpl(); },
      };
    },
  };
});

vi.mock('./stripe.js', async (orig) => {
  const actual = await orig<typeof import('./stripe.js')>();
  return {
    ...actual,
    listStripeRefunds: async () => stripeRefunds,
  };
});

import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { requestRefund } from './refunds.js';
import { reconcileStripeRefund, STRIPE_REFUND_ATTEMPT_KEY } from './webhook-reconcile.js';
import { verifyGatewayAttempt } from './gateway-payment.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
const isTestDb = /_test(\b|$|\?)/.test(DB);

const STORE = 'eeeeeeee-5555-5555-5555-555555555555';
const SLUG = 'refund-reconcile-test';
const VARIANT = 'eeeeeeee-5555-5555-5555-55555555550b';

async function wipe() { await pool.query('TRUNCATE store CASCADE'); }

/** Paid order: one line (qty 1, fulfilled — a restockable return), stock row,
 *  a Settled stripe payment with persisted gateway_mode, and a contact email
 *  so the refund-confirmation outbox row has a recipient. */
async function seedPaidOrder(code: string, grandTotal = 2000): Promise<{ orderId: string; lineId: string }> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config)
      VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO webhook_endpoint (id, store_id, url, topics, secret)
      VALUES (gen_random_uuid(), ${STORE}, 'https://example.test/hook', ARRAY['*'], 'whsec_test') ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status)
      VALUES (gen_random_uuid(), ${STORE}, 'p', 'P', 'active') ON CONFLICT DO NOTHING`);
  });
  const pid = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT id FROM product WHERE store_id = ${STORE} LIMIT 1`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price, app_key)
      VALUES (${VARIANT}, ${STORE}, ${pid}, 'SKU1', 'V1', 2000, 'app')
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated)
      VALUES (${VARIANT}, ${STORE}, 10, 0) ON CONFLICT (variant_id) DO UPDATE SET on_hand = 10, allocated = 0`);
  });
  const orderId = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, grand_total, metadata)
      VALUES (gen_random_uuid(), ${STORE}, ${code}, 'Paid'::order_state, 'USD', ${grandTotal},
        ${JSON.stringify({ contact: { email: 'buyer@example.test' } })}::jsonb)
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  const lineId = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO order_line (id, store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, ${VARIANT}, 'SKU1', 'V1', 1, ${grandTotal}, ${grandTotal}, ${grandTotal}, 1)
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`
      INSERT INTO payment (id, store_id, order_id, amount, method, state, provider_ref, gateway_mode, currency)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, ${grandTotal}, 'stripe', 'Settled', ${'pi_' + code}, 'test', 'USD')`);
  });
  return { orderId, lineId };
}

/** Reserve a pending refund exactly like the request path leaves it when the
 *  provider response is lost: Pending, providerRef NULL, effects not applied. */
async function reservePendingRefund(orderId: string, key: string, amount: number, lineId?: string): Promise<{ attemptId: string; refundId: string }> {
  stripeRefundImpl = async () => ({ state: 'Pending', providerRef: null, errorMessage: 'Stripe refund outcome requires reconciliation' });
  await requestRefund({
    storeId: STORE, orderId, actor: 'test', idempotencyKey: key, amount,
    ...(lineId ? { lines: [{ orderLineId: lineId, quantity: 1, restock: true }] } : {}),
  });
  const row = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT id, attempt_id, state, provider_ref FROM refund WHERE order_id = ${orderId} ORDER BY created_at`);
    return r.rows as Array<{ id: string; attempt_id: string; state: string; provider_ref: string | null }>;
  });
  const mine = row[row.length - 1]!;
  expect(mine.state).toBe('Pending');
  expect(mine.provider_ref).toBeNull();
  return { attemptId: mine.attempt_id, refundId: mine.id };
}

async function refundRows(orderId: string) {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT id, attempt_id, amount, state, provider_ref FROM refund WHERE order_id = ${orderId} ORDER BY created_at`);
    return r.rows as Array<{ id: string; attempt_id: string | null; amount: number; state: string; provider_ref: string | null }>;
  });
}
// These tables carry FORCE ROW LEVEL SECURITY and the migration-owner pool
// role is NOT BYPASSRLS — a bare pool.query() with no app.current_store set
// sees zero rows regardless of what actually committed. Route every read
// through withStore() like the rest of this file already does.
async function scalar(q: string): Promise<number> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql.raw(q));
    return Number((r.rows[0] as { n: number }).n);
  });
}
const stockMovements = () => scalar(`SELECT count(*)::int AS n FROM stock_movement WHERE store_id = '${STORE}'`);
const refundEmails = () => scalar(`SELECT count(*)::int AS n FROM email_outbox WHERE store_id = '${STORE}' AND kind = 'order-refund-confirmation'`);
const manualEvents = () => scalar(`SELECT count(*)::int AS n FROM gateway_event WHERE store_id = '${STORE}' AND status = 'manual'`);
const orderState = async (orderId: string) => {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT state FROM "order" WHERE id = ${orderId}`);
    return (r.rows[0] as { state: string }).state;
  });
};

describe.skipIf(!isTestDb)('SR-04 refund correlation — webhook converges on the durable attempt', () => {
  beforeEach(async () => {
    await wipe();
    stripeRefundImpl = async () => ({ state: 'Pending', providerRef: null, errorMessage: 'lost' });
    stripeRefunds = [];
  });
  afterAll(async () => { await wipe(); await pool.end(); });

  async function seedLicense(orderId: string, lineId: string) {
    return withStore(STORE, async tx => {
      const result = await tx.execute(sql`INSERT INTO license(store_id,order_id,order_line_id,app_key,license_key)
        VALUES (${STORE},${orderId},${lineId},'app',${'license-' + orderId}) RETURNING id`);
      const id = (result.rows[0] as { id: string }).id;
      await tx.execute(sql`INSERT INTO license_activation(store_id,license_id,app_key,device_id_hash,generation)
        VALUES (${STORE},${id},'app','device',4)`);
      return id;
    });
  }

  async function licenseState(id: string) {
    return withStore(STORE, async tx => {
      const result = await tx.execute(sql`SELECT l.status,a.state,a.generation,a.revoked_at IS NOT NULL AS tombstoned
        FROM license l JOIN license_activation a ON a.license_id=l.id WHERE l.id=${id}`);
      return result.rows[0];
    });
  }

  it('partial refunds preserve licences; a full cumulative refund revokes only that order and replay is a no-op', async () => {
    const target = await seedPaidOrder('SR-LIC-REFUND');
    const other = await seedPaidOrder('SR-LIC-KEEP');
    const licenseId = await seedLicense(target.orderId, target.lineId);
    const otherId = await seedLicense(other.orderId, other.lineId);
    stripeRefundImpl = async () => ({ state: 'Settled', providerRef: 're_partial_lic' });
    const input = { storeId: STORE, orderId: target.orderId, actor: 'test' };
    await requestRefund({ ...input, amount: 500, idempotencyKey: 'lic-partial' });
    expect(await licenseState(licenseId)).toMatchObject({ status: 'active', state: 'active', generation: 4 });
    stripeRefundImpl = async () => ({ state: 'Settled', providerRef: 're_final_lic' });
    await requestRefund({ ...input, amount: 1500, idempotencyKey: 'lic-final' });
    await requestRefund({ ...input, amount: 1500, idempotencyKey: 'lic-final' });
    expect(await licenseState(licenseId)).toMatchObject({ status: 'revoked', state: 'revoked', generation: 5, tombstoned: true });
    expect(await licenseState(otherId)).toMatchObject({ status: 'active', state: 'active', generation: 4 });
  });

  it('pending/failed refunds preserve access; real reconciliation revokes once on definitive full settlement', async () => {
    const { orderId, lineId } = await seedPaidOrder('SR-LIC-WEBHOOK');
    const licenseId = await seedLicense(orderId, lineId);
    const { attemptId } = await reservePendingRefund(orderId, 'lic-webhook', 2000);
    expect(await licenseState(licenseId)).toMatchObject({ status: 'active', state: 'active', generation: 4 });
    const event = { reId: 're_lic_webhook', amount: 2000, piId: 'pi_SR-LIC-WEBHOOK', attemptId };
    await withStore(STORE, tx => reconcileStripeRefund(tx, STORE, { ...event, status: 'failed' }, { mode: 'test' }));
    expect(await licenseState(licenseId)).toMatchObject({ status: 'active', state: 'active', generation: 4 });
    await withStore(STORE, tx => reconcileStripeRefund(tx, STORE, { ...event, status: 'succeeded' }, { mode: 'test' }));
    await withStore(STORE, tx => reconcileStripeRefund(tx, STORE, { ...event, status: 'succeeded' }, { mode: 'test' }));
    expect(await licenseState(licenseId)).toMatchObject({ status: 'revoked', state: 'revoked', generation: 5, tombstoned: true });
  });

  it('timeout-after-acceptance: the stamped attempt id binds the provider refund to the SAME reservation — effects once', async () => {
    const { orderId, lineId } = await seedPaidOrder('SR-RC-1', 2000);
    const { attemptId } = await reservePendingRefund(orderId, 'k-1', 500, lineId);

    await withStore(STORE, (tx) => reconcileStripeRefund(tx, STORE, {
      reId: 're_timeout_1', amount: 500, status: 'succeeded', piId: 'pi_SR-RC-1', attemptId,
    }, { mode: 'test' }));

    const rows = await refundRows(orderId);
    expect(rows).toHaveLength(1); // NO second refund row
    expect(rows[0]).toMatchObject({ attempt_id: attemptId, state: 'Settled', provider_ref: 're_timeout_1' });
    expect(await orderState(orderId)).toBe('PartiallyRefunded');
    expect(await stockMovements()).toBe(1); // restock applied exactly once
    expect(await refundEmails()).toBe(1); // refund-confirmation enqueued once

    const attempt = await withStore(STORE, (tx) => tx.execute(sql`SELECT status, provider_ref FROM payment_attempt WHERE id = ${attemptId}`));
    expect(attempt.rows[0]).toMatchObject({ status: 'settled', provider_ref: 're_timeout_1' });
  });

  it('duplicate + out-of-order webhooks: settled once, never downgraded, email still exactly once', async () => {
    const { orderId, lineId } = await seedPaidOrder('SR-RC-2', 2000);
    const { attemptId } = await reservePendingRefund(orderId, 'k-2', 500, lineId);

    // refund.updated 'succeeded' lands BEFORE refund.created 'pending'.
    await withStore(STORE, (tx) => reconcileStripeRefund(tx, STORE, {
      reId: 're_ooo_1', amount: 500, status: 'succeeded', piId: 'pi_SR-RC-2', attemptId,
    }));
    await withStore(STORE, (tx) => reconcileStripeRefund(tx, STORE, {
      reId: 're_ooo_1', amount: 500, status: 'pending', piId: 'pi_SR-RC-2', attemptId,
    }));
    // And a flat duplicate of the settled event.
    await withStore(STORE, (tx) => reconcileStripeRefund(tx, STORE, {
      reId: 're_ooo_1', amount: 500, status: 'succeeded', piId: 'pi_SR-RC-2', attemptId,
    }));

    const rows = await refundRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'Settled', provider_ref: 're_ooo_1' }); // pending could not downgrade
    expect(await stockMovements()).toBe(1);
    expect(await refundEmails()).toBe(1);
    expect(await orderState(orderId)).toBe('PartiallyRefunded');
  });

  it('pre-metadata refund (no stamp): a unique unbound pending reservation matching by amount is bound', async () => {
    const { orderId, lineId } = await seedPaidOrder('SR-RC-3', 2000);
    const { attemptId } = await reservePendingRefund(orderId, 'k-3', 500, lineId);

    await withStore(STORE, (tx) => reconcileStripeRefund(tx, STORE, {
      reId: 're_legacy_1', amount: 500, status: 'succeeded', piId: 'pi_SR-RC-3',
    }));

    const rows = await refundRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempt_id: attemptId, state: 'Settled', provider_ref: 're_legacy_1' });
  });

  it('ambiguous correlation quarantines instead of guessing — operator-visible manual event', async () => {
    const { orderId, lineId } = await seedPaidOrder('SR-RC-4', 2000);
    // Two INDEPENDENT pending reservations of the same amount on one payment —
    // the un-stamped provider refund cannot be safely attributed.
    const a = await reservePendingRefund(orderId, 'k-4a', 500, lineId);
    await reservePendingRefund(orderId, 'k-4b', 500);
    expect(a.attemptId).toBeTruthy();

    await withStore(STORE, (tx) => reconcileStripeRefund(tx, STORE, {
      reId: 're_amb_1', amount: 500, status: 'succeeded', piId: 'pi_SR-RC-4',
    }));

    const rows = await refundRows(orderId);
    expect(rows).toHaveLength(2); // neither hijacked, no duplicate inserted
    expect(rows.every((r) => r.state === 'Pending' && r.provider_ref === null)).toBe(true);
    expect(await manualEvents()).toBe(1); // operator-visible quarantine
    expect(await orderState(orderId)).toBe('Paid'); // nothing settled
  });

  it('a stamped attempt id foreign to this payment does NOT hijack its unbound reservation', async () => {
    const { orderId, lineId } = await seedPaidOrder('SR-RC-5', 2000);
    await reservePendingRefund(orderId, 'k-5', 500, lineId);

    await withStore(STORE, (tx) => reconcileStripeRefund(tx, STORE, {
      reId: 're_foreign_1', amount: 500, status: 'succeeded', piId: 'pi_SR-RC-5',
      attemptId: '00000000-0000-4000-8000-0000000000ff',
    }));

    const rows = await refundRows(orderId);
    expect(rows).toHaveLength(2); // reservation stays pending + dashboard row recorded
    const pending = rows.find((r) => r.state === 'Pending');
    const settled = rows.find((r) => r.state === 'Settled');
    expect(pending?.provider_ref).toBeNull();
    expect(settled?.provider_ref).toBe('re_foreign_1');
  });

  it('operator recovery: verifyGatewayAttempt lists provider refunds and converges via the same finalizer', async () => {
    const { orderId, lineId } = await seedPaidOrder('SR-RC-6', 2000);
    const { attemptId } = await reservePendingRefund(orderId, 'k-6', 500, lineId);
    // The provider DID accept it — the response was just lost. Stripe's own
    // read path shows the refund carrying our attempt-id stamp.
    stripeRefunds = [{ id: 're_verify_1', amount: 500, status: 'succeeded',
      metadata: { [STRIPE_REFUND_ATTEMPT_KEY]: attemptId }, payment_intent: 'pi_SR-RC-6' }];

    const res = await verifyGatewayAttempt(STORE, attemptId);
    expect(res.status).toBe('settled');

    const rows = await refundRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'Settled', provider_ref: 're_verify_1' });
    expect(await stockMovements()).toBe(1);
    expect(await refundEmails()).toBe(1);
    // Idempotent: a second operator verify is a no-op.
    const again = await verifyGatewayAttempt(STORE, attemptId);
    expect(again.status).toBe('settled');
    expect(await stockMovements()).toBe(1);
  });

  it('no matching provider refund stays pending — operator sees an unresolved attempt, nothing settles', async () => {
    const { orderId, lineId } = await seedPaidOrder('SR-RC-7', 2000);
    const { attemptId } = await reservePendingRefund(orderId, 'k-7', 500, lineId);
    stripeRefunds = []; // provider shows NO refund — the original call truly failed

    const res = await verifyGatewayAttempt(STORE, attemptId);
    expect(res.status).toBe('unknown');
    const rows = await refundRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('Pending');
    expect(await orderState(orderId)).toBe('Paid');
    expect(await stockMovements()).toBe(0);
  });
});
