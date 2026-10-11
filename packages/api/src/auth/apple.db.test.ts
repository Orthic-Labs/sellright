/**
 * Route-level DB tests for POST /v1/shop/auth/apple (ported upstream from
 * RightSites; generalized to per-store audience config).
 *
 * Covers:
 *   1. 409 when no audience is configured (default — feature off).
 *   2. 401 for a token whose aud isn't in the store's configured allowlist
 *      (mocked Apple JWKS; a client-supplied bundle id is never trusted).
 *   3. A valid token creates a passwordless customer + session, keyed by sub;
 *      repeat sign-ins (Private Relay, no email) resolve the SAME account.
 *   4. An existing customer is linked by email then matched by sub afterward.
 *
 * Runs against a *_test DB only (TRUNCATEs store CASCADE).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { invalidateStoreCache } from '../store-context.js';
import { auth } from '../routes/auth.js';
import { _resetAppleJwksCache } from './apple.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`apple route test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE_APPLE = 'ffffffff-1111-1111-1111-111111111111';
const STORE_NONE = 'ffffffff-2222-2222-2222-222222222222';
const SLUG_APPLE = 'apple-store';
const SLUG_NONE = 'noapple-store';
const AUD = 'com.example.ios';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pubJwk = publicKey.export({ format: 'jwk' }) as { kty: string; n: string; e: string };
const b64u = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

function appleJwt(over: Record<string, unknown> = {}): string {
  const header = { alg: 'RS256', kid: 'apple-kid', typ: 'JWT' };
  const payload = {
    iss: 'https://appleid.apple.com', aud: AUD, sub: 'sub-abc-123',
    exp: Math.floor(Date.now() / 1000) + 600, email_verified: 'true', ...over,
  };
  const input = `${b64u(header)}.${b64u(payload)}`;
  return `${input}.${cryptoSign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

const app = new OpenAPIHono();
app.route('/', auth);
const hdr = (slug: string) => ({ 'content-type': 'application/json', 'x-store-slug': slug });
const signIn = (slug: string, identityToken: string) =>
  app.request('/v1/shop/auth/apple', { method: 'POST', headers: hdr(slug), body: JSON.stringify({ identityToken }) });

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
}

beforeEach(async () => {
  _resetAppleJwksCache();
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ keys: [{ ...pubJwk, kid: 'apple-kid', use: 'sig', alg: 'RS256' }] }), { status: 200 })));
  await wipe();
  await pool.query(
    `INSERT INTO store (id, slug, name, currency, config) VALUES
       ($1, $3, 'Apple Store', 'USD', $5::jsonb),
       ($2, $4, 'No Apple', 'USD', '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [STORE_APPLE, STORE_NONE, SLUG_APPLE, SLUG_NONE, JSON.stringify({ auth: { appleClientId: AUD } })],
  );
  invalidateStoreCache();
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { await wipe(); await pool.end(); });

async function appleRow(storeId: string, sub: string) {
  return withStore(storeId, async (tx) =>
    (await tx.execute(sql`SELECT id, email, apple_user_id, email_verified FROM customer WHERE apple_user_id = ${sub} AND store_id = ${storeId}`)).rows[0] as
      { id: string; email: string; apple_user_id: string; email_verified: boolean } | undefined);
}

describe('POST /v1/shop/auth/apple', () => {
  it('409s when no audience is configured for the store', async () => {
    const res = await signIn(SLUG_NONE, appleJwt());
    expect(res.status).toBe(409);
  });

  it('rejects a token whose audience is not the configured one', async () => {
    const res = await signIn(SLUG_APPLE, appleJwt({ aud: 'com.evil.other-app' }));
    expect(res.status).toBe(401);
    expect((await appleRow(STORE_APPLE, 'sub-abc-123'))).toBeUndefined();
  });

  it('creates a passwordless account keyed by sub and returns a session', async () => {
    const res = await signIn(SLUG_APPLE, appleJwt({ email: 'ap@example.com' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string; customer: { id: string; email: string; emailVerified: boolean; isMigrated: boolean } };
    expect(body.customer.email).toBe('ap@example.com');
    expect(body.customer.emailVerified).toBe(true);
    expect(body.customer.isMigrated).toBe(true); // passwordless == credential-less
    expect(body.token.length).toBeGreaterThan(20);

    const row = await appleRow(STORE_APPLE, 'sub-abc-123');
    expect(row?.id).toBe(body.customer.id);

    // Repeat sign-in WITHOUT email (Private Relay behavior) → same account.
    const again = await signIn(SLUG_APPLE, appleJwt());
    expect(again.status).toBe(200);
    const againBody = await again.json() as { customer: { id: string } };
    expect(againBody.customer.id).toBe(body.customer.id);
  });

  const seed = (email: string, verified: boolean, passwordHash: string | null = null, appleSub: string | null = null) =>
    withStore(STORE_APPLE, async (tx) => {
      const r = await tx.execute(sql`INSERT INTO customer (store_id, email, email_verified, password_hash, apple_user_id) VALUES (${STORE_APPLE}, ${email}, ${verified}, ${passwordHash}, ${appleSub}) RETURNING id`);
      return (r.rows[0] as { id: string }).id;
    });
  const count = (email: string) => withStore(STORE_APPLE, async (tx) =>
    Number((await tx.execute(sql`SELECT count(*)::int AS n FROM customer WHERE email = ${email} AND store_id = ${STORE_APPLE}`)).rows[0]!.n));

  it('does NOT link or sign in a non-Apple-controlled address (fail closed, no session, no duplicate row)', async () => {
    await seed('victim@corp.example', true);
    const res = await signIn(SLUG_APPLE, appleJwt({ email: 'victim@corp.example' }));
    expect(res.status).toBe(409);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await appleRow(STORE_APPLE, 'sub-abc-123')).toBeUndefined();
    expect(await count('victim@corp.example')).toBe(1);
  });

  it('is not linkable via gmail either (Apple is not authoritative for Google mail)', async () => {
    await seed('someone@gmail.com', true);
    const res = await signIn(SLUG_APPLE, appleJwt({ email: 'someone@gmail.com' }));
    expect(res.status).toBe(409);
    expect(await appleRow(STORE_APPLE, 'sub-abc-123')).toBeUndefined();
  });

  it('links a Private Relay address that already belongs to an account', async () => {
    const custId = await seed('abc123@privaterelay.appleid.com', true);
    const res = await signIn(SLUG_APPLE, appleJwt({ email: 'abc123@privaterelay.appleid.com', is_private_email: 'true' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { customer: { id: string } }).customer.id).toBe(custId);
  });

  it('rejects a token with an unverified email (401), creating nothing', async () => {
    const res = await signIn(SLUG_APPLE, appleJwt({ email: 'new@icloud.com', email_verified: 'false' }));
    expect(res.status).toBe(401);
    expect(await count('new@icloud.com')).toBe(0);
  });

  it('refuses to link into an unverified password-holding account even on icloud.com', async () => {
    await seed('squat@icloud.com', false, 'hash');
    const res = await signIn(SLUG_APPLE, appleJwt({ email: 'squat@icloud.com' }));
    expect(res.status).toBe(409);
    expect(await appleRow(STORE_APPLE, 'sub-abc-123')).toBeUndefined();
  });

  it('refuses to rebind an account already linked to a different Apple subject', async () => {
    await seed('bound@icloud.com', true, null, 'other-sub');
    const res = await signIn(SLUG_APPLE, appleJwt({ email: 'bound@icloud.com' }));
    expect(res.status).toBe(409);
    expect((await appleRow(STORE_APPLE, 'other-sub'))?.email).toBe('bound@icloud.com');
  });

  it('smoke: concurrent first links with two different subs end with exactly one binding (not a deterministic guard test)', async () => {
    const custId = await seed('race@icloud.com', true);
    const [a, b] = await Promise.all([
      signIn(SLUG_APPLE, appleJwt({ sub: 'sub-race-a', email: 'race@icloud.com' })),
      signIn(SLUG_APPLE, appleJwt({ sub: 'sub-race-b', email: 'race@icloud.com' })),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? 'sub-race-a' : 'sub-race-b';
    const loser = a.status === 200 ? 'sub-race-b' : 'sub-race-a';
    expect((await appleRow(STORE_APPLE, winner))?.id).toBe(custId);
    expect(await appleRow(STORE_APPLE, loser)).toBeUndefined();
  });

  it('a link whose row was bound to another subject between the SELECT and the UPDATE 409s and does not rebind (deterministic)', async () => {
    const custId = await seed('race@icloud.com', true);
    // Connection C row-locks the customer and holds it. The sign-in's plain SELECT still reads the unbound row, then its
    // UPDATE blocks on C's lock. C then binds a DIFFERENT subject and commits; the blocked UPDATE re-evaluates its WHERE
    // against the new row version. Without the `apple_user_id IS NULL OR = sub` guard it would rebind to sub-race-a.
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const lockedP = new Promise<void>((r) => { locked = r; });
    const holder = withStore(STORE_APPLE, async (tx) => {
      await tx.execute(sql`SELECT id FROM customer WHERE id = ${custId} FOR UPDATE`);
      locked();
      await held;
      await tx.execute(sql`UPDATE customer SET apple_user_id = 'sub-race-b' WHERE id = ${custId}`);
    });
    await lockedP;
    const pending = signIn(SLUG_APPLE, appleJwt({ sub: 'sub-race-a', email: 'race@icloud.com' }));
    // Wait until the sign-in's UPDATE is actually waiting on C's lock (bounded poll, no fixed sleep). Always release C,
    // or a failed poll leaves the row locked and every later TRUNCATE in this file hangs.
    let waiting = false;
    try {
      for (let i = 0; i < 200 && !waiting; i++) {
        waiting = (await pool.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE 'UPDATE customer SET apple_user_id%'`,
        )).rowCount! > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 25));
      }
      expect(waiting, 'sign-in UPDATE should be blocked on the row lock').toBe(true);
    } finally {
      release();
      await holder.catch(() => {});
    }
    const res = await pending;
    expect(res.status).toBe(409);
    expect(await appleRow(STORE_APPLE, 'sub-race-a')).toBeUndefined();
    expect((await appleRow(STORE_APPLE, 'sub-race-b'))?.id).toBe(custId);
  });

  it('still signs in an already-linked Apple subject on any address', async () => {
    const custId = await seed('old@corp.example', true, null, 'sub-abc-123');
    const res = await signIn(SLUG_APPLE, appleJwt({ email: 'old@corp.example' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { customer: { id: string } }).customer.id).toBe(custId);
  });

  it('creates an account for a brand-new non-Apple email', async () => {
    const res = await signIn(SLUG_APPLE, appleJwt({ email: 'fresh@corp.example' }));
    expect(res.status).toBe(200);
    expect(await count('fresh@corp.example')).toBe(1);
  });

  it('links an existing customer by email (Apple-hosted), then matches by sub', async () => {
    const custId = await seed('link@icloud.com', true);
    const res = await signIn(SLUG_APPLE, appleJwt({ email: 'link@icloud.com' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { customer: { id: string } };
    expect(body.customer.id).toBe(custId);
    expect((await appleRow(STORE_APPLE, 'sub-abc-123'))?.id).toBe(custId);
  });

  it('falls back to an opaque placeholder email when Apple omits one', async () => {
    const res = await signIn(SLUG_APPLE, appleJwt({ sub: 'sub-noemail' }));
    expect(res.status).toBe(200);
    const row = await appleRow(STORE_APPLE, 'sub-noemail');
    expect(row?.email).toBe('apple-sub-noemail@no-email.invalid');
  });
});
