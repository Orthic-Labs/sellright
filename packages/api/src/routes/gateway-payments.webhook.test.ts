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
import { createHmac } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const STORE = 'ffffffff-6666-4666-8666-666666666666';
const ACCOUNT = 'sz_acct_test';
const PRIVATE_KEY = 'sz_priv_test_signing_key';
const PUBLIC_KEY = 'sz_pub_test';

vi.mock('../payments/gateway-account.js', async (orig) => {
  const actual = await orig<typeof import('../payments/gateway-account.js')>();
  return {
    ...actual,
    gatewayAccount: (storeId: string, method: string, accountId: string, mode?: string) => {
      if (storeId === STORE && method === 'sezzle' && accountId === ACCOUNT && (!mode || mode === 'test')) {
        return { accountId: ACCOUNT, storeId: STORE, method: 'sezzle' as const, mode: 'test' as const, publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY };
      }
      return actual.gatewayAccount(storeId, method as 'nmi' | 'sezzle', accountId, mode as 'test' | 'live' | undefined);
    },
  };
});

const { gatewayPayments } = await import('./gateway-payments.js');
const { pool, withStore } = await import('../db/client.js');
const { env } = await import('../env.js');
const { OpenAPIHono } = await import('@hono/zod-openapi');
const { sql } = await import('drizzle-orm');

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`sezzle webhook test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

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

async function seedStoreWithSezzleOrder(): Promise<{ orderId: string }> {
  const orderId = await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config)
      VALUES (${STORE}, 'sezzle-wh-test', 'Sezzle WH', 'USD', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    const r = await tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, grand_total)
      VALUES (gen_random_uuid(), ${STORE}, 'SR-SZ-1', 'Paid'::order_state, 'USD', 3000)
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`
      INSERT INTO payment (id, store_id, order_id, amount, method, state, provider_ref, gateway_account, gateway_mode, currency)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, 3000, 'sezzle', 'Settled', 'sz_order_1', ${ACCOUNT}, 'test', 'USD')`);
  });
  return { orderId };
}

const gatewayEvents = async () => {
  const r = await pool.query(`SELECT event_id, event_type, provider_ref, status, details FROM gateway_event WHERE store_id = $1`, [STORE]);
  return r.rows as Array<{ event_id: string; event_type: string; provider_ref: string; status: string; details: Record<string, unknown> }>;
};
const disputes = async () => {
  const r = await pool.query(`SELECT provider, provider_ref, order_id, amount, status, reason FROM dispute WHERE store_id = $1`, [STORE]);
  return r.rows as Array<{ provider: string; provider_ref: string; order_id: string | null; amount: number | null; status: string; reason: string | null }>;
};

beforeEach(async () => { await wipe(); });
afterAll(async () => { await wipe(); await pool.end(); });

describe('POST /v1/webhooks/sezzle — SR-06 dispute shape', () => {
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
