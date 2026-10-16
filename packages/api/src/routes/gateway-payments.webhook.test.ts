/**
 * DB tests — SR-06: POST /v1/webhooks/sezzle/:storeId/:accountId must accept
 * the documented dispute payload shape (data.order_uuid — no data.uuid) and
 * durably record every correctly-signed event for the reconcile worker.
 *
 *   - signed dispute event  → 200 + gateway_event row normalized to the ORDER
 *     uuid + dispute identity preserved + canonical dispute row for operator
 *     visibility (never an automatic refund/cancel)
 *   - signed order event (data.uuid) → 200, unchanged behavior
 *   - bad signature → 401, nothing recorded; non-envelope → 400
 *   - exact redelivery → still one durable row (event-identity dedupe)
 *
 * Sezzle signing is REAL HMAC-SHA256 over the raw body (the same primitive
 * production uses). gatewayAccount is mocked so the suite doesn't depend on
 * process-env timing. Runs against a *_test database only (these wipe data).
 */
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { migrationId } from '../import/context.js';

const STORE = 'ffffffff-6666-4666-8666-666666666666';
const ACCOUNT = 'sz_acct_test';
const PRIVATE_KEY = 'sz_priv_test_signing_key';
const PUBLIC_KEY = 'sz_pub_test';

vi.mock('../payments/gateway-account.js', async (orig) => {
  const actual = await orig<typeof import('../payments/gateway-account.js')>();
  const lookup = (storeId: string, method: string, accountId: string, mode?: string) => {
    if (storeId === STORE && method === 'sezzle' && accountId === ACCOUNT && (!mode || mode === 'test')) {
      return { accountId: ACCOUNT, storeId: STORE, method: 'sezzle' as const, mode: 'test' as const, publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY };
    }
    return actual.gatewayAccount(storeId, method as 'nmi' | 'sezzle', accountId, mode as 'test' | 'live' | undefined);
  };
  return {
    ...actual,
    gatewayAccount: lookup,
    // WS-A: the route now calls the async resolver — mirror the same fixture lookup.
    resolveGatewayAccount: async (storeId: string, method: string, accountId: string, mode?: string) => lookup(storeId, method, accountId, mode),
  };
});

const { gatewayPayments } = await import('./gateway-payments.js');
const { pool, withStore } = await import('../db/client.js');
const { env } = await import('../env.js');
const { OpenAPIHono } = await import('@hono/zod-openapi');
const { sql } = await import('drizzle-orm');

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
assertTestDatabase(DB, 'sezzle webhook test');

const app = new OpenAPIHono();
app.route('/', gatewayPayments);

const PATH = `/v1/webhooks/sezzle/${STORE}/${ACCOUNT}`;

function sign(raw: string, key = PRIVATE_KEY): string {
  return createHmac('sha256', key).update(raw).digest('hex');
}

async function post(payload: unknown, key = PRIVATE_KEY): Promise<{ status: number; body: unknown }> {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const res = await app.request(PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sezzle-signature': sign(raw, key) },
    body: raw,
  });
  return { status: res.status, body: await res.json() };
}

async function wipe() { await pool.query('TRUNCATE store CASCADE'); }

async function seedStoreWithSezzleOrder(imported = false, storeId = STORE): Promise<{ orderId: string }> {
  const orderId = await withStore(storeId, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config)
      VALUES (${storeId}, ${'sezzle-wh-test-' + storeId}, 'Sezzle WH', 'USD', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    const r = await tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, grand_total, metadata)
      VALUES (${imported ? migrationId(storeId, 'vendure:damned', 'order', 12) : randomUUID()},
        ${storeId}, 'SR-SZ-1', 'Paid'::order_state, 'USD', 3000,
        ${JSON.stringify(imported ? { vendure: { id: 12, sourceKey: 'vendure:damned', state: 'PaymentSettled' } } : {})}::jsonb)
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(storeId, async (tx) => {
    await tx.execute(sql`
      INSERT INTO payment (id, store_id, order_id, amount, method, state, provider_ref, gateway_account, gateway_mode, currency, metadata)
      VALUES (${imported ? migrationId(storeId, 'vendure:damned', 'payment', 42) : randomUUID()},
        ${storeId}, ${orderId}, 3000, 'sezzle', 'Settled', 'sz_order_1', ${ACCOUNT}, 'test', 'USD',
        ${JSON.stringify(imported ? { vendure: { vendureMethod: 'sezzle-payment', sourceMode: 'test', sourcePaymentId: 42, sourceKey: 'vendure:damned' } } : {})}::jsonb)`);
  });
  return { orderId };
}

