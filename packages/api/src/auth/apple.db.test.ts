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
    const res = await signIn(SLUG_APPLE, appleJwt({ email: 'ap@icloud.com' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string; customer: { id: string; email: string; emailVerified: boolean; isMigrated: boolean } };
    expect(body.customer.email).toBe('ap@icloud.com');
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

  it('does NOT link or sign in a non-Apple-controlled address: 202 + mailed link, no session, no duplicate row', async () => {
    await seed('victim@corp.example', true);
    const res = await signIn(SLUG_APPLE, appleJwt({ email: 'victim@corp.example' }));
    expect(res.status).toBe(202);
    expect(res.headers.get('set-cookie')).not.toMatch(/sr_cust/);
    expect(await appleRow(STORE_APPLE, 'sub-abc-123')).toBeUndefined();
    expect(await count('victim@corp.example')).toBe(1);
  });

  it('is not linkable via gmail either (Apple is not authoritative for Google mail)', async () => {
    await seed('someone@gmail.com', true);
    const res = await signIn(SLUG_APPLE, appleJwt({ email: 'someone@gmail.com' }));
    expect(res.status).toBe(202);
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

  it('a brand-new non-Apple email is NOT created on sign-in (202); only the emailed link creates it', async () => {
    const res = await signIn(SLUG_APPLE, appleJwt({ email: 'fresh@corp.example' }));
    expect(res.status).toBe(202);
    expect(await count('fresh@corp.example')).toBe(0);
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

// --- Non-authoritative Apple identities: uniform 202 + browser-bound, single-use confirmation link ----------------
const outbox = () => withStore(STORE_APPLE, async (tx) =>
  (await tx.execute(sql`SELECT kind, recipient, payload FROM email_outbox ORDER BY created_at`)).rows as Array<{ kind: string; recipient: string; payload: { text: string; subject: string } }>);
const NONCE_COOKIE = 'sr_fed_link';
const nonceCookieOf = (res: Response) => new RegExp(`${NONCE_COOKIE}=[^;]+`).exec(res.headers.get('set-cookie') ?? '')?.[0];
const tokenFrom = (row: { payload: { text: string } }) => /sign-in\/confirm\?token=([^\s")<]+)/.exec(row.payload.text)![1]!;
const confirm = (token: string, headers: Record<string, string> = {}, opts: { nonce?: string; query?: string } = {}) =>
  app.request(`/v1/shop/auth/federated/confirm${opts.query ?? ''}`, { method: 'POST', headers: { ...hdr(SLUG_APPLE), ...headers }, body: JSON.stringify(opts.nonce === undefined ? { token } : { token, nonce: opts.nonce }) });
async function startFlow(email: string, sub: string) {
  const res = await signIn(SLUG_APPLE, appleJwt({ sub, email }));
  expect(res.status).toBe(202);
  const rows = await outbox();
  const nonce = ((await res.clone().json()) as { nonce: string }).nonce;
  return { res, cookie: nonceCookieOf(res)!, nonce, token: tokenFrom(rows[rows.length - 1]!) };
}
const seedC = (email: string, appleSub: string | null = null, verified = true, passwordHash: string | null = null) =>
  withStore(STORE_APPLE, async (tx) => {
    const r = await tx.execute(sql`INSERT INTO customer (store_id, email, email_verified, password_hash, apple_user_id) VALUES (${STORE_APPLE}, ${email}, ${verified}, ${passwordHash}, ${appleSub}) RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
// customer is FORCE RLS: count per store inside the store context (an unscoped owner-pool count is 0 under RLS,
// failing positive assertions and passing negative ones vacuously). Both stores, so cross-store creation is still caught.
const customers = async () => {
  let n = 0;
  for (const id of [STORE_APPLE, STORE_NONE]) {
    n += await withStore(id, async (tx) => Number((await tx.execute(sql`SELECT count(*)::int AS n FROM customer WHERE store_id = ${id}`)).rows[0]!.n));
  }
  return n;
};
const sessions = async () => Number((await pool.query('SELECT count(*)::int AS n FROM "session"')).rows[0].n);

describe('POST /v1/shop/auth/apple non-authoritative identity', () => {
  it('answers identically for an existing and an unknown address, including cookie attributes', async () => {
    await seedC('known-i@corp.example');
    const a = await signIn(SLUG_APPLE, appleJwt({ sub: 'ap-i1', email: 'known-i@corp.example' }));
    const aBody = await a.text();
    const b = await signIn(SLUG_APPLE, appleJwt({ sub: 'ap-i2', email: 'nobody-i@corp.example' }));
    const bBody = await b.text();
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    const shape = (b: string) => Object.entries(JSON.parse(b) as Record<string, unknown>).map(([k, v]) => [k, typeof v]).sort();
    expect(shape(aBody)).toEqual(shape(bBody));
    expect(shape(aBody)).toEqual([['nonce', 'string'], ['verificationRequired', 'boolean']]);
    expect((JSON.parse(aBody) as { nonce: string }).nonce).not.toBe((JSON.parse(bBody) as { nonce: string }).nonce);
    expect(JSON.parse(aBody)).toMatchObject({ verificationRequired: true });
    const attrs = (r: Response) => (r.headers.get('set-cookie') ?? '').replace(/sr_fed_link=[^;]+/, 'sr_fed_link=<n>');
    expect(attrs(a)).toBe(attrs(b));
    expect(attrs(a)).toMatch(/HttpOnly/);
    expect(attrs(a)).toMatch(/SameSite=Lax/);
    expect(attrs(a)).not.toMatch(/sr_cust/);
  });

  it('sends one Apple-named email with identical content for both cases and creates nothing', async () => {
    await seedC('known-m@corp.example');
    await startFlow('known-m@corp.example', 'ap-m1');
    await startFlow('nobody-m@corp.example', 'ap-m2');
    const rows = await outbox();
    expect(rows.map((r) => [r.kind, r.recipient])).toEqual([['federated_link_confirm', 'known-m@corp.example'], ['federated_link_confirm', 'nobody-m@corp.example']]);
    const norm = (r: (typeof rows)[number]) => r.payload.text.replace(/token=[^\s")<]+/, 'token=<t>').replaceAll(r.recipient, '<addr>');
    expect(norm(rows[0]!)).toBe(norm(rows[1]!));
    expect(rows[0]!.payload.subject).toMatch(/Apple/);
    expect(rows[0]!.payload.text).toMatch(/Apple account/);
    expect(rows[0]!.payload.text).toMatch(/same browser where you started signing in\. If you're reading this on a different device, open this email in the browser where you started\./);
    expect(await customers()).toBe(1);
    expect(await sessions()).toBe(0);
  });

  it('rate-limits identically for existing and unknown addresses', async () => {
    await seedC('rl-known@corp.example');
    const run = async (email: string, sub: string) => {
      const out: number[] = [];
      for (let i = 0; i < 12; i++) out.push((await signIn(SLUG_APPLE, appleJwt({ sub, email }))).status);
      return out;
    };
    const known = await run('rl-known@corp.example', 'ap-rl1');
    const unknown = await run('rl-nobody@corp.example', 'ap-rl2');
    expect(known).toEqual(unknown);
    expect(known).toContain(429);
  });

  it('the link links the existing account (browser-bound) and signs in', async () => {
    const id = await seedC('known-a@corp.example');
    const { cookie, token } = await startFlow('known-a@corp.example', 'ap-a1');
    const res = await confirm(token, { cookie });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { customer: { id: string } }).customer.id).toBe(id);
    expect((await appleRow(STORE_APPLE, 'ap-a1'))?.id).toBe(id);
    expect(res.headers.get('set-cookie')).toMatch(/sr_fed_link=;[^,]*Max-Age=0/);
  });

  it('the link creates a verified account for an unknown address', async () => {
    const { cookie, token } = await startFlow('nobody-b@corp.example', 'ap-b1');
    const res = await confirm(token, { cookie });
    expect(res.status).toBe(200);
    expect(await appleRow(STORE_APPLE, 'ap-b1')).toMatchObject({ email: 'nobody-b@corp.example', email_verified: true });
  });

  it('a confirm in another browser, or with no/other nonce, fails for cookie and bearer clients and spends nothing', async () => {
    await seedC('known-x@corp.example');
    const victim = await startFlow('known-x@corp.example', 'ap-x1');
    const attacker = nonceCookieOf(await signIn(SLUG_APPLE, appleJwt({ sub: 'ap-x2', email: 'known-x@corp.example' })))!;
    for (const h of [{} as Record<string, string>, { cookie: attacker }, { cookie: `${NONCE_COOKIE}=` }, { authorization: 'Bearer native-token' }, { authorization: 'Bearer native-token', cookie: attacker }]) {
      expect((await confirm(victim.token, h)).status).toBe(401);
    }
    expect(await appleRow(STORE_APPLE, 'ap-x1')).toBeUndefined();
    expect(await sessions()).toBe(0);
    expect((await confirm(victim.token, { cookie: victim.cookie })).status).toBe(200); // still unspent
  });

  it('native path: token + the nonce from the 202 body redeem without a cookie (also with a bearer header), once', async () => {
    const { token, nonce, cookie } = await startFlow('nobody-nat@corp.example', 'ap-nat1');
    expect(cookie).toContain(nonce);
    const res = await confirm(token, { authorization: 'Bearer native-token' }, { nonce });
    expect(res.status).toBe(200);
    expect(await appleRow(STORE_APPLE, 'ap-nat1')).toMatchObject({ email: 'nobody-nat@corp.example' });
    expect((await confirm(token, {}, { nonce })).status).toBe(401); // replay
    expect(await sessions()).toBe(1);
  });

  it('wrong or missing body nonce fails; a nonce in the query string is ignored', async () => {
    const { token, nonce } = await startFlow('nobody-bn@corp.example', 'ap-bn1');
    for (const bad of [{ nonce: 'A'.repeat(43) }, { nonce: 'short-but-long-enough-nonce-x' }, {}]) {
      expect((await confirm(token, {}, bad)).status).toBe(401);
    }
    expect((await confirm(token, {}, { query: `?nonce=${nonce}` })).status).toBe(401);
    expect(await customers()).toBe(0);
    expect((await confirm(token, {}, { nonce })).status).toBe(200);
  });

  it('a link cannot be redeemed twice', async () => {
    const { cookie, token } = await startFlow('nobody-r@corp.example', 'ap-r1');
    expect((await confirm(token, { cookie })).status).toBe(200);
    const again = await confirm(token, { cookie });
    expect(again.status).toBe(401);
    expect(await sessions()).toBe(1);
    expect(await customers()).toBe(1);
  });

  it('refuses to re-bind an account already bound to a different Apple subject, even with a valid link', async () => {
    await seedC('known-rb@corp.example', 'ap-old');
    const { cookie, token } = await startFlow('known-rb@corp.example', 'ap-new');
    const res = await confirm(token, { cookie });
    expect(res.status).toBe(409);
    expect(res.headers.get('set-cookie') ?? '').not.toMatch(/sr_cust=[^;]/);
    expect((await appleRow(STORE_APPLE, 'ap-old'))?.email).toBe('known-rb@corp.example');
    expect(await appleRow(STORE_APPLE, 'ap-new')).toBeUndefined();
  });

  it('still refuses an unverified password account at confirm', async () => {
    await seedC('known-pw@corp.example', null, false, 'hash');
    const { cookie, token } = await startFlow('known-pw@corp.example', 'ap-pw1');
    expect((await confirm(token, { cookie })).status).toBe(409);
    expect(await appleRow(STORE_APPLE, 'ap-pw1')).toBeUndefined();
  });

  it('a returning, already-bound Apple subject on a non-authoritative address still signs in directly (no mail)', async () => {
    await seedC('bound@corp.example', 'ap-bound');
    const res = await signIn(SLUG_APPLE, appleJwt({ sub: 'ap-bound', email: 'bound@corp.example' }));
    expect(res.status).toBe(200);
    expect(await outbox()).toEqual([]);
  });

  it('an identity with no email (Private Relay repeat) still takes the direct path', async () => {
    const res = await signIn(SLUG_APPLE, appleJwt({ sub: 'ap-noemail' }));
    expect(res.status).toBe(200);
    expect(await outbox()).toEqual([]);
  });

  it('a tampered or other-store link is rejected', async () => {
    const { cookie, token } = await startFlow('nobody-t@corp.example', 'ap-t1');
    const [body, sig] = token.split('.');
    expect((await confirm(`${body}.${'A'.repeat(sig!.length)}`, { cookie })).status).toBe(401);
    expect((await app.request('/v1/shop/auth/federated/confirm', { method: 'POST', headers: { ...hdr(SLUG_NONE), cookie }, body: JSON.stringify({ token }) })).status).toBe(401);
    expect(await customers()).toBe(0);
  });
});
