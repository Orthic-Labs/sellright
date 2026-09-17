/**
 * DB tests for the customer-token routes (SR-05 branding, SR-12 durable send,
 * PAR-06 Turnstile wiring, emailAddressChangeHandler parity).
 *
 * Covers:
 *   1. forgot-password enqueues a password_reset outbox row whose sender +
 *      link come from the RESOLVED store's config — never the env globals of
 *      another tenant (SR-05 regression guard; env points at brand A).
 *   2. Turnstile enforced when the store config carries a secret
 *      (register/login/forgot-password fail closed on verification failure).
 *   3. request-email-change → verification mail to the NEW address →
 *      verify-email-change flips customer.email, marks the token used
 *      (single-use), expires, supersedes older links, kills sessions.
 *
 * Runs against a *_test DB only (TRUNCATEs store CASCADE).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { invalidateStoreCache } from '../store-context.js';

// PAR-06 seam: the turnstile helper lives in the par-customer lane — mock it so
// these tests exercise OUR wiring (secret resolution + fail-closed), not theirs.
vi.mock('../security/turnstile.js', () => ({
  verifyTurnstileToken: vi.fn(async () => true),
}));

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`customer-tokens test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

import { verifyTurnstileToken } from '../security/turnstile.js';
import { customerTokens } from './customer-tokens.js';
import { auth } from './auth.js';
import { hashPassword } from '../auth/password.js';
import { createSession } from '../auth/session.js';

const STORE_A = 'aaaaaaaa-1111-1111-1111-111111111111';
const STORE_B = 'bbbbbbbb-2222-2222-2222-222222222222';
const STORE_T = 'cccccccc-3333-3333-3333-333333333333';
const SLUG_A = 'ct-brand-a';
const SLUG_B = 'ct-brand-b';
const SLUG_T = 'ct-brand-t';

const app = new OpenAPIHono();
app.route('/', customerTokens);
app.route('/', auth);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
}

async function seedStores(): Promise<void> {
  await pool.query(
    `INSERT INTO store (id, slug, name, currency, config) VALUES
       ($1, $4, 'Brand A', 'USD', $7::jsonb),
       ($2, $5, 'Brand B', 'EUR', $8::jsonb),
       ($3, $6, 'Turnstile Store', 'USD', $9::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      STORE_A, STORE_B, STORE_T, SLUG_A, SLUG_B, SLUG_T,
      JSON.stringify({ storefrontUrl: 'https://a-brand.example', emailFrom: 'orders@a-brand.example' }),
      JSON.stringify({ storefrontUrl: 'https://b-brand.example', emailFrom: 'orders@b-brand.example' }),
      JSON.stringify({ storefrontUrl: 'https://t-brand.example', emailFrom: 'orders@t-brand.example', turnstileSecretKey: 'cf-secret-1' }),
    ],
  );
}

beforeEach(async () => {
  vi.mocked(verifyTurnstileToken).mockResolvedValue(true);
  await wipe();
  await seedStores();
  invalidateStoreCache();
});
afterAll(async () => { await wipe(); await pool.end(); });

const hdr = (slug: string, extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', 'x-store-slug': slug, ...extra });

async function seedCustomer(storeId: string, email: string, password = 'correcthorsebattery'): Promise<{ id: string }> {
  return withStore(storeId, async (tx) => {
    const [c] = await tx.insert(s.customer).values({ storeId, email, passwordHash: await hashPassword(password), emailVerified: true }).returning({ id: s.customer.id });
    return { id: c!.id };
  });
}

// `type` so it stays `as`-castable from tx.execute's Record<string, unknown>[].
type OutboxRow = { id: string; kind: string; recipient: string; payload: { to?: string; from?: string; subject?: string; html?: string; text?: string }; status: string };

// Explicit store_id filter — the test pool's superuser bypasses RLS, so
// withStore alone would return every tenant's rows.
async function outbox(storeId: string): Promise<OutboxRow[]> {
  return withStore(storeId, async (tx) => {
    const r = await tx.execute(sql`SELECT id, kind, recipient, payload, status FROM email_outbox WHERE store_id = ${storeId} ORDER BY created_at`);
    return r.rows as OutboxRow[];
  });
}

describe('POST /v1/shop/auth/forgot-password (SR-05 + SR-12)', () => {
  it('enqueues a durable password_reset branded for the resolved store', async () => {
    await seedCustomer(STORE_B, 'reset-me@b.test');
    const res = await app.request('/v1/shop/auth/forgot-password', {
      method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ email: 'reset-me@b.test' }),
    });
    expect(res.status).toBe(200);
    const rows = await outbox(STORE_B);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe('password_reset');
    expect(row.status).toBe('pending'); // durable — retries via deliverEmails, not inline
    expect(row.recipient).toBe('reset-me@b.test');
    expect(row.payload.from).toBe('orders@b-brand.example');
    expect(row.payload.html).toContain('https://b-brand.example/password-reset?token=');
    expect(row.payload.html).not.toContain(env.STOREFRONT_URL); // no brand-A env leak
  });

  it('a second store never sees the first store’s links', async () => {
    await seedCustomer(STORE_A, 'reset-me@a.test');
    await seedCustomer(STORE_B, 'reset-me@b.test');
    await app.request('/v1/shop/auth/forgot-password', { method: 'POST', headers: hdr(SLUG_A), body: JSON.stringify({ email: 'reset-me@a.test' }) });
    await app.request('/v1/shop/auth/forgot-password', { method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ email: 'reset-me@b.test' }) });
    const [a] = await outbox(STORE_A);
    const [b] = await outbox(STORE_B);
    expect(a!.payload.from).toBe('orders@a-brand.example');
    expect(a!.payload.html).toContain('https://a-brand.example/password-reset?token=');
    expect(b!.payload.from).toBe('orders@b-brand.example');
    expect(b!.payload.html).toContain('https://b-brand.example/password-reset?token=');
    expect(b!.payload.html).not.toContain('a-brand.example');
  });

  it('always 200 for an unknown email (no enumeration, no row)', async () => {
    const res = await app.request('/v1/shop/auth/forgot-password', {
      method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ email: 'ghost@b.test' }),
    });
    expect(res.status).toBe(200);
    expect(await outbox(STORE_B)).toHaveLength(0);
  });
});

describe('Turnstile enforcement (PAR-06 wiring)', () => {
  it('blocks register when the configured store’s verification fails', async () => {
    vi.mocked(verifyTurnstileToken).mockResolvedValue(false);
    const res = await app.request('/v1/shop/auth/register', {
      method: 'POST', headers: hdr(SLUG_T), body: JSON.stringify({ email: 'bot@t.test', password: 'botpassword1' }),
    });
    expect(res.status).toBe(403);
    expect(verifyTurnstileToken).toHaveBeenCalledWith(expect.objectContaining({ secret: 'cf-secret-1' }));
    const n = await withStore(STORE_T, async (tx) => (await tx.select({ id: s.customer.id }).from(s.customer)).length);
    expect(n).toBe(0); // fail closed — no account created
  });

  it('blocks login + forgot-password the same way', async () => {
    vi.mocked(verifyTurnstileToken).mockResolvedValue(false);
    const login = await app.request('/v1/shop/auth/login', {
      method: 'POST', headers: hdr(SLUG_T), body: JSON.stringify({ email: 'x@t.test', password: 'whatever123' }),
    });
    const forgot = await app.request('/v1/shop/auth/forgot-password', {
      method: 'POST', headers: hdr(SLUG_T), body: JSON.stringify({ email: 'x@t.test' }),
    });
    expect(login.status).toBe(403);
    expect(forgot.status).toBe(403);
  });

  it('passes through when verification succeeds', async () => {
    vi.mocked(verifyTurnstileToken).mockResolvedValue(true);
    const res = await app.request('/v1/shop/auth/register', {
      method: 'POST', headers: hdr(SLUG_T), body: JSON.stringify({ email: 'human@t.test', password: 'humanpassword1', turnstileToken: 'cf-token' }),
    });
    expect(res.status).toBe(200);
    expect(verifyTurnstileToken).toHaveBeenCalledWith(expect.objectContaining({ secret: 'cf-secret-1', token: 'cf-token' }));
  });

  it('stores WITHOUT a secret never call the verifier (feature off)', async () => {
    vi.mocked(verifyTurnstileToken).mockClear();
    const res = await app.request('/v1/shop/auth/register', {
      method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ email: 'plain@b.test', password: 'plainpassword1' }),
    });
    expect(res.status).toBe(200);
    expect(verifyTurnstileToken).not.toHaveBeenCalled();
  });
});

describe('register → verify-email is durable + store-branded (SR-05/SR-12)', () => {
  it('enqueues email_verify into the outbox with the store’s sender + URL', async () => {
    const res = await app.request('/v1/shop/auth/register', {
      method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ email: 'newbie@b.test', password: 'newbiepassword1' }),
    });
    expect(res.status).toBe(200);
    const rows = await outbox(STORE_B);
    const v = rows.find((r) => r.kind === 'email_verify');
    expect(v).toBeDefined();
    expect(v!.recipient).toBe('newbie@b.test');
    expect(v!.payload.from).toBe('orders@b-brand.example');
    expect(v!.payload.html).toContain('https://b-brand.example/verify-email?token=');
    expect(v!.payload.html).not.toContain(env.STOREFRONT_URL);
  });
});

describe('email-address-change flow (emailAddressChangeHandler parity)', () => {
  async function requestChange(token: string, newEmail: string, password = 'correcthorsebattery') {
    return app.request('/v1/shop/auth/request-email-change', {
      method: 'POST', headers: hdr(SLUG_B, { authorization: `Bearer ${token}` }),
      body: JSON.stringify({ newEmail, password }),
    });
  }

  async function sessionFor(storeId: string, customerId: string): Promise<string> {
    return withStore(storeId, (tx) => createSession(tx, storeId, customerId));
  }

  function tokenFrom(row: OutboxRow): string {
    const m = /verify-email-address-change\?token=([A-Za-z0-9_-]+)/.exec(row.payload.html ?? '');
    expect(m).toBeTruthy();
    return m![1]!;
  }

  it('requires auth and the current password', async () => {
    const cust = await seedCustomer(STORE_B, 'old@b.test');
    const unauth = await app.request('/v1/shop/auth/request-email-change', {
      method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ newEmail: 'n1@b.test', password: 'correcthorsebattery' }),
    });
    expect(unauth.status).toBe(401);
    const token = await sessionFor(STORE_B, cust.id);
    const wrong = await requestChange(token, 'n2@b.test', 'nottherightpassword');
    expect(wrong.status).toBe(401);
    expect(await outbox(STORE_B)).toHaveLength(0);
  });

  it('sends the verification link to the NEW address, branded for the store', async () => {
    const cust = await seedCustomer(STORE_B, 'old@b.test');
    const token = await sessionFor(STORE_B, cust.id);
    const res = await requestChange(token, 'new@b.test');
    expect(res.status).toBe(200);
    const rows = await outbox(STORE_B);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe('email_change');
    expect(row.recipient).toBe('new@b.test');
    expect(row.payload.from).toBe('orders@b-brand.example');
    expect(row.payload.html).toContain('https://b-brand.example/verify-email-address-change?token=');
    expect(row.payload.html).not.toContain(env.STOREFRONT_URL);
  });

  it('verify-email-change flips the email, verifies it, kills sessions, is single-use', async () => {
    const cust = await seedCustomer(STORE_B, 'old@b.test');
    const token = await sessionFor(STORE_B, cust.id);
    await requestChange(token, 'new@b.test');
    const [row] = await outbox(STORE_B);
    const raw = tokenFrom(row!);

    const res = await app.request('/v1/shop/auth/verify-email-change', {
      method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ token: raw }),
    });
    expect(res.status).toBe(200);

    const after = await withStore(STORE_B, async (tx) => {
      const [c] = await tx.select().from(s.customer).where(eq(s.customer.id, cust.id)).limit(1);
      const sessions = await tx.select({ id: s.session.id }).from(s.session).where(eq(s.session.customerId, cust.id));
      const tok = await tx.execute(sql`SELECT used_at FROM customer_token WHERE token_hash = ${createHash('sha256').update(raw).digest('hex')}`);
      return { c, sessions, tok: tok.rows[0] as { used_at: Date | null } | undefined };
    });
    expect(after.c!.email).toBe('new@b.test');
    expect(after.c!.emailVerified).toBe(true);
    expect(after.sessions).toHaveLength(0); // session invalidated
    expect(after.tok!.used_at).not.toBeNull();

    // Replay → single-use guard rejects.
    const replay = await app.request('/v1/shop/auth/verify-email-change', {
      method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ token: raw }),
    });
    expect(replay.status).toBe(409);
  });

  it('rejects expired and bogus tokens', async () => {
    const cust = await seedCustomer(STORE_B, 'old2@b.test');
    const token = await sessionFor(STORE_B, cust.id);
    await requestChange(token, 'newer@b.test');
    const [row] = await outbox(STORE_B);
    const raw = tokenFrom(row!);
    await withStore(STORE_B, async (tx) => {
      await tx.execute(sql`UPDATE customer_token SET expires_at = now() - interval '1 hour' WHERE kind = 'email_change'`);
    });
    const res = await app.request('/v1/shop/auth/verify-email-change', {
      method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ token: raw }),
    });
    expect(res.status).toBe(409);
    const bogus = await app.request('/v1/shop/auth/verify-email-change', {
      method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ token: 'bogus-token-that-is-long-enough' }),
    });
    expect(bogus.status).toBe(409);
  });

  it('a newer request supersedes outstanding links; email taken → 409', async () => {
    const cust = await seedCustomer(STORE_B, 'old3@b.test');
    await seedCustomer(STORE_B, 'taken@b.test');
    const token = await sessionFor(STORE_B, cust.id);
    // taken address
    expect((await requestChange(token, 'taken@b.test')).status).toBe(409);
    // two outstanding requests — first link dies when the second is minted
    await requestChange(token, 'first@b.test');
    await requestChange(token, 'second@b.test');
    const rows = await outbox(STORE_B);
    const first = rows.find((r) => r.recipient === 'first@b.test')!;
    const second = rows.find((r) => r.recipient === 'second@b.test')!;
    const firstVerify = await app.request('/v1/shop/auth/verify-email-change', {
      method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ token: tokenFrom(first) }),
    });
    expect(firstVerify.status).toBe(409); // superseded
    const secondVerify = await app.request('/v1/shop/auth/verify-email-change', {
      method: 'POST', headers: hdr(SLUG_B), body: JSON.stringify({ token: tokenFrom(second) }),
    });
    expect(secondVerify.status).toBe(200);
  });
});
