/**
 * De-fork plan 2.9 — claim/failure instrumentation on the three outboxes.
 *
 *   claimed_at      set by the worker at claim time, NULL on release
 *   first_failed_at set once at the first failure, never overwritten
 *   webhook_delivery.updated_at   set at claim; also bumped by a DB trigger so
 *                                  an OLD worker (unaware of the column) is
 *                                  still reflected
 *
 * Runs against a *_test database only (TRUNCATEs store CASCADE). The mailer,
 * APNs and outbound-fetch seams are mocked; everything else is real.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from './db/client.js';
import { env } from './env.js';

vi.mock('./email/mailer.js', () => ({ sendEmail: vi.fn() }));
vi.mock('./security/outbound-url.js', () => ({ safeOutboundFetch: vi.fn() }));
let apnsImpl: () => Promise<{ ok: boolean; status: number; unregistered: boolean; reason?: string }> =
  async () => ({ ok: true, status: 200, unregistered: false });
vi.mock('./push/apns.js', async (orig) => {
  const actual = await orig<typeof import('./push/apns.js')>();
  return { ...actual, apnsConfigured: () => true, sendApns: async () => apnsImpl() };
});

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`instrumentation test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

import { sendEmail } from './email/mailer.js';
import { safeOutboundFetch } from './security/outbound-url.js';
import { deliverEmails } from './email/outbox.js';
import { deliverPushes } from './push/outbox.js';
import { deliverWebhooks } from './webhooks/emit.js';
import { reapStuckWebhooks } from './jobs/webhook-reaper.js';

const STORE = 'cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd';

type Row = { status: string; attempts: number; claimed_at: Date | null; first_failed_at: Date | null; updated_at: Date | null; created_at: Date };
const rowOf = (table: 'email_outbox' | 'push_outbox' | 'webhook_delivery', id: string) =>
  withStore(STORE, async (tx) => {
    const ms = (c: string) => `(extract(epoch from ${c}) * 1000)::float8 AS ${c}`;
    const r = await tx.execute(sql.raw(
      `SELECT status, attempts, ${ms('claimed_at')}, ${ms('first_failed_at')}, ${ms('updated_at')}, ${ms('created_at')} FROM ${table} WHERE id = '${id}'`));
    const raw = r.rows[0] as Record<string, unknown>;
    const d = (v: unknown) => (v == null ? null : new Date(Number(v)));
    return { status: raw.status, attempts: raw.attempts, claimed_at: d(raw.claimed_at), first_failed_at: d(raw.first_failed_at),
      updated_at: d(raw.updated_at), created_at: d(raw.created_at) } as Row;
  });
/** Make a row due again without touching the claim columns. */
const makeDue = (table: string, id: string) =>
  withStore(STORE, (tx) => tx.execute(sql.raw(`UPDATE ${table} SET next_attempt_at = now() - interval '1 minute' WHERE id = '${id}'`)));

