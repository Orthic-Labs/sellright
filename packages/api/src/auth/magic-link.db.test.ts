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
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { invalidateStoreCache } from '../store-context.js';
import { auth } from '../routes/auth.js';
import { shopConfig } from '../routes/shop-config.js';
import { mintMagicLink } from './magic-link.js';
import { verifyTurnstileToken } from '../security/turnstile.js';

// Turnstile seam: the verifier is mocked so these tests exercise the magic-link gate itself. A token of 'good' passes.
vi.mock('../security/turnstile.js', () => ({
  verifyTurnstileToken: vi.fn(async ({ secret, token }: { secret: string | null; token: string | null }) => !secret || token === 'good'),
}));

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
assertTestDatabase(DB, 'magic-link.db.test.ts');

const STORE_ON = 'eeeeeeee-1111-1111-1111-111111111111';
const STORE_OFF = 'eeeeeeee-2222-2222-2222-222222222222';
const STORE_ON2 = 'eeeeeeee-3333-3333-3333-333333333333';
const SLUG_ON = 'ml-store-on';
const SLUG_OFF = 'ml-store-off';
const SLUG_ON2 = 'ml-store-on2';
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

const app = new OpenAPIHono();
app.route('/', auth);
app.route('/', shopConfig);

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

describe('GET /v1/shop/config advertises whether sign-in links are on', () => {
  // The storefront offers "email me a sign-in link" only when this says true — never a button that answers 409.
  const flag = async (slug: string) =>
    ((await (await app.request('/v1/shop/config', { headers: hdr(slug) })).json()) as { auth: { magicLink: boolean } }).auth.magicLink;
  it('is true for a store that enabled it and false for one that did not', async () => {
    expect(await flag(SLUG_ON)).toBe(true);
    expect(await flag(SLUG_OFF)).toBe(false);
  });
});

describe('POST /v1/shop/auth/magic-link/request — Turnstile gate', () => {
  const withTurnstile = async () => {
    await pool.query(
      `UPDATE store SET config = config || $2::jsonb WHERE id = $1`,
      [STORE_ON2, JSON.stringify({ turnstileSecretKey: 'test-secret' })],
    );
    invalidateStoreCache();
  };
  const reqWith = (slug: string, email: string, turnstileToken?: string) =>
    app.request('/v1/shop/auth/magic-link/request', { method: 'POST', headers: hdr(slug), body: JSON.stringify({ email, turnstileToken }) });

  it('refuses a request without a token when the store has Turnstile configured, and sends nothing', async () => {
    await seedCustomer(STORE_ON2, 'ts-none@a.test');
    await withTurnstile();
    vi.mocked(verifyTurnstileToken).mockClear();
    const res = await reqWith(SLUG_ON2, 'ts-none@a.test');
    expect(res.status).toBe(403);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('BOT_CHECK_FAILED');
    expect(vi.mocked(verifyTurnstileToken)).toHaveBeenCalledTimes(1);
    expect(await outbox(STORE_ON2)).toHaveLength(0);
  });

  it('refuses an invalid token the same way', async () => {
    await seedCustomer(STORE_ON2, 'ts-bad@a.test');
    await withTurnstile();
    const res = await reqWith(SLUG_ON2, 'ts-bad@a.test', 'forged');
    expect(res.status).toBe(403);
    expect(await outbox(STORE_ON2)).toHaveLength(0);
  });

  it('accepts a valid token and sends the link as before', async () => {
    await seedCustomer(STORE_ON2, 'ts-good@a.test');
    await withTurnstile();
    const res = await reqWith(SLUG_ON2, 'ts-good@a.test', 'good');
    expect(res.status).toBe(200);
    expect(await outbox(STORE_ON2)).toHaveLength(1);
  });

  it('a store without Turnstile configured never calls the verifier and ignores the token field', async () => {
    await seedCustomer(STORE_ON, 'ts-off@a.test');
    vi.mocked(verifyTurnstileToken).mockClear();
    const noToken = await req(SLUG_ON, 'ts-off@a.test');
    const withToken = await reqWith(SLUG_ON, 'ts-off@a.test', 'anything');
    expect(noToken.status).toBe(200);
    expect(withToken.status).toBe(200);
    // the no-secret policy lives in verifyTurnstileToken: it is consulted with no secret, and the token never matters
    expect(vi.mocked(verifyTurnstileToken).mock.calls.every(([a]) => a.secret === null)).toBe(true);
  });
});

