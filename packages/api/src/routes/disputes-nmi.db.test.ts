/**
 * NMI webhook identity integration: real HMAC verification, route, RLS-scoped
 * ledger reads, dispute/audit records & operator outbox. Configured profiles
 * use synthetic per-mode keys; no gateway request or real credentials.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createApp } from '../app.js';
import { pool, withStore } from '../db/client.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { env } from '../env.js';

vi.mock('../payments/gateway-account.js', async (orig) => ({
  ...await orig<typeof import('../payments/gateway-account.js')>(),
  resolveGatewayAccount: async (storeId: string, method: string, accountId: string, mode?: string) => {
    if (storeId !== STORE || method !== 'nmi') throw new Error('not configured');
    if (['db', ACCT, 'nmi-acct-2'].includes(accountId) && (mode === 'live' || mode === 'test')) {
      return { storeId, method: 'nmi', accountId, mode, securityKey: 'synthetic',
        privateKey: mode === 'live' ? SIGNING_KEY : TEST_SIGNING_KEY };
    }
    throw new Error('not configured');
  },
}));

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'disputes-nmi.db.test.ts');

// zod's uuid() validates the version nibble — test ids need a real v4 shape.
const STORE = '99999999-9999-4999-8999-999999999999';
const ACCT = 'nmi-acct-1';
const SIGNING_KEY = 'nmi-webhook-key';
const TEST_SIGNING_KEY = 'nmi-test-webhook-key';

const app = createApp();

const EVENT = {
  event_id: 'evt_cb_1',
  event_type: 'chargeback.batch.complete',
  event_body: { chargebacks: [{ id: 'txn-cb-77', amount: '42.00', reason: 'fraudulent' }] },
};

function signedRequest(body: string, key = SIGNING_KEY, accountId = ACCT) {
  const t = '1700000000';
  const s = createHmac('sha256', key).update(`${t}.${body}`).digest('hex');
  return new Request(`http://test/v1/webhooks/nmi/${STORE}/${accountId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'webhook-signature': `t=${t},s=${s}` },
    body,
  });
}

async function wipe() { await pool.query('TRUNCATE store CASCADE'); }

async function seed(accountId: string | null = ACCT, mode: string | null = 'live') {
  await pool.query(`INSERT INTO store (id, slug, name, currency, config) VALUES ($1, 'nmi-test', 'NMI Test', 'USD', '{}'::jsonb)`, [STORE]);
  const r = await pool.query(`INSERT INTO admin_user (email) VALUES ('ops@x.test') ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
  await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'owner'::admin_role) ON CONFLICT DO NOTHING`, [r.rows[0].id, STORE]);
  return seedPayment('NMI-1', accountId, mode);
}

async function seedPayment(code: string, accountId: string | null, mode: string | null) {
  return withStore(STORE, async (tx) => {
    const o = await tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, grand_total)
      VALUES (gen_random_uuid(), ${STORE}, ${code}, 'Paid'::order_state, 'USD', 4200) RETURNING id`);
    const orderId = (o.rows[0] as { id: string }).id;
    const p = await tx.execute(sql`
      INSERT INTO payment (id, store_id, order_id, amount, method, state, provider_ref, gateway_account, gateway_mode, metadata)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, 4200, 'nmi', 'Settled', 'txn-cb-77', ${accountId}, ${mode},
        ${JSON.stringify(mode === null ? { vendure: { vendureMethod: 'nmi-payment', modeQuarantined: 'conflict' } } : {})}::jsonb) RETURNING id`);
    return { orderId, paymentId: (p.rows[0] as { id: string }).id };
  });
}

const disputeCount = () => withStore(STORE, async (tx) => {
  const r = await tx.execute(sql`SELECT count(*)::int AS n, bool_or(order_id IS NOT NULL) AS linked FROM dispute`);
  return r.rows[0] as { n: number; linked: boolean };
});
const emailCount = () => withStore(STORE, async (tx) => {
  const r = await tx.execute(sql`SELECT count(*)::int AS n FROM email_outbox WHERE kind = 'dispute_alert'`);
  return (r.rows[0] as { n: number }).n;
});

const associations = () => withStore(STORE, async tx => {
  const r = await tx.execute(sql`SELECT payment_id, order_id, status FROM dispute ORDER BY provider_ref`);
  return r.rows;
});

const assertNoMoneyEffects = async (paymentCount = 1) => withStore(STORE, async tx => {
  const r = await tx.execute(sql`SELECT
    (SELECT count(*) FROM payment WHERE store_id = ${STORE})::int AS payments,
    (SELECT count(*) FROM refund WHERE store_id = ${STORE})::int AS refunds,
    (SELECT count(*) FROM payment_attempt WHERE store_id = ${STORE})::int AS attempts,
    (SELECT bool_and(state = 'Paid') FROM "order" WHERE store_id = ${STORE}) AS orders_paid,
    (SELECT bool_and(state = 'Settled') FROM payment WHERE store_id = ${STORE}) AS payments_settled`);
  expect(r.rows[0]).toMatchObject({ payments: paymentCount, refunds: 0, attempts: 0, orders_paid: true, payments_settled: true });
});

describe('POST /v1/webhooks/nmi/:store/:account', () => {
  beforeEach(wipe);
  afterAll(wipe);

  it('a signed chargeback.batch.complete records the dispute, links the order, and enqueues ONE operator alert', async () => {
    await seed();
    const body = JSON.stringify(EVENT);
    const res = await app.request(signedRequest(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, recorded: 1 });

    const d = await disputeCount();
    expect(d.n).toBe(1);
    expect(d.linked).toBe(true); // resolved payment → order
    expect(await emailCount()).toBe(1);

    // Provider redelivery: event-level dedupe acks without re-recording.
    const replay = await app.request(signedRequest(body));
    expect(replay.status).toBe(200);
    expect(await disputeCount()).toEqual({ n: 1, linked: true });
    expect(await emailCount()).toBe(1);
    await assertNoMoneyEffects();
  });

  it.each(['live', 'test'] as const)('links exact DB-account %s identity selected by its signing key', async mode => {
    const ids = await seed('db', mode);
    const key = mode === 'live' ? SIGNING_KEY : TEST_SIGNING_KEY;
    expect((await app.request(signedRequest(JSON.stringify(EVENT), key, 'db'))).status).toBe(200);
    expect(await associations()).toEqual([{ payment_id: ids.paymentId, order_id: ids.orderId, status: 'open' }]);
    expect(await emailCount()).toBe(1);
    await assertNoMoneyEffects();
  });

  it.each([
    ['NULL mode / live callback', 'db', null, 'live'],
    ['NULL mode / test callback', 'db', null, 'test'],
    ['NULL account / live callback', null, 'live', 'live'],
    ['NULL account / test callback', null, 'test', 'test'],
    ['both NULL / live callback', null, null, 'live'],
    ['both NULL / test callback', null, null, 'test'],
    ['wrong account', 'another-account', 'live', 'live'],
    ['wrong mode', 'db', 'test', 'live'],
  ] as const)('preserves an unlinked dispute & deduped alert for %s', async (_label, accountId, mode, callbackMode) => {
    const ids = await seed(accountId, mode);
    const key = callbackMode === 'live' ? SIGNING_KEY : TEST_SIGNING_KEY;
    const body = JSON.stringify(EVENT);
    expect((await app.request(signedRequest(body, key, 'db'))).status).toBe(200);
    // Replayed event & new envelope for the same transaction both dedupe.
    expect((await app.request(signedRequest(body, key, 'db'))).status).toBe(200);
    const retryBody = JSON.stringify({ ...EVENT, event_id: 'evt_cb_redelivery' });
    expect((await app.request(signedRequest(retryBody, key, 'db'))).status).toBe(200);
    expect(await associations()).toEqual([{ payment_id: null, order_id: null, status: 'open' }]);
    expect(await emailCount()).toBe(1);
    const evidence = await withStore(STORE, async tx => {
      const audits = await tx.execute(sql`SELECT entity_id, data FROM audit_log WHERE store_id = ${STORE} AND action = 'dispute_opened'`);
      const emails = await tx.execute(sql`SELECT recipient, payload FROM email_outbox WHERE store_id = ${STORE} AND kind = 'dispute_alert'`);
      return { audits: audits.rows, emails: emails.rows };
    });
    expect(evidence.audits).toEqual([expect.objectContaining({ entity_id: 'txn-cb-77', data: expect.objectContaining({ orderCode: null }) })]);
    expect(evidence.emails).toEqual([expect.objectContaining({ recipient: 'ops@x.test' })]);
    expect(JSON.stringify(evidence)).not.toContain(ids.orderId);
    expect(JSON.stringify(evidence)).not.toContain(ids.paymentId);
    expect(JSON.stringify(evidence)).not.toContain('NMI-1');
    await assertNoMoneyEffects();
  });

  it('selects only exact identity when the same provider ref exists across accounts & modes', async () => {
    await seed(null, null);
    await seedPayment('NMI-OTHER-ACCOUNT', 'another-account', 'live');
    await seedPayment('NMI-OTHER-MODE', 'db', 'test');
    const exact = await seedPayment('NMI-EXACT', 'db', 'live');
    expect((await app.request(signedRequest(JSON.stringify(EVENT), SIGNING_KEY, 'db'))).status).toBe(200);
    expect(await associations()).toEqual([{ payment_id: exact.paymentId, order_id: exact.orderId, status: 'open' }]);
    expect(await emailCount()).toBe(1);
    await assertNoMoneyEffects(4);
  });

  it('isolates the same event & transaction across two named accounts & both modes', async () => {
    await seed();
    await withStore(STORE, tx => tx.execute(sql`INSERT INTO webhook_endpoint (store_id, url, secret, topics)
      VALUES (${STORE}, 'https://example.test/disputes', 'synthetic', ARRAY['order.dispute_opened'])`));
    for (const account of [ACCT, 'nmi-acct-2']) {
      for (const mode of ['live', 'test']) {
        const key = mode === 'live' ? SIGNING_KEY : TEST_SIGNING_KEY;
        const body = JSON.stringify(EVENT);
        expect((await app.request(signedRequest(body, key, account))).status).toBe(200);
        expect((await app.request(signedRequest(body, key, account))).status).toBe(200);
        expect((await app.request(signedRequest(JSON.stringify({ ...EVENT, event_id: 'new-envelope' }), key, account))).status).toBe(200);
        expect((await app.request(signedRequest(JSON.stringify({ ...EVENT, event_id: undefined }), key, account))).status).toBe(200);
        expect((await app.request(signedRequest(JSON.stringify({ ...EVENT, event_id: undefined }), key, account))).status).toBe(200);
      }
    }
    expect((await disputeCount()).n).toBe(4);
    expect(await emailCount()).toBe(4);
    const evidence = await withStore(STORE, async tx => {
      const rows = await tx.execute(sql`SELECT id, gateway_account, gateway_mode FROM dispute`);
      const audits = await tx.execute(sql`SELECT data FROM audit_log WHERE action = 'dispute_opened'`);
      const deliveries = await tx.execute(sql`SELECT payload FROM webhook_delivery WHERE topic = 'order.dispute_opened'`);
      const emails = await tx.execute(sql`SELECT dedupe_key FROM email_outbox WHERE kind = 'dispute_alert'`);
      return { rows: rows.rows, audits: audits.rows, deliveries: deliveries.rows, emails: emails.rows };
    });
    expect(evidence.audits).toHaveLength(4);
    expect(evidence.deliveries).toHaveLength(4);
    for (const row of evidence.rows) {
      const scope = { gatewayAccount: row.gateway_account, gatewayMode: row.gateway_mode, disputeRecordId: row.id };
      expect(evidence.audits).toContainEqual({ data: expect.objectContaining(scope) });
      expect(evidence.deliveries).toContainEqual({ payload: expect.objectContaining(scope) });
      expect(evidence.emails).toContainEqual({ dedupe_key: `dispute_alert:nmi:v2:${row.id}:ops@x.test` });
    }
    await assertNoMoneyEffects();
  });

  it('ignores legacy event claims & keeps unresolved legacy disputes separate', async () => {
    await seed();
    await withStore(STORE, async tx => {
      await tx.execute(sql`INSERT INTO processed_event (id, store_id, type) VALUES (${`nmi:${STORE}:${EVENT.event_id}`}, ${STORE}, ${EVENT.event_type})`);
      // Old callers omit new columns & keep untargeted ON CONFLICT syntax.
      await tx.execute(sql`INSERT INTO dispute (store_id, provider, provider_ref) VALUES (${STORE}, 'nmi', 'txn-cb-77') ON CONFLICT DO NOTHING`);
      await tx.execute(sql`INSERT INTO dispute (store_id, provider, provider_ref) VALUES (${STORE}, 'nmi', 'txn-cb-77') ON CONFLICT DO NOTHING`);
    });
    expect((await app.request(signedRequest(JSON.stringify(EVENT)))).status).toBe(200);
    expect((await app.request(signedRequest(JSON.stringify(EVENT)))).status).toBe(200);
    expect((await disputeCount()).n).toBe(2);
    expect(await emailCount()).toBe(1);
  });

  it('rejects a bad signature before touching the DB', async () => {
    await seed();
    const res = await app.request(signedRequest(JSON.stringify(EVENT), 'wrong-key'));
    expect(res.status).toBe(401);
    expect(await disputeCount()).toEqual({ n: 0, linked: null });
    expect(await emailCount()).toBe(0);
  });
});