async function enqueueEmailRow(): Promise<string> {
  return withStore(STORE, async (tx) => {
    const payload = JSON.stringify({ to: 'a@example.com', subject: 's', html: '<p>s</p>', text: 's' });
    // Insert WITHOUT any 0088 column: proves the previous release's INSERT shape still works.
    const r = await tx.execute(sql`INSERT INTO email_outbox (store_id, kind, recipient, payload) VALUES (${STORE}, 'order_confirmation', 'a@example.com', ${payload}::jsonb) RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
}
async function enqueuePushRow(): Promise<string> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`INSERT INTO push_outbox (store_id, topic, device_token, payload) VALUES (${STORE}, 'order.paid', 'tok-' || gen_random_uuid()::text, '{"aps":{}}'::jsonb) RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
}
async function enqueueWebhookRow(): Promise<string> {
  return withStore(STORE, async (tx) => {
    const ep = await tx.execute(sql`INSERT INTO webhook_endpoint (store_id, url, topics, secret) VALUES (${STORE}, 'https://example.com/h', ARRAY['*'], 'sec') RETURNING id`);
    const endpointId = (ep.rows[0] as { id: string }).id;
    const r = await tx.execute(sql`INSERT INTO webhook_delivery (store_id, endpoint_id, topic, payload, next_attempt_at) VALUES (${STORE}, ${endpointId}, 't', '{}'::jsonb, now() - interval '1 minute') RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  apnsImpl = async () => ({ ok: true, status: 200, unregistered: false });
  await pool.query('TRUNCATE store CASCADE');
  await pool.query(`INSERT INTO store (id, slug, name) VALUES ($1, 'instr-test', 'Instr Test')`, [STORE]);
});
afterAll(async () => { await pool.query('TRUNCATE store CASCADE'); await pool.end(); });

describe('email_outbox claim instrumentation', () => {
  it('old-shape insert leaves the new columns NULL', async () => {
    const r = await rowOf('email_outbox', await enqueueEmailRow());
    expect(r.claimed_at).toBeNull();
    expect(r.first_failed_at).toBeNull();
  });

  it('sets claimed_at at claim, clears it on success, leaves first_failed_at NULL', async () => {
    const id = await enqueueEmailRow();
    let during: Row | undefined;
    vi.mocked(sendEmail).mockImplementation(async () => { during = await rowOf('email_outbox', id); return { delivered: true } as never; });
    await deliverEmails();
    expect(during!.status).toBe('processing');
    expect(during!.claimed_at).toBeInstanceOf(Date);
    const after = await rowOf('email_outbox', id);
    expect(after.status).toBe('sent');
    expect(after.claimed_at).toBeNull();
    expect(after.first_failed_at).toBeNull();
  });

  it('nulls claimed_at on a failed attempt and stamps first_failed_at once', async () => {
    const id = await enqueueEmailRow();
    vi.mocked(sendEmail).mockRejectedValue(new Error('smtp down'));
    await deliverEmails();
    const first = await rowOf('email_outbox', id);
    expect(first.status).toBe('pending');
    expect(first.claimed_at).toBeNull();
    expect(first.first_failed_at).toBeInstanceOf(Date);

    await makeDue('email_outbox', id);
    await deliverEmails();
    const second = await rowOf('email_outbox', id);
    expect(second.attempts).toBe(2);
    expect(second.first_failed_at!.getTime()).toBe(first.first_failed_at!.getTime()); // not overwritten
    expect(second.claimed_at).toBeNull();
  });

  it('refreshes claimed_at when a stale processing row is reclaimed', async () => {
    const id = await enqueueEmailRow();
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE email_outbox SET status='processing', attempts=1, claimed_at = now() - interval '1 hour', updated_at = now() - interval '1 hour' WHERE id = ${id}`));
    let during: Row | undefined;
    vi.mocked(sendEmail).mockImplementation(async () => { during = await rowOf('email_outbox', id); return { delivered: true } as never; });
    await deliverEmails();
    expect(Date.now() - during!.claimed_at!.getTime()).toBeLessThan(60_000);
  });
});

describe('push_outbox claim instrumentation', () => {
  it('claim / success / failure / unregistered', async () => {
    // success
    const ok = await enqueuePushRow();
    let during: Row | undefined;
    apnsImpl = async () => { during = await rowOf('push_outbox', ok); return { ok: true, status: 200, unregistered: false }; };
    await deliverPushes();
    expect(during!.status).toBe('processing');
    expect(during!.claimed_at).toBeInstanceOf(Date);
    const sent = await rowOf('push_outbox', ok);
    expect(sent).toMatchObject({ status: 'sent', claimed_at: null, first_failed_at: null });

    // retryable failure, then a second failure keeps first_failed_at
    const bad = await enqueuePushRow();
    apnsImpl = async () => ({ ok: false, status: 500, unregistered: false, reason: 'boom' });
    await deliverPushes();
    const f1 = await rowOf('push_outbox', bad);
    expect(f1.status).toBe('pending');
    expect(f1.claimed_at).toBeNull();
    expect(f1.first_failed_at).toBeInstanceOf(Date);
    await makeDue('push_outbox', bad);
    await deliverPushes();
    const f2 = await rowOf('push_outbox', bad);
    expect(f2.attempts).toBe(2);
    expect(f2.first_failed_at!.getTime()).toBe(f1.first_failed_at!.getTime());

    // unregistered → dead; claim released, first failure stamped
    const gone = await enqueuePushRow();
    apnsImpl = async () => ({ ok: false, status: 410, unregistered: true, reason: 'Unregistered' });
    await deliverPushes();
    expect(await rowOf('push_outbox', gone)).toMatchObject({ status: 'dead', claimed_at: null });
    expect((await rowOf('push_outbox', gone)).first_failed_at).toBeInstanceOf(Date);
  });
});

describe('webhook_delivery claim instrumentation', () => {
  it('claim sets claimed_at + updated_at; delivered releases the claim', async () => {
    const id = await enqueueWebhookRow();
    const before = await rowOf('webhook_delivery', id);
    let during: Row | undefined;
    vi.mocked(safeOutboundFetch).mockImplementation(async () => { during = await rowOf('webhook_delivery', id); return new Response(null, { status: 200 }); });
    await deliverWebhooks();
    expect(during!.status).toBe('processing');
    expect(during!.claimed_at).toBeInstanceOf(Date);
    expect(during!.updated_at!.getTime()).toBeGreaterThanOrEqual(before.updated_at!.getTime());
    const after = await rowOf('webhook_delivery', id);
    expect(after).toMatchObject({ status: 'delivered', claimed_at: null, first_failed_at: null });
  });

  it('failure releases the claim and stamps first_failed_at once', async () => {
    const id = await enqueueWebhookRow();
    vi.mocked(safeOutboundFetch).mockResolvedValue(new Response(null, { status: 500 }));
    await deliverWebhooks();
    const f1 = await rowOf('webhook_delivery', id);
    expect(f1.status).toBe('pending');
    expect(f1.claimed_at).toBeNull();
    expect(f1.first_failed_at).toBeInstanceOf(Date);
    await makeDue('webhook_delivery', id);
    await deliverWebhooks();
    const f2 = await rowOf('webhook_delivery', id);
    expect(f2.attempts).toBe(2);
    expect(f2.first_failed_at!.getTime()).toBe(f1.first_failed_at!.getTime());
    expect(f2.claimed_at).toBeNull();
  });

  it('reaper uses the claim time (not created_at) and nulls claimed_at on release', async () => {
    const fresh = await enqueueWebhookRow(); // old row, but claimed a moment ago
    const stuck = await enqueueWebhookRow();
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`UPDATE webhook_delivery SET created_at = now() - interval '1 day' WHERE id IN (${fresh}, ${stuck})`);
      await tx.execute(sql`UPDATE webhook_delivery SET status='processing', claimed_at = now(), updated_at = now() WHERE id = ${fresh}`);
      await tx.execute(sql`UPDATE webhook_delivery SET status='processing', claimed_at = now() - interval '1 hour' WHERE id = ${stuck}`);
      await tx.execute(sql`UPDATE webhook_delivery SET updated_at = now() - interval '1 hour' WHERE id = ${stuck}`);
    });
    const res = await reapStuckWebhooks({ apply: true, graceMin: 10 });
    expect(res.reset).toBe(1);
    expect(await rowOf('webhook_delivery', stuck)).toMatchObject({ status: 'pending', claimed_at: null });
    expect(await rowOf('webhook_delivery', fresh)).toMatchObject({ status: 'processing' });
  });
});