// --- #350: the one-time code in the same email --------------------------------------------------------------------------
const consumeCode = (slug: string, email: string, code: string) =>
  app.request('/v1/shop/auth/magic-link/consume-code', { method: 'POST', headers: hdr(slug), body: JSON.stringify({ email, code }) });

function codeFromOutbox(row: OutboxRow): string {
  const m = /letter-spacing:4px;text-align:center">(\d{6})</.exec(row.payload.html ?? '');
  expect(m, 'magic-link email carries a 6-digit code').toBeTruthy();
  return m![1]!;
}
const wrongCode = (code: string) => (code === '000000' ? '000001' : '000000');
const errCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe('one-time code (#350)', () => {
  it('the email carries a code that redeems with the email: session, mailbox verified, token row used', async () => {
    const custId = await seedCustomer(STORE_ON, 'code1@b.test');
    expect((await req(SLUG_ON, 'code1@b.test')).status).toBe(200);
    const [mail] = await outbox(STORE_ON);
    const code = codeFromOutbox(mail!);
    const raw = rawFromOutbox(mail!);

    const res = await consumeCode(SLUG_ON, 'code1@b.test', code);
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string; customer: { id: string; emailVerified: boolean } };
    expect(body.customer.id).toBe(custId);
    expect(body.customer.emailVerified).toBe(true);
    expect(body.token.length).toBeGreaterThan(20);
    expect(res.headers.get('set-cookie')).toMatch(/sr_cust=/);
    expect((await tokenRow(STORE_ON, raw))?.used_at).toBeTruthy();
    expect(await sessionCount(STORE_ON, custId)).toBe(1);
  });

  it('accepts the code with spaces or a hyphen, and any email casing', async () => {
    await seedCustomer(STORE_ON, 'code2@b.test');
    await req(SLUG_ON, 'code2@b.test');
    const code = codeFromOutbox((await outbox(STORE_ON))[0]!);
    expect((await consumeCode(SLUG_ON, 'Code2@B.test', `${code.slice(0, 3)} ${code.slice(3)}`)).status).toBe(200);
  });

  it('is single use, and redeeming the code burns the link too', async () => {
    await seedCustomer(STORE_ON, 'code3@b.test');
    await req(SLUG_ON, 'code3@b.test');
    const [mail] = await outbox(STORE_ON);
    const code = codeFromOutbox(mail!);
    expect((await consumeCode(SLUG_ON, 'code3@b.test', code)).status).toBe(200);
    const again = await consumeCode(SLUG_ON, 'code3@b.test', code);
    expect(again.status).toBe(409);
    expect(await errCode(again)).toBe('MAGIC_LINK_INVALID');
    expect((await consume(SLUG_ON, rawFromOutbox(mail!))).status).toBe(409);
  });

  it('redeeming the link burns the code too', async () => {
    await seedCustomer(STORE_ON, 'code4@b.test');
    await req(SLUG_ON, 'code4@b.test');
    const [mail] = await outbox(STORE_ON);
    expect((await consume(SLUG_ON, rawFromOutbox(mail!))).status).toBe(200);
    expect((await consumeCode(SLUG_ON, 'code4@b.test', codeFromOutbox(mail!))).status).toBe(409);
  });

  it('stores only a hash of the code, on the link row', async () => {
    await seedCustomer(STORE_ON, 'code5@b.test');
    await req(SLUG_ON, 'code5@b.test');
    const code = codeFromOutbox((await outbox(STORE_ON))[0]!);
    const rows = await withStore(STORE_ON, async (tx) =>
      (await tx.execute(sql`SELECT payload, expires_at, created_at FROM customer_token WHERE kind = 'magic_link'`)).rows as Array<{ payload: { codeHash: string } | null; expires_at: Date; created_at: Date }>);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows[0]!.payload)).not.toContain(code);
  });

  it('a wrong code, an unknown email and a malformed code are the same 409, and mint no session', async () => {
    await seedCustomer(STORE_ON, 'code6@b.test');
    await req(SLUG_ON, 'code6@b.test');
    const code = codeFromOutbox((await outbox(STORE_ON))[0]!);
    const results = [
      await consumeCode(SLUG_ON, 'code6@b.test', wrongCode(code)),
      await consumeCode(SLUG_ON, 'nobody6@b.test', code),
      await consumeCode(SLUG_ON, 'code6@b.test', 'abc'),
    ];
    const bodies: unknown[] = [];
    for (const r of results) { expect(r.status).toBe(409); expect(r.headers.get('set-cookie')).toBeNull(); bodies.push(await r.json().then((b) => ({ ...(b as { error: object }).error, requestId: undefined }))); }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect((await pool.query('SELECT 1 FROM "session"')).rowCount).toBe(0);
    // The right code still works afterwards (a few misses do not burn it).
    expect((await consumeCode(SLUG_ON, 'code6@b.test', code)).status).toBe(200);
  });

  it('an expired code 409s', async () => {
    await seedCustomer(STORE_ON, 'code7@b.test');
    await req(SLUG_ON, 'code7@b.test');
    const code = codeFromOutbox((await outbox(STORE_ON))[0]!);
    await withStore(STORE_ON, (tx) => tx.execute(sql`UPDATE customer_token SET expires_at = now() - interval '1 minute' WHERE kind = 'magic_link'`));
    expect((await consumeCode(SLUG_ON, 'code7@b.test', code)).status).toBe(409);
  });

  it('a newer request supersedes the earlier code but leaves the earlier link working', async () => {
    await seedCustomer(STORE_ON, 'code8@b.test');
    await req(SLUG_ON, 'code8@b.test');
    // The outbox dedupes nothing here (no dedupe key), so a second request mails a second link + code.
    await req(SLUG_ON, 'code8@b.test');
    const [first, second] = await outbox(STORE_ON);
    const c1 = codeFromOutbox(first!), c2 = codeFromOutbox(second!);
    if (c1 !== c2) {
      expect((await consumeCode(SLUG_ON, 'code8@b.test', c1)).status).toBe(409);
      expect((await consume(SLUG_ON, rawFromOutbox(first!))).status).toBe(200);
      // The first link was redeemed; the newest code is a separate row and still redeems.
      expect((await consumeCode(SLUG_ON, 'code8@b.test', c2)).status).toBe(200);
    }
  });

  it('is scoped to the store: another store with the same email cannot redeem it', async () => {
    await seedCustomer(STORE_ON, 'code9@b.test');
    await seedCustomer(STORE_ON2, 'code9@b.test');
    await req(SLUG_ON, 'code9@b.test');
    const code = codeFromOutbox((await outbox(STORE_ON))[0]!);
    expect((await consumeCode(SLUG_ON2, 'code9@b.test', code)).status).toBe(409);
    expect((await consumeCode(SLUG_ON, 'code9@b.test', code)).status).toBe(200);
  });

  it('409s MAGIC_LINK_DISABLED on a store that has not opted in', async () => {
    const res = await consumeCode(SLUG_OFF, 'off@b.test', '123456');
    expect(res.status).toBe(409);
    expect(await errCode(res)).toBe('MAGIC_LINK_DISABLED');
  });

  it('two concurrent redemptions of one code yield exactly one session', async () => {
    const custId = await seedCustomer(STORE_ON, 'code10@b.test');
    await req(SLUG_ON, 'code10@b.test');
    const code = codeFromOutbox((await outbox(STORE_ON))[0]!);
    const statuses = (await Promise.all([consumeCode(SLUG_ON, 'code10@b.test', code), consumeCode(SLUG_ON, 'code10@b.test', code)])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(await sessionCount(STORE_ON, custId)).toBe(1);
  });

  it('throttles guesses per email: after 8 misses even the right code is refused (429), while the link still works', async () => {
    await seedCustomer(STORE_ON, 'code11@b.test');
    await req(SLUG_ON, 'code11@b.test');
    const [mail] = await outbox(STORE_ON);
    const code = codeFromOutbox(mail!);
    for (let i = 0; i < 8; i++) expect((await consumeCode(SLUG_ON, 'code11@b.test', wrongCode(code))).status).toBe(409);
    const locked = await consumeCode(SLUG_ON, 'code11@b.test', code);
    expect(locked.status).toBe(429);
    expect(await errCode(locked)).toBe('RATE_LIMITED');
    expect((await consume(SLUG_ON, rawFromOutbox(mail!))).status).toBe(200);
  });

  it('counts misses for an unknown address too, so the throttle never reveals whether an account exists', async () => {
    for (let i = 0; i < 8; i++) expect((await consumeCode(SLUG_ON, 'ghost11@b.test', '123456')).status).toBe(409);
    expect((await consumeCode(SLUG_ON, 'ghost11@b.test', '123456')).status).toBe(429);
  });
});
