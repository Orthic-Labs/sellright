/**
 * DB integration tests for POST /v1/shop/auth/google account linking. Google's
 * tokeninfo endpoint is mocked; the handler runs for real.
 *
 * Covers: gmail links by email; Workspace with matching hd links; a
 * non-authoritative identity (non-Google-hosted address, no/mismatched hd) gets
 * the SAME 202 + verification email whether or not the address has an account
 * (no enumeration), and only the emailed link links/creates; an already linked
 * Google subject still signs in; a brand-new gmail address creates an account.
 * The emailed link is bound to the starting browser (nonce cookie), single use,
 * and never re-binds an account that already holds a different Google subject.
 *
 * Runs against sellright_test ONLY (these wipe data).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { auth } from './auth.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`auth.google test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'aaaaaaaa-3333-3333-3333-333333333333';
const SLUG = 'auth-google-test-store';
const CLIENT = 'test-google-client';

const app = new OpenAPIHono();
app.route('/', auth);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
}

beforeEach(async () => {
  await wipe();
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', ${JSON.stringify({ googleClientId: CLIENT })}::jsonb)`);
  });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { await wipe(); await pool.end(); });

function mockGoogle(payload: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ aud: CLIENT, email_verified: 'true', ...payload }), { status: 200 })));
}
const signIn = (extra: Record<string, string> = {}) => app.request('/v1/shop/auth/google', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-store-slug': SLUG, ...extra },
  body: JSON.stringify({ credential: 'c'.repeat(40) }),
});
async function seedCustomer(email: string, googleSub: string | null = null) {
  await withStore(STORE, async (tx) => {
    await tx.insert(s.customer).values({ storeId: STORE, email, emailVerified: true, googleSub });
  });
}
const byEmail = (email: string) => withStore(STORE, async (tx) => (await tx.select().from(s.customer).where(eq(s.customer.email, email)).limit(1))[0] ?? null);
const sessionCount = async () => (await pool.query('SELECT count(*)::int AS n FROM "session"')).rows[0].n as number;

describe('POST /v1/shop/auth/google linking', () => {
  it('links an existing account by email for a gmail address', async () => {
    await seedCustomer('owner@gmail.com');
    mockGoogle({ sub: 'g-1', email: 'owner@gmail.com' });
    const res = await signIn();
    expect(res.status).toBe(200);
    expect((await byEmail('owner@gmail.com'))?.googleSub).toBe('g-1');
  });

  it('links a Workspace address whose hd matches the email domain', async () => {
    await seedCustomer('staff@corp.example');
    mockGoogle({ sub: 'g-2', email: 'staff@corp.example', hd: 'corp.example' });
    const res = await signIn();
    expect(res.status).toBe(200);
    expect((await byEmail('staff@corp.example'))?.googleSub).toBe('g-2');
  });

  it('still signs in an already-linked Google subject on any address', async () => {
    await seedCustomer('owner@corp.example', 'g-5');
    mockGoogle({ sub: 'g-5', email: 'owner@corp.example' });
    const res = await signIn();
    expect(res.status).toBe(200);
    expect(await sessionCount()).toBe(1);
  });

  it('never re-binds an account that already holds a different Google subject (authoritative path)', async () => {
    await seedCustomer('owner@gmail.com', 'g-old');
    mockGoogle({ sub: 'g-new', email: 'owner@gmail.com' });
    const res = await signIn();
    expect(res.status).toBe(409);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await byEmail('owner@gmail.com'))?.googleSub).toBe('g-old');
    expect(await sessionCount()).toBe(0);
  });

  it('creates an account for a brand-new gmail address', async () => {
    mockGoogle({ sub: 'g-6', email: 'fresh@gmail.com', given_name: 'Fresh' });
    const res = await signIn();
    expect(res.status).toBe(200);
    expect(await byEmail('fresh@gmail.com')).toMatchObject({ googleSub: 'g-6', emailVerified: true });
  });
});

const outbox = async () => withStore(STORE, async (tx) => (await tx.execute(sql`SELECT kind, recipient, payload FROM email_outbox ORDER BY created_at`)).rows as Array<{ kind: string; recipient: string; payload: { text: string; html: string; subject: string } }>);
// customer is FORCE RLS: an unscoped owner-pool count returns 0 wherever the owner is subject to RLS (non-superuser),
// which makes positive assertions fail and negative ones pass vacuously. Count per store, inside the store context.
const OTHER = 'bbbbbbbb-3333-3333-3333-333333333333';
const customerCount = async () => {
  let n = 0;
  for (const id of [STORE, OTHER]) {
    n += await withStore(id, async (tx) => Number((await tx.execute(sql`SELECT count(*)::int AS n FROM customer WHERE store_id = ${id}`)).rows[0]!.n));
  }
  return n;
};
const linkTokenFrom = (row: { payload: { text: string } }) => /sign-in\/confirm\?token=([^\s")<]+)/.exec(row.payload.text)![1]!;
const NONCE_COOKIE = 'sr_fed_link';
/** `sr_fed_link=<nonce>` from a 202's Set-Cookie, ready to send back as a Cookie header. */
const nonceCookieOf = (res: Response) => new RegExp(`${NONCE_COOKIE}=[^;]+`).exec(res.headers.get('set-cookie') ?? '')?.[0];
const confirm = (token: string, opts: { cookie?: string; slug?: string; nonce?: string; query?: string } = {}) => app.request(`/v1/shop/auth/federated/confirm${opts.query ?? ''}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-store-slug': opts.slug ?? SLUG, ...(opts.cookie ? { cookie: opts.cookie } : {}) },
  body: JSON.stringify(opts.nonce === undefined ? { token } : { token, nonce: opts.nonce }),
});
/** Start a non-authoritative flow for `email`; returns the cookie and the mailed token. */
async function startFlow(email: string, sub: string, extra: Record<string, unknown> = {}) {
  mockGoogle({ sub, email, ...extra });
  const res = await signIn();
  expect(res.status).toBe(202);
  const rows = await outbox();
  const nonce = ((await res.clone().json()) as { nonce: string }).nonce;
  return { res, cookie: nonceCookieOf(res)!, nonce, token: linkTokenFrom(rows[rows.length - 1]!) };
}

describe('POST /v1/shop/auth/google non-authoritative identity', () => {
  // [description, google payload overrides]
  const cases: Array<[string, Record<string, unknown>]> = [
    ['non-Google-hosted address without hd', { sub: 'g-3' }],
    ['hd naming a different domain', { sub: 'g-4', hd: 'other.example' }],
  ];

  for (const [name, over] of cases) {
    it(`answers identically for an existing and an unknown address (${name})`, async () => {
      await seedCustomer('known@corp.example');
      mockGoogle({ ...over, email: 'known@corp.example' });
      const existing = await signIn();
      const existingBody = await existing.text();
      mockGoogle({ ...over, email: 'nobody@corp.example' });
      const unknown = await signIn();
      const unknownBody = await unknown.text();

      expect(existing.status).toBe(202);
      expect(unknown.status).toBe(existing.status);
      const shape = (b: string) => Object.entries(JSON.parse(b) as Record<string, unknown>).map(([k, v]) => [k, typeof v]).sort();
      expect(shape(existingBody)).toEqual(shape(unknownBody));
      expect(shape(existingBody)).toEqual([['nonce', 'string'], ['verificationRequired', 'boolean']]);
      expect((JSON.parse(existingBody) as { nonce: string }).nonce).not.toBe((JSON.parse(unknownBody) as { nonce: string }).nonce);
      expect(JSON.parse(existingBody)).toMatchObject({ verificationRequired: true });
      expect(existing.headers.get('content-type')).toBe(unknown.headers.get('content-type'));
      // Only the nonce cookie, with identical attributes; never a session cookie.
      const attrs = (r: Response) => (r.headers.get('set-cookie') ?? '').replace(/sr_fed_link=[^;]+/, 'sr_fed_link=<n>');
      expect(attrs(existing)).toBe(attrs(unknown));
      expect(attrs(existing)).not.toMatch(/sr_cust/);
    });
  }

  it('sets the nonce cookie HttpOnly, Secure (over https), SameSite=Lax, scoped to the link lifetime', async () => {
    mockGoogle({ sub: 'g-c1', email: 'nobody-c1@corp.example' });
    const res = await signIn({ 'x-forwarded-proto': 'https' });
    const sc = res.headers.get('set-cookie') ?? '';
    expect(sc).toMatch(/^sr_fed_link=[A-Za-z0-9_-]{40,};/);
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/Secure/);
    expect(sc).toMatch(/SameSite=Lax/);
    expect(sc).toMatch(/Max-Age=1800/);
  });

  it('sends one dedicated confirmation email, with no account-state difference, and touches no account or session', async () => {
    await seedCustomer('known-f@corp.example');
    await startFlow('known-f@corp.example', 'g-7');
    await startFlow('nobody-f@corp.example', 'g-8');

    const rows = await outbox();
    expect(rows.map((r) => [r.kind, r.recipient])).toEqual([['federated_link_confirm', 'known-f@corp.example'], ['federated_link_confirm', 'nobody-f@corp.example']]);
    const norm = (r: (typeof rows)[number]) => r.payload.text.replace(/token=[^\s")<]+/, 'token=<t>').replaceAll(r.recipient, '<addr>');
    expect(norm(rows[0]!)).toBe(norm(rows[1]!));
    expect(rows[0]!.payload.subject).toMatch(/Google/);
    expect(rows[0]!.payload.text).toContain('known-f@corp.example'); // names the Google account email
    expect(rows[0]!.payload.text).toMatch(/Google/);
    expect(rows[0]!.payload.text).toMatch(/didn't try to sign in with Google, ignore this email/);
    expect(rows[0]!.payload.text).toMatch(/Open this link in the same browser where you started signing in\. If you're reading this on a different device, open this email in the browser where you started\. Starting again sends a new link and replaces this one\./);
    expect(await customerCount()).toBe(1); // the seeded one only: nothing created for the unknown address
    expect((await byEmail('known-f@corp.example'))?.googleSub).toBeNull();
    expect(await sessionCount()).toBe(0);
  });

  it('rate-limits repeated requests identically for an existing and an unknown address', async () => {
    await seedCustomer('rl-known@corp.example');
    const statuses = async (email: string, sub: string) => {
      mockGoogle({ sub, email });
      const out: number[] = [];
      for (let i = 0; i < 12; i++) out.push((await signIn()).status);
      return out;
    };
    expect(await statuses('rl-known@corp.example', 'g-9')).toEqual(await statuses('rl-nobody@corp.example', 'g-10'));
  });

  it('caps requests per address even when every request comes from a different IP', async () => {
    const run = async (email: string, sub: string) => {
      mockGoogle({ sub, email });
      const out: number[] = [];
      for (let i = 0; i < 12; i++) out.push((await signIn({ 'x-real-ip': `203.0.113.${i + 1}` })).status);
      return out;
    };
    await seedCustomer('cap-known@corp.example');
    const known = await run('cap-known@corp.example', 'g-cap1');
    const unknown = await run('cap-nobody@corp.example', 'g-cap2');
    expect(known).toEqual(unknown);
    expect(known).toContain(429);
    expect(known.indexOf(429)).toBeGreaterThan(0);
  });

  it('the emailed link, opened in the starting browser, links the existing account and signs in', async () => {
    await seedCustomer('known-a@corp.example');
    const { cookie, token } = await startFlow('known-a@corp.example', 'g-11');
    const res = await confirm(token, { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/sr_cust=/);
    expect(res.headers.get('set-cookie')).toMatch(/sr_fed_link=;[^,]*Max-Age=0/); // nonce cookie cleared
    expect((await byEmail('known-a@corp.example'))?.googleSub).toBe('g-11');
    expect(await sessionCount()).toBe(1);
  });

  it('the emailed link creates an account for an unknown address', async () => {
    const { cookie, token } = await startFlow('nobody-b@corp.example', 'g-12', { given_name: 'No' });
    const res = await confirm(token, { cookie });
    expect(res.status).toBe(200);
    expect(await byEmail('nobody-b@corp.example')).toMatchObject({ googleSub: 'g-12', emailVerified: true, firstName: 'No' });
  });

  it('a link opened in a different browser (no cookie, or another browser\'s cookie) fails and changes nothing', async () => {
    await seedCustomer('known-x@corp.example');
    const victim = await startFlow('known-x@corp.example', 'g-x1');
    // attacker holds a Google identity for the same address and a cookie from their own flow
    mockGoogle({ sub: 'g-x2', email: 'known-x@corp.example' });
    const attackerCookie = nonceCookieOf(await signIn())!;

    for (const cookie of [undefined, attackerCookie, `${NONCE_COOKIE}=`, `${NONCE_COOKIE}=garbage`]) {
      expect((await confirm(victim.token, { cookie })).status).toBe(401);
    }
    expect((await byEmail('known-x@corp.example'))?.googleSub).toBeNull();
    expect(await sessionCount()).toBe(0);
    // the failed attempts did not spend the link: the real browser can still redeem it
    expect((await confirm(victim.token, { cookie: victim.cookie })).status).toBe(200);
    expect((await byEmail('known-x@corp.example'))?.googleSub).toBe('g-x1');
  });

  it('a confirm with the token but no or another nonce fails for cookie and bearer clients alike', async () => {
    const { cookie, token } = await startFlow('nobody-n@corp.example', 'g-n1');
    const other = `${NONCE_COOKIE}=${'A'.repeat(43)}`;
    const post = (headers: Record<string, string>) => app.request('/v1/shop/auth/federated/confirm', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-store-slug': SLUG, ...headers }, body: JSON.stringify({ token }),
    });
    for (const h of [{} as Record<string, string>, { cookie: other }, { authorization: 'Bearer some-native-token' }, { authorization: 'Bearer some-native-token', cookie: other }]) {
      expect((await post(h)).status).toBe(401);
    }
    expect(await customerCount()).toBe(0);
    expect((await post({ cookie })).status).toBe(200); // the right nonce still works: nothing was spent
  });

  it('native path: token + the nonce from the 202 body redeem without any cookie, once', async () => {
    const { token, nonce, cookie } = await startFlow('nobody-nat@corp.example', 'g-nat1');
    expect(cookie).toContain(nonce); // body nonce is the same secret the cookie carries
    const res = await confirm(token, { nonce });
    expect(res.status).toBe(200);
    expect(await byEmail('nobody-nat@corp.example')).toMatchObject({ googleSub: 'g-nat1' });
    expect((await confirm(token, { nonce })).status).toBe(401); // replay
    expect(await sessionCount()).toBe(1);
  });

  it('wrong or missing body nonce fails; a nonce in the query string is ignored', async () => {
    const { token, nonce } = await startFlow('nobody-bn@corp.example', 'g-bn1');
    for (const bad of [{ nonce: 'A'.repeat(43) }, { nonce: 'short-but-long-enough-nonce-x' }, {}]) {
      expect((await confirm(token, bad)).status).toBe(401);
    }
    expect((await confirm(token, { query: `?nonce=${nonce}` })).status).toBe(401);
    expect(await customerCount()).toBe(0);
    expect((await confirm(token, { nonce })).status).toBe(200); // unspent by the failures
  });

  it('a link cannot be redeemed twice (replay fails, no second session)', async () => {
    const { cookie, token } = await startFlow('nobody-r@corp.example', 'g-r1');
    expect((await confirm(token, { cookie })).status).toBe(200);
    const again = await confirm(token, { cookie });
    expect(again.status).toBe(401);
    expect(again.headers.get('set-cookie') ?? '').not.toMatch(/sr_cust=[^;]/);
    expect(await sessionCount()).toBe(1);
    expect(await customerCount()).toBe(1);
  });

  it('refuses to re-bind an account that already holds a different Google subject, even with a valid link', async () => {
    await seedCustomer('known-rb@corp.example', 'g-old');
    const { cookie, token } = await startFlow('known-rb@corp.example', 'g-new');
    const res = await confirm(token, { cookie });
    expect(res.status).toBe(409);
    expect(res.headers.get('set-cookie') ?? '').not.toMatch(/sr_cust=[^;]/);
    expect((await byEmail('known-rb@corp.example'))?.googleSub).toBe('g-old');
    expect(await sessionCount()).toBe(0);
  });

  it('still refuses to link an unverified password account even with a valid link', async () => {
    await withStore(STORE, async (tx) => { await tx.insert(s.customer).values({ storeId: STORE, email: 'known-c@corp.example', emailVerified: false, passwordHash: 'x' }); });
    const { cookie, token } = await startFlow('known-c@corp.example', 'g-13');
    const res = await confirm(token, { cookie });
    expect(res.status).toBe(409);
    expect((await byEmail('known-c@corp.example'))?.googleSub).toBeNull();
  });

  it('rejects a forged, tampered, malformed or other-store link', async () => {
    const { cookie, token } = await startFlow('nobody-d@corp.example', 'g-14');
    const [body, sig] = token.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ v: 1, p: 'google', st: STORE, sub: 'attacker', em: 'known@corp.example', nh: 'x', jti: 'j', exp: Date.now() + 60_000 })).toString('base64url');
    for (const bad of [`${forgedBody}.${sig}`, `${body}.${'A'.repeat(sig!.length)}`, `${body}`, 'x'.repeat(40), `${token}.extra`]) {
      expect((await confirm(bad, { cookie })).status).toBe(401);
    }
    await withStore(OTHER, async (tx) => { await tx.execute(sql`INSERT INTO store (id, slug, name, currency) VALUES (${OTHER}, 'other-google-store', 'o', 'USD')`); });
    expect((await confirm(token, { cookie, slug: 'other-google-store' })).status).toBe(401);
    expect(await customerCount()).toBe(0);
  });

  it('rejects an expired link', async () => {
    const { signFederatedLink, hashLinkNonce } = await import('../auth/federated-link.js');
    const old = signFederatedLink({ provider: 'google', storeId: STORE, subject: 'g-15', email: 'nobody-e@corp.example', firstName: null, lastName: null }, hashLinkNonce('n1'), Date.now() - 31 * 60 * 1000);
    expect((await confirm(old, { cookie: `${NONCE_COOKIE}=n1` })).status).toBe(401);
    expect(await customerCount()).toBe(0);
  });

});
