/**
 * PAR-07 NMI webhook end-to-end (DB-required). Requires GATEWAY_ACCOUNTS_JSON
 * naming an nmi account for the test store — the vitest invocation sets it:
 *   GATEWAY_ACCOUNTS_JSON='[{"accountId":"acct1","storeId":"<STORE>","method":"nmi","mode":"live","securityKey":"k","privateKey":"whk"}]'
 * The file self-skips when no nmi account is configured so a bare test:db run
 * doesn't fail on missing env.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createApp } from '../app.js';
import { pool, withStore } from '../db/client.js';
import { assertTestDatabase } from '../db/rls-test-utils.js';
import { env } from '../env.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'disputes-nmi.db.test.ts');

// zod's uuid() validates the version nibble — test ids need a real v4 shape.
const STORE = '99999999-9999-4999-8999-999999999999';
const ACCT = 'nmi-acct-1';
const SIGNING_KEY = 'nmi-webhook-key';
const configured = (() => {
  try { return JSON.parse(env.GATEWAY_ACCOUNTS_JSON).some((a: { method?: string }) => a.method === 'nmi'); }
  catch { return false; }
})();

const app = createApp();

const EVENT = {
  event_id: 'evt_cb_1',
  event_type: 'chargeback.batch.complete',
  event_body: { chargebacks: [{ id: 'txn-cb-77', amount: '42.00', reason: 'fraudulent' }] },
};

function signedRequest(body: string, key = SIGNING_KEY) {
  const t = '1700000000';
  const s = createHmac('sha256', key).update(`${t}.${body}`).digest('hex');
  return new Request(`http://test/v1/webhooks/nmi/${STORE}/${ACCT}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'webhook-signature': `t=${t},s=${s}` },
    body,
  });
}

async function wipe() { await pool.query('TRUNCATE store CASCADE'); }

async function seed(): Promise<void> {
  await pool.query(`INSERT INTO store (id, slug, name, currency, config) VALUES ($1, 'nmi-test', 'NMI Test', 'USD', '{}'::jsonb)`, [STORE]);
  const r = await pool.query(`INSERT INTO admin_user (email) VALUES ('ops@x.test') ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
  await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, 'owner'::admin_role) ON CONFLICT DO NOTHING`, [r.rows[0].id, STORE]);
  await withStore(STORE, async (tx) => {
    const o = await tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, grand_total)
      VALUES (gen_random_uuid(), ${STORE}, 'NMI-1', 'Paid'::order_state, 'USD', 4200) RETURNING id`);
    await tx.execute(sql`
      INSERT INTO payment (id, store_id, order_id, amount, method, state, provider_ref)
      VALUES (gen_random_uuid(), ${STORE}, ${(o.rows[0] as { id: string }).id}, 4200, 'nmi', 'Settled', 'txn-cb-77')`);
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

describe.skipIf(!configured)('POST /v1/webhooks/nmi/:store/:account', () => {
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
  });

  it('rejects a bad signature before touching the DB', async () => {
    await seed();
    const res = await app.request(signedRequest(JSON.stringify(EVENT), 'wrong-key'));
    expect(res.status).toBe(401);
    expect(await disputeCount()).toEqual({ n: 0, linked: null });
    expect(await emailCount()).toBe(0);
  });
});