// gateway_event and dispute carry FORCE ROW LEVEL SECURITY and the
// migration-owner pool role is NOT BYPASSRLS — a bare pool.query() with no
// app.current_store set sees zero rows regardless of what actually committed.
const gatewayEvents = async () => withStore(STORE, async (tx) => {
  const r = await tx.execute(sql`SELECT event_id, event_type, provider_ref, status, details FROM gateway_event WHERE store_id = ${STORE}`);
  return r.rows as Array<{ event_id: string; event_type: string; provider_ref: string; status: string; details: Record<string, unknown> }>;
});
const disputes = async () => withStore(STORE, async (tx) => {
  const r = await tx.execute(sql`SELECT provider, provider_ref, order_id, amount, status, reason FROM dispute WHERE store_id = ${STORE}`);
  return r.rows as Array<{ provider: string; provider_ref: string; order_id: string | null; amount: number | null; status: string; reason: string | null }>;
});

beforeEach(async () => { await wipe(); });
afterAll(async () => { await wipe(); await pool.end(); });

describe('POST /v1/webhooks/sezzle — SR-06 dispute shape', () => {
  it('does not link a matching account/reference from another store', async () => {
    const otherStore = 'ffffffff-7777-4777-8777-777777777777';
    await seedStoreWithSezzleOrder();
    await withStore(STORE, tx => tx.execute(sql`DELETE FROM payment WHERE store_id = ${STORE}`));
    await seedStoreWithSezzleOrder(false, otherStore);
    expect((await post({ uuid: 'evt_wrong_store', event: 'dispute.merchant_input_requested', data_type: 'dispute',
      data: { dispute_id: 9875, order_uuid: 'sz_order_1', dispute_status: 'merchant_input_requested' },
    })).status).toBe(200);
    expect(await gatewayEvents()).toEqual([expect.objectContaining({ status: 'pending' })]);
    expect(await disputes()).toEqual([expect.objectContaining({ order_id: null })]);
  });

  it.each([
    ['another account', 'different-account', 'test'], ['another mode', ACCOUNT, 'live'],
    ['unknown account', null, 'test'], ['unknown mode', ACCOUNT, null], ['unknown identity', null, null],
  ])('keeps dispute unlinked & pending when payment belongs to %s', async (_name, accountId, mode) => {
    await seedStoreWithSezzleOrder();
    await withStore(STORE, tx => tx.execute(sql`UPDATE payment SET gateway_account = ${accountId}, gateway_mode = ${mode} WHERE store_id = ${STORE}`));
    expect((await post({ uuid: 'evt_wrong_identity', event: 'dispute.merchant_input_requested', data_type: 'dispute',
      data: { dispute_id: 9873, order_uuid: 'sz_order_1', dispute_status: 'merchant_input_requested' },
    })).status).toBe(200);
    expect(await gatewayEvents()).toEqual([expect.objectContaining({ status: 'pending' })]);
    expect(await disputes()).toEqual([expect.objectContaining({ order_id: null })]);
    const effects = await withStore(STORE, tx => tx.execute(sql`SELECT
      (SELECT count(*) FROM payment WHERE store_id = ${STORE})::int AS payments,
      (SELECT count(*) FROM refund WHERE store_id = ${STORE})::int AS refunds,
      (SELECT count(*) FROM payment_attempt WHERE store_id = ${STORE})::int AS attempts,
      (SELECT state FROM "order" WHERE store_id = ${STORE} LIMIT 1) AS state`));
    expect(effects.rows[0]).toMatchObject({ payments: 1, refunds: 0, attempts: 0, state: 'Paid' });
  });

  it('links exact imported identity without inventing attempts or payment/refund effects', async () => {
    const { orderId } = await seedStoreWithSezzleOrder(true);
    const payload = { uuid: 'evt_imported_identity', event: 'dispute.merchant_input_requested', data_type: 'dispute',
      data: { dispute_id: 9874, order_uuid: 'sz_order_1', dispute_status: 'merchant_input_requested' },
    };
    expect((await post(payload)).status).toBe(200);
    expect((await post(payload)).status).toBe(200);
    expect(await disputes()).toEqual([expect.objectContaining({ order_id: orderId })]);
    const effects = await withStore(STORE, tx => tx.execute(sql`SELECT
      (SELECT count(*) FROM payment WHERE store_id = ${STORE})::int AS payments,
      (SELECT count(*) FROM refund WHERE store_id = ${STORE})::int AS refunds,
      (SELECT count(*) FROM payment_attempt WHERE store_id = ${STORE})::int AS attempts,
      (SELECT state FROM "order" WHERE id = ${orderId}) AS state`));
    expect(effects.rows[0]).toMatchObject({ payments: 1, refunds: 0, attempts: 0, state: 'Paid' });
  });

  it('accepts a signed dispute event keyed on data.order_uuid (no data.uuid)', async () => {
    const { orderId } = await seedStoreWithSezzleOrder();
    const res = await post({
      uuid: 'evt_dispute_1',
      event: 'dispute.merchant_input_requested',
      data_type: 'dispute',
      data: {
        dispute_id: 9871,
        order_uuid: 'sz_order_1',
        order_reference_id: 'attempt-ref-1',
        dispute_type: 'fraud',
        dispute_status: 'merchant_input_requested',
        dispute_amount_in_cents: 3000,
        dispute_currency: 'USD',
        dispute_due_date: '2026-02-01',
      },
    });
    expect(res.status).toBe(200);

    const events = await gatewayEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_id: 'evt_dispute_1',
      event_type: 'dispute.merchant_input_requested',
      // Order identity normalized to data.order_uuid — NOT the missing data.uuid.
      provider_ref: 'sz_order_1',
      status: 'pending',
    });
    const dispute = (events[0]!.details.dispute ?? {}) as Record<string, unknown>;
    expect(dispute).toMatchObject({ disputeId: '9871', orderUuid: 'sz_order_1', disputeType: 'fraud' });

    // Canonical dispute record for operator visibility — linked to the order,
    // no auto-refund/cancel anywhere.
    const ds = await disputes();
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ provider: 'sezzle', order_id: orderId, amount: 3000, reason: 'fraud' });
  });

  it('a dispute redelivery stays deduped — one gateway_event + one dispute row', async () => {
    await seedStoreWithSezzleOrder();
    const payload = {
      uuid: 'evt_dispute_2', event: 'dispute.merchant_input_requested', data_type: 'dispute',
      data: { dispute_id: 9872, order_uuid: 'sz_order_1', dispute_status: 'merchant_input_requested' },
    };
    expect((await post(payload)).status).toBe(200);
    expect((await post(payload)).status).toBe(200);
    expect(await gatewayEvents()).toHaveLength(1);
    expect(await disputes()).toHaveLength(1);
  });

  it('an order event still keys on data.uuid', async () => {
    await seedStoreWithSezzleOrder();
    const res = await post({ uuid: 'evt_order_1', event: 'order.captured', data: { uuid: 'sz_order_1' } });
    expect(res.status).toBe(200);
    const events = await gatewayEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_id: 'evt_order_1', event_type: 'order.captured', provider_ref: 'sz_order_1' });
  });

  it('a signed malformed event is still durably recorded (operator-visible), not dropped', async () => {
    await seedStoreWithSezzleOrder();
    // No data block at all → normalization flags it malformed but still
    // records it durably for the reconcile worker to park.
    const res = await post({ uuid: 'evt_malformed_1', event: 'order.captured' });
    expect(res.status).toBe(200);
    const events = await gatewayEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.details.malformed).toBe(true);
  });

  it('rejects a bad signature with 401 and records nothing', async () => {
    await seedStoreWithSezzleOrder();
    const res = await post({ uuid: 'evt_bad', event: 'order.captured', data: { uuid: 'sz_order_1' } }, 'wrong_key');
    expect(res.status).toBe(401);
    expect(await gatewayEvents()).toHaveLength(0);
  });

  it('rejects a non-envelope payload with 400', async () => {
    await seedStoreWithSezzleOrder();
    const res = await post({ totally: 'not a sezzle event' });
    expect(res.status).toBe(400);
  });
});
