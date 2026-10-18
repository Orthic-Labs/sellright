/**
 * PAR-07 tests — NMI signature verification is pure; recordDispute is the
 * DB-gated half (skipIf pattern mirrors payments/webhook-reconcile.test.ts).
 */
import { isDisposablePostgresUrl } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { verifyNmiSignature, nmiAmountToCents } from '../routes/disputes.js';
import { recordDispute, recordStripeDisputeAlert, operatorRecipients } from './disputes.js';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';

const KEY = 'test-signing-key';

function sign(body: string, key = KEY, t = '1700000000') {
  const s = createHmac('sha256', key).update(`${t}.${body}`).digest('hex');
  return `t=${t},s=${s}`;
}

describe('verifyNmiSignature', () => {
  const body = '{"event_type":"chargeback.batch.complete"}';
  it('accepts a valid t=,s= signature; rejects everything else', () => {
    expect(verifyNmiSignature(body, sign(body), KEY)).toBe(true);
    expect(verifyNmiSignature(body, sign(body, 'wrong-key'), KEY)).toBe(false);
    expect(verifyNmiSignature(body, sign('{"event_type":"other"}'), KEY)).toBe(false); // body tampered
    expect(verifyNmiSignature(body, undefined, KEY)).toBe(false);
    expect(verifyNmiSignature(body, 'garbage', KEY)).toBe(false);
    expect(verifyNmiSignature(body, 't=1,s=zzzz', KEY)).toBe(false);
    expect(verifyNmiSignature(body, sign(body), '')).toBe(false); // no key configured → fail closed
  });
});

describe('nmiAmountToCents', () => {
  it('parses dollar strings/numbers to cents; rejects garbage', () => {
    expect(nmiAmountToCents('12.34')).toBe(1234);
    expect(nmiAmountToCents('0.10')).toBe(10);
    expect(nmiAmountToCents(25)).toBe(2500);
    expect(nmiAmountToCents('abc')).toBeNull();
    expect(nmiAmountToCents(undefined)).toBeNull();
  });
});

describe('recordDispute identity admission', () => {
  it.each([
    {}, { gatewayAccount: 'account' }, { gatewayMode: 'live' },
    { gatewayAccount: '', gatewayMode: 'live' }, { gatewayAccount: '   ', gatewayMode: 'live' },
    { gatewayAccount: 'account', gatewayMode: 'sandbox' },
  ])('rejects incomplete NMI identity before touching a transaction: %j', async identity => {
    await expect(recordDispute({} as Parameters<typeof recordDispute>[0], STORE,
      { provider: 'nmi', providerRef: 'ref', ...identity } as never)).rejects.toThrow('authenticated gateway account and mode');
  });
});

// ── DB-gated: recordDispute persistence + operator email dedupe ──────────────
const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
const isTestDb = isDisposablePostgresUrl(DB);
const STORE = '55555555-5555-5555-5555-555555555555';

async function wipe() { await pool.query('TRUNCATE store CASCADE'); }

async function seedStore(config: object = {}): Promise<void> {
  await pool.query(
    `INSERT INTO store (id, slug, name, currency, config) VALUES ($1, 'disputes-test', 'Disputes Test', 'USD', $2::jsonb)`,
    [STORE, JSON.stringify(config)],
  );
}

