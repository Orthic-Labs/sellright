/**
 * DB tests for passwordless sign-in (ported upstream from RightSites, hardened:
 * redemption is a single conditional UPDATE — the RightSites original checked
 * used_at then wrote in a second statement, which could issue two sessions for
 * one link under concurrent consumes).
 *
 * Covers:
 *   1. Disabled by default — an unconfigured store gets 409 from both
 *      endpoints (no token minted, no email queued).
 *   2. Request is enumeration-safe: identical 200 for unknown emails, and no
 *      token/outbox row is written for them.
 *   3. The email is a durable outbox row branded for the RESOLVED store
 *      (SR-05/SR-12 — never another tenant's sender/storefront).
 *   4. Consume exchanges the token for a session, marks it used, and proves
 *      mailbox control (emailVerified flips true).
 *   5. Replay / expired / cross-store tokens → 409.
 *   6. ATOMICITY: two concurrent consumes of one token → exactly one 200 and
 *      exactly one session row.
 *   7. The request endpoint is rate-limited per ip+email bucket.
 *
 * Runs against a *_test DB only (TRUNCATEs store CASCADE).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { invalidateStoreCache } from '../store-context.js';
import { auth } from '../routes/auth.js';
import { mintMagicLink } from './magic-link.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`magic-link test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE_ON = 'eeeeeeee-1111-1111-1111-111111111111';
const STORE_OFF = 'eeeeeeee-2222-2222-2222-222222222222';
const STORE_ON2 = 'eeeeeeee-3333-3333-3333-333333333333';
const SLUG_ON = 'ml-store-on';
const SLUG_OFF = 'ml-store-off';
const SLUG_ON2 = 'ml-store-on2';
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

const app = new OpenAPIHono();
app.route('/', auth);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
}

beforeEach(async () => {
  await wipe();
  await pool.query(
    `INSERT INTO store (id, slug, name, currency, config) VALUES
       ($1, $3, 'Link Store', 'USD', $5::jsonb),
       ($2, $4, 'Plain Store', 'USD', $6::jsonb),
       ($7, $8, 'Second Link Store', 'USD', $9::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      STORE_ON, STORE_OFF, SLUG_ON, SLUG_OFF,
      JSON.stringify({ storefrontUrl: 'https://link.example', emailFrom: 'hello@link.example', auth: { magicLink: true } }),
      JSON.stringify({ storefrontUrl: 'https://plain.example', emailFrom: 'hello@plain.example' }),
      STORE_ON2, SLUG_ON2,
      JSON.stringify({ storefrontUrl: 'https://link2.example', emailFrom: 'hello@link2.example', auth: { magicLink: true } }),
    ],
  );
  invalidateStoreCache();
});
afterAll(async () => { await wipe(); await pool.end(); });

const hdr = (slug: string) => ({ 'content-type': 'application/json', 'x-store-slug': slug });
const req = (slug: string, email: string) =>
  app.request('/v1/shop/auth/magic-link/request', { method: 'POST', headers: hdr(slug), body: JSON.stringify({ email }) });
const consume = (slug: string, token: string) =>
  app.request('/v1/shop/auth/magic-link/consume', { method: 'POST', headers: hdr(slug), body: JSON.stringify({ token }) });

async function seedCustomer(storeId: string, email: string, emailVerified = false): Promise<string> {
  return withStore(storeId, async (tx) => {
    const [c] = await tx.insert(s.customer).values({ storeId, email, emailVerified }).returning({ id: s.customer.id });
    return c!.id;
  });
}

type OutboxRow = { kind: string; recipient: string; payload: { to?: string; from?: string; subject?: string; html?: string }; status: string };
async function outbox(storeId: string): Promise<OutboxRow[]> {
  return withStore(storeId, async (tx) => {
    const r = await tx.execute(sql`SELECT kind, recipient, payload, status FROM email_outbox WHERE store_id = ${storeId} ORDER BY created_at`);
    return r.rows as OutboxRow[];
  });
}

async function tokenRow(storeId: string, raw: string) {
  return withStore(storeId, async (tx) => {
    const r = await tx.execute(sql`SELECT used_at, expires_at FROM customer_token WHERE token_hash = ${hashToken(raw)}`);
    return r.rows[0] as { used_at: Date | null; expires_at: Date } | undefined;
  });
}

async function sessionCount(storeId: string, customerId: string): Promise<number> {
  return withStore(storeId, async (tx) =>
    (await tx.select({ id: s.session.id }).from(s.session).where(eq(s.session.customerId, customerId))).length);
}

function rawFromOutbox(row: OutboxRow): string {
  const m = /[?&]token=([A-Za-z0-9_-]+)/.exec(row.payload.html ?? '');
  expect(m, 'magic-link email carries a token').toBeTruthy();
  return m![1]!;
}

describe('disabled by default', () => {
  it('request + consume 409 when the store has not opted in', async () => {
    await seedCustomer(STORE_OFF, 'off@b.test');
    expect((await req(SLUG_OFF, 'off@b.test')).status).toBe(409);
    expect((await consume(SLUG_OFF, 'x'.repeat(32))).status).toBe(409);
    expect(await outbox(STORE_OFF)).toHaveLength(0);
    const tokens = await withStore(STORE_OFF, async (tx) =>
      (await tx.execute(sql`SELECT id FROM customer_token WHERE kind = 'magic_link'`)).rows.length);
    expect(tokens).toBe(0);
  });
});

describe('POST /v1/shop/auth/magic-link/request', () => {
  it('enqueues a durable magic_link email branded for the resolved store', async () => {
    await seedCustomer(STORE_ON, 'ml1@a.test');
    const res = await req(SLUG_ON, 'ml1@a.test');
    expect(res.status).toBe(200);
    const rows = await outbox(STORE_ON);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe('magic_link');
    expect(row.status).toBe('pending');
    expect(row.recipient).toBe('ml1@a.test');
    expect(row.payload.from).toBe('hello@link.example');
    expect(row.payload.html).toContain('https://link.example/account/magic-link?token=');
    expect(row.payload.html).not.toContain('plain.example');
  });

  it('returns the identical 200 for an unknown email — and writes nothing', async () => {
    const res = await req(SLUG_ON, 'ghost-ml@a.test');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await outbox(STORE_ON)).toHaveLength(0);
    const n = await withStore(STORE_ON, async (tx) =>
      (await tx.execute(sql`SELECT id FROM customer_token WHERE kind = 'magic_link'`)).rows.length);
    expect(n).toBe(0);
  });

  it('is rate-limited per ip+email bucket', async () => {
    await seedCustomer(STORE_ON, 'flood@a.test');
    let last = 0;
    for (let i = 0; i < 9; i++) last = (await req(SLUG_ON, 'flood@a.test')).status;
    expect(last).toBe(429);
  });
});

describe('POST /v1/shop/auth/magic-link/consume', () => {
  it('exchanges a token for a session, marks it used, verifies the email', async () => {
    const custId = await seedCustomer(STORE_ON, 'consume@a.test', false);
    await req(SLUG_ON, 'consume@a.test');
    const [row] = await outbox(STORE_ON);
    const raw = rawFromOutbox(row!);

    const res = await consume(SLUG_ON, raw);
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string; customer: { id: string; emailVerified: boolean } };
    expect(body.customer.id).toBe(custId);
    expect(body.customer.emailVerified).toBe(true);
    expect(body.token.length).toBeGreaterThan(20);

    const tok = await tokenRow(STORE_ON, raw);
    expect(tok!.used_at).not.toBeNull();
    const cust = await withStore(STORE_ON, async (tx) =>
      (await tx.select({ emailVerified: s.customer.emailVerified }).from(s.customer).where(eq(s.customer.id, custId)))[0]);
    expect(cust!.emailVerified).toBe(true);

    // Replay → single-use guard rejects.
    expect((await consume(SLUG_ON, raw)).status).toBe(409);
    expect(await sessionCount(STORE_ON, custId)).toBe(1);
  });

  it('ATOMIC: concurrent consumes of one token issue exactly one session', async () => {
    const custId = await seedCustomer(STORE_ON, 'race@a.test');
    const raw = await withStore(STORE_ON, (tx) => mintMagicLink(tx, STORE_ON, custId, 15));
    // Four simultaneous redemptions: the single conditional UPDATE serializes
    // on the row lock — exactly one wins, the rest see used_at set → 409.
    const results = await Promise.all([
      consume(SLUG_ON, raw), consume(SLUG_ON, raw), consume(SLUG_ON, raw), consume(SLUG_ON, raw),
    ]);
    const ok = results.filter((r) => r.status === 200);
    const rejected = results.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(3);
    expect(await sessionCount(STORE_ON, custId)).toBe(1);
    expect((await tokenRow(STORE_ON, raw))!.used_at).not.toBeNull();
  });

  it('rejects expired, bogus, and cross-store tokens', async () => {
    const custId = await seedCustomer(STORE_ON, 'exp@a.test');
    const raw = await withStore(STORE_ON, (tx) => mintMagicLink(tx, STORE_ON, custId, 15));
    await withStore(STORE_ON, (tx) =>
      tx.execute(sql`UPDATE customer_token SET expires_at = now() - interval '1 minute' WHERE token_hash = ${hashToken(raw)}`));
    expect((await consume(SLUG_ON, raw)).status).toBe(409); // expired

    const fresh = await withStore(STORE_ON, (tx) => mintMagicLink(tx, STORE_ON, custId, 15));
    // Cross-store: a token minted under one store cannot be consumed through
    // another ENABLED store — the consume UPDATE carries a store_id predicate.
    expect((await consume(SLUG_ON2, fresh)).status).toBe(409);
    expect((await tokenRow(STORE_ON, fresh))!.used_at).toBeNull();
    expect((await consume(SLUG_ON, 'bogus-token-value-that-is-long')).status).toBe(409);
    // and the fresh token still works afterward in its own store
    expect((await consume(SLUG_ON, fresh)).status).toBe(200);
  });
});