async function seedAdmin(email: string, role: 'owner' | 'manager' | 'staff' = 'owner'): Promise<void> {
  // admin_user is a global registry table — TRUNCATE store CASCADE doesn't
  // reach it, and other suites may have seeded the same mailbox.
  const r = await pool.query(
    `INSERT INTO admin_user (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
    [email],
  );
  await pool.query(`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES ($1, $2, $3::admin_role)`, [r.rows[0].id, STORE, role]);
}

async function seedOrderPayment(): Promise<{ orderId: string }> {
  const orderId = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, grand_total)
      VALUES (gen_random_uuid(), ${STORE}, 'DSP-1', 'Paid'::order_state, 'USD', 4200) RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`
      INSERT INTO payment (id, store_id, order_id, amount, method, state, provider_ref)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, 4200, 'stripe', 'Settled', 'pi_dsp_1')`);
  });
  return { orderId };
}

const outboxRows = () => withStore(STORE, async (tx) => {
  const r = await tx.execute(sql`SELECT kind, recipient, payload, dedupe_key FROM email_outbox ORDER BY recipient`);
  return r.rows as Array<{ kind: string; recipient: string; payload: { subject: string }; dedupe_key: string }>;
});
const disputeRows = () => withStore(STORE, async (tx) => {
  const r = await tx.execute(sql`SELECT * FROM dispute ORDER BY provider_ref`);
  return r.rows as Array<Record<string, unknown>>;
});

describe.skipIf(!isTestDb)('recordDispute — DB integration', () => {
  beforeEach(wipe);
  afterAll(wipe);

  it('records a dispute, enqueues ONE operator email per owner/manager, and dedupes provider retries', async () => {
    await seedStore();
    await seedAdmin('owner@x.test', 'owner');
    await seedAdmin('manager@x.test', 'manager');
    await seedAdmin('staff@x.test', 'staff'); // staff do NOT get dispute alerts
    const { orderId } = await seedOrderPayment();

    const res = await withStore(STORE, (tx) => recordDispute(tx, STORE, {
      provider: 'nmi', providerRef: 'txn-cb-1', gatewayAccount: 'account', gatewayMode: 'live', orderId, orderCode: 'DSP-1',
      amountCents: 4200, currency: 'USD', reason: 'fraudulent', status: 'open',
    }));
    expect(res.created).toBe(true);
    expect(res.notified).toBe(2);

    const rows = await disputeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe('nmi');
    expect(rows[0]!.order_id).toBe(orderId);
    expect(rows[0]!.notified_at).not.toBeNull();

    const emails = await outboxRows();
    expect(emails).toHaveLength(2);
    expect(emails.map((e) => e.recipient).sort()).toEqual(['manager@x.test', 'owner@x.test']);
    expect(emails[0]!.kind).toBe('dispute_alert');
    expect(emails[0]!.payload.subject).toContain('DSP-1');
    expect(emails[0]!.payload.subject).toContain('Disputes Test');

    // Provider retry — same (provider, providerRef): no row, no email.
    const retry = await withStore(STORE, (tx) => recordDispute(tx, STORE, {
      provider: 'nmi', providerRef: 'txn-cb-1', gatewayAccount: 'account', gatewayMode: 'live', orderId, orderCode: 'DSP-1', amountCents: 4200, reason: 'fraudulent',
    }));
    expect(retry.created).toBe(false);
    expect(retry.notified).toBe(0);
    expect(await disputeRows()).toHaveLength(1);
    expect(await outboxRows()).toHaveLength(2);
  });

  it('config notifications.disputeEmail overrides the owner/manager default', async () => {
    await seedStore({ notifications: { disputeEmail: 'chargebacks@x.test' } });
    await seedAdmin('owner@x.test');
    const recips = await withStore(STORE, (tx) => operatorRecipients(tx, STORE));
    expect(recips).toEqual(['chargebacks@x.test']);
  });

  it('recordStripeDisputeAlert resolves the payment/order via the PI id and notifies', async () => {
    await seedStore();
    await seedAdmin('ops@x.test');
    const { orderId } = await seedOrderPayment();

    const res = await withStore(STORE, (tx) => recordStripeDisputeAlert(tx, STORE, {
      disputeId: 'dp_abc', amount: 4200, reason: 'product_not_received', status: 'warning_needs_response', piId: 'pi_dsp_1',
    }));
    expect(res.created).toBe(true);
    const rows = await disputeRows();
    expect(rows[0]!.provider).toBe('stripe');
    expect(rows[0]!.provider_ref).toBe('dp_abc');
    expect(rows[0]!.order_id).toBe(orderId);
    const emails = await outboxRows();
    expect(emails).toHaveLength(1);
    expect(emails[0]!.payload.subject).toContain('DSP-1'); // order code in the subject
    expect(JSON.stringify(emails[0]!.payload)).toContain('dp_abc'); // dispute ref in the body
  });

  it('a dispute with no operator recipients still persists (email skipped, never blocks)', async () => {
    await seedStore();
    const res = await withStore(STORE, (tx) => recordDispute(tx, STORE, {
      provider: 'nmi', providerRef: 'txn-cb-2', gatewayAccount: 'account', gatewayMode: 'live', amountCents: 100, reason: 'general',
    }));
    expect(res.created).toBe(true);
    expect(res.notified).toBe(0);
    expect(await disputeRows()).toHaveLength(1);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('rolls back event claim, dispute, audit, webhook & alert together', async () => {
    await seedStore({ notifications: { disputeEmail: 'ops@x.test' } });
    await withStore(STORE, tx => tx.execute(sql`INSERT INTO webhook_endpoint (store_id, url, secret, topics)
      VALUES (${STORE}, 'https://example.test/disputes', 'synthetic', ARRAY['order.dispute_opened'])`));
    await expect(withStore(STORE, async tx => {
      await tx.execute(sql`INSERT INTO processed_event (id, store_id, type) VALUES ('nmi:v2:rollback', ${STORE}, 'chargeback.batch.complete')`);
      await recordDispute(tx, STORE, { provider: 'nmi', providerRef: 'txn-rollback', gatewayAccount: 'account', gatewayMode: 'live' });
      throw new Error('synthetic transaction failure');
    })).rejects.toThrow('synthetic transaction failure');
    const counts = await withStore(STORE, tx => tx.execute(sql`SELECT
      (SELECT count(*)::int FROM processed_event WHERE id = 'nmi:v2:rollback') AS claims,
      (SELECT count(*)::int FROM dispute) AS disputes,
      (SELECT count(*)::int FROM audit_log WHERE action = 'dispute_opened') AS audits,
      (SELECT count(*)::int FROM webhook_delivery) AS deliveries,
      (SELECT count(*)::int FROM email_outbox) AS emails`));
    expect(counts.rows).toEqual([{ claims: 0, disputes: 0, audits: 0, deliveries: 0, emails: 0 }]);
  });
});
