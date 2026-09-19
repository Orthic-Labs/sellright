import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import { resolveStoreFromCtx } from './store-context.js';
import { type StoreCtx } from '../store-context.js';
import * as s from '../db/schema.js';
import { hashPassword, passwordNeedsRehash, verifyPassword } from '../auth/password.js';
import { customerToken, createSession, deleteSession, resolveCustomer, sessionPolicy } from '../auth/session.js';
import { consumeMagicLink, magicLinkPolicy, mintMagicLink } from '../auth/magic-link.js';
import { appleClientIds, verifyAppleIdentityToken } from '../auth/apple.js';
import { setCustomerCookies, clearCustomerCookies, customerCsrfValid, newCsrf } from '../auth/cookies.js';
import { clientIp, loginRetryAfter, recordLoginFailure, clearLoginAttempts } from '../auth/rate-limit.js';
import { normalizeEmail } from '../auth/email.js';
import { createHash, randomBytes } from 'node:crypto';
import { enqueueEmailVerify, enqueueMagicLink, resolveStorefrontUrl } from '../email/dispatch.js';
import { verifyTurnstileToken } from '../security/turnstile.js';
import { env } from '../env.js';

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
const EMAIL_VERIFY_TTL_HOURS = 48;
// SR-05: sender + storefront link resolve per store (store.config), with
// per-app env overrides still first when an appKey applies.
const emailStoreCtx = (st: StoreCtx) => ({ name: st.name, currency: st.currency, config: st.config });
// Customer cookie Max-Age tracks the store's session TTL so the cookie never
// dies before the session it carries (cookie and DB expiry stay consistent).
const customerCookieSeconds = (st: StoreCtx) => Math.ceil(sessionPolicy(st.config).ttlMs / 1000);

// PAR-06: per-store anti-bot. Secret lives in store.config
// (turnstileSecretKey, or turnstile.secretKey nested); absent → feature off.
function turnstileSecret(config: unknown): string | null {
  const c = (config && typeof config === 'object' ? config : {}) as Record<string, unknown>;
  const nested = (c.turnstile as Record<string, unknown> | undefined)?.secretKey;
  const flat = c.turnstileSecretKey ?? c.turnstile_secret_key ?? c.turnstileSecret;
  const v = (typeof nested === 'string' && nested.trim() ? nested : flat) ??
    env.TURNSTILE_SECRET_KEY ?? process.env.TURNSTILE_SECRET_KEY;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

async function turnstileOk(config: unknown, token: string | undefined, remoteIp: string): Promise<boolean> {
  const secret = turnstileSecret(config);
  if (!secret) return true;
  return verifyTurnstileToken({ secret, token: token ?? null, remoteIp }); // fail closed on failure
}

/** The store's Google OAuth client id (store config or env GOOGLE_CLIENT_ID).
 *  Reads the store row through withStore so it is RLS-scoped to the resolved store. */
async function googleClientId(storeId: string): Promise<string | null> {
  const config = await withStore(storeId, async (tx) => {
    const [row] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, storeId)).limit(1);
    return row?.config ?? null;
  });
  return (config as { googleClientId?: string } | null)?.googleClientId ?? env.GOOGLE_CLIENT_ID ?? null;
}

/** Verify a Google Identity Services ID token via Google's tokeninfo endpoint —
 *  validates signature + expiry server-side; we additionally check `aud`. */
async function verifyGoogleIdToken(credential: string, clientId: string): Promise<{ sub: string; email: string; emailVerified: boolean; firstName: string | null; lastName: string | null } | null> {
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
  if (!res.ok) return null;
  const p = (await res.json()) as { aud?: string; sub?: string; email?: string; email_verified?: string | boolean; given_name?: string; family_name?: string };
  if (!p.sub || !p.email || p.aud !== clientId) return null;
  const emailVerified = p.email_verified === true || p.email_verified === 'true';
  return { sub: p.sub, email: normalizeEmail(p.email), emailVerified, firstName: p.given_name ?? null, lastName: p.family_name ?? null };
}

// isMigrated is true for a credential-less account imported from another
// system. The storefront reads it to render the "set your password" banner.
// The shape is intentionally identical across register / login / google / me.
const CustomerOut = z.object({ id: z.string(), email: z.string(), firstName: z.string().nullable(), lastName: z.string().nullable(), phone: z.string().nullable(), emailVerified: z.boolean(), isMigrated: z.boolean() });

export const auth = new OpenAPIHono();

// POST /v1/shop/auth/register
auth.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/auth/register',
    summary: 'Register a customer account',
    request: { body: { content: { 'application/json': { schema: z.object({ email: z.string().email(), password: z.string().min(8), firstName: z.string().optional(), lastName: z.string().optional(), turnstileToken: z.string().optional() }) } } } },
    responses: {
      200: { description: 'Registered', content: { 'application/json': { schema: z.object({ token: z.string(), customer: CustomerOut }) } } },
      403: { description: 'Bot check failed', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      409: { description: 'Email taken', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      429: { description: 'Rate limited', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { email: rawEmail, password, firstName, lastName, turnstileToken } = c.req.valid('json');
    const email = normalizeEmail(rawEmail);
    // Rate-limit: register is a credential-stuffing / spam vector. Per-IP+email
    // bucket (NOT per-account — an attacker could lock a real customer out).
    const regIp = clientIp(c);
    const regBucket = `register:${regIp}:${email}`;
    const regRetry = loginRetryAfter(regIp, regBucket);
    if (regRetry > 0) return c.json({ error: `too many attempts — try again in ${regRetry}s` }, 429);
    // PAR-06: server-side Turnstile when the store config carries a secret.
    if (!(await turnstileOk(st.config, turnstileToken, regIp))) {
      recordLoginFailure(regIp, regBucket);
      return c.json({ error: 'verification failed' }, 403);
    }
    const passwordHash = await hashPassword(password);
    const out = await withStore(st.id, async (tx): Promise<{ taken: true } | { token: string; id: string; firstName: string | null; lastName: string | null }> => {
      const existing = await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.email, email)).limit(1);
      if (existing.length) return { taken: true };
      const [cust] = await tx.insert(s.customer).values({ storeId: st.id, email, firstName: firstName ?? null, lastName: lastName ?? null, passwordHash, emailVerified: false }).returning({ id: s.customer.id, firstName: s.customer.firstName, lastName: s.customer.lastName });
      const token = await createSession(tx, st.id, cust!.id, sessionPolicy(st.config));
      // WP2d: mint an email_verify token in the same txn. Proving address
      // ownership is what releases email_match-linked guest orders (WP9.5).
      const verifyRaw = randomBytes(32).toString('base64url');
      await tx.insert(s.customerToken).values({ storeId: st.id, customerId: cust!.id, kind: 'email_verify', tokenHash: hashToken(verifyRaw), expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_HOURS * 3600 * 1000) });
      // SR-12: enqueue the verification email in the SAME txn — a rolled-back
      // registration can't mail a dead token, and the outbox retries delivery
      // instead of dropping it on a transient SMTP failure (was inline send).
      const verifyUrl = `${resolveStorefrontUrl(emailStoreCtx(st))}/verify-email?token=${verifyRaw}`;
      await enqueueEmailVerify(tx, st.id, emailStoreCtx(st), email, { url: verifyUrl });
      return { token, id: cust!.id, firstName: cust!.firstName, lastName: cust!.lastName };
    });
    if ('taken' in out) { recordLoginFailure(regIp, regBucket); return c.json({ error: 'email already registered' }, 409); }
    clearLoginAttempts(regIp, regBucket);
    setCustomerCookies(c, out.token, newCsrf(), customerCookieSeconds(st));
    return c.json({ token: out.token, customer: { id: out.id, email, firstName: out.firstName, lastName: out.lastName, phone: null, emailVerified: false, isMigrated: false } }, 200);
  },
);

// POST /v1/shop/auth/login
auth.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/auth/login',
    summary: 'Log in',
    request: { body: { content: { 'application/json': { schema: z.object({ email: z.string().email(), password: z.string(), turnstileToken: z.string().optional() }) } } } },
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: z.object({ token: z.string(), customer: CustomerOut }) } } },
      401: { description: 'Invalid', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      403: { description: 'Bot check failed', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      429: { description: 'Too many attempts', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { email: rawEmail, password, turnstileToken } = c.req.valid('json');
    const email = normalizeEmail(rawEmail);
    const ip = clientIp(c);
    const retry = loginRetryAfter(ip, email);
    if (retry > 0) return c.json({ error: `too many attempts — try again in ${retry}s` }, 429);
    if (!(await turnstileOk(st.config, turnstileToken, ip))) {
      recordLoginFailure(ip, email);
      return c.json({ error: 'verification failed' }, 403);
    }
    const out = await withStore(st.id, async (tx): Promise<{ ok: false } | { ok: true; token: string; customer: z.infer<typeof CustomerOut> }> => {
      const [cust] = await tx.select({ id: s.customer.id, email: s.customer.email, firstName: s.customer.firstName, lastName: s.customer.lastName, phone: s.customer.phone, emailVerified: s.customer.emailVerified, passwordHash: s.customer.passwordHash }).from(s.customer).where(eq(s.customer.email, email)).limit(1);
      if (!cust || !(await verifyPassword(password, cust.passwordHash))) return { ok: false };

      // Keep the native password format on the current Argon2id work factor.
      // This upgrades SellRight's pre-Argon2 scrypt hashes and future lower-cost
      // Argon2 hashes only after the supplied password has been verified.
      if (passwordNeedsRehash(cust.passwordHash)) {
        await tx.update(s.customer).set({ passwordHash: await hashPassword(password), updatedAt: new Date() }).where(eq(s.customer.id, cust.id));
      }

      const token = await createSession(tx, st.id, cust.id, sessionPolicy(st.config));
      return { ok: true, token, customer: { id: cust.id, email: cust.email, firstName: cust.firstName, lastName: cust.lastName, phone: cust.phone, emailVerified: cust.emailVerified, isMigrated: false } };
    });
    if (!out.ok) { recordLoginFailure(ip, email); return c.json({ error: 'invalid email or password' }, 401); }
    clearLoginAttempts(ip, email);
    setCustomerCookies(c, out.token, newCsrf(), customerCookieSeconds(st));
    return c.json({ token: out.token, customer: out.customer }, 200);
  },
);

// POST /v1/shop/auth/google — sign in / up with a Google ID token (GIS credential)
auth.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/auth/google',
    summary: 'Sign in with Google',
    request: { body: { content: { 'application/json': { schema: z.object({ credential: z.string().min(20) }) } } } },
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: z.object({ token: z.string(), customer: CustomerOut }) } } },
      401: { description: 'Invalid token', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      409: { description: 'Not configured', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const clientId = await googleClientId(st.id);
    if (!clientId) return c.json({ error: 'Google sign-in is not configured for this store' }, 409);
    const { credential } = c.req.valid('json');
    const g = await verifyGoogleIdToken(credential, clientId);
    if (!g || !g.emailVerified) return c.json({ error: 'invalid or unverified Google token' }, 401);
    const out = await withStore(st.id, async (tx): Promise<{ token: string; customer: z.infer<typeof CustomerOut> }> => {
      // Match by googleSub first, then link by email, else create.
      let [cust] = await tx.select().from(s.customer).where(eq(s.customer.googleSub, g.sub)).limit(1);
      if (!cust) {
        const [byEmail] = await tx.select().from(s.customer).where(eq(s.customer.email, g.email)).limit(1);
        if (byEmail) {
          await tx.update(s.customer).set({ googleSub: g.sub, emailVerified: true, updatedAt: new Date() }).where(eq(s.customer.id, byEmail.id));
          cust = byEmail;
        } else {
          const [created] = await tx.insert(s.customer).values({ storeId: st.id, email: g.email, firstName: g.firstName, lastName: g.lastName, googleSub: g.sub, emailVerified: true }).returning();
          cust = created!;
        }
      }
      const token = await createSession(tx, st.id, cust.id, sessionPolicy(st.config));
      return { token, customer: { id: cust.id, email: cust.email, firstName: cust.firstName, lastName: cust.lastName, phone: cust.phone, emailVerified: true, isMigrated: cust.passwordHash == null } };
    });
    setCustomerCookies(c, out.token, newCsrf(), customerCookieSeconds(st));
    return c.json(out, 200);
  },
);

// POST /v1/shop/auth/apple — Sign in with Apple (ported upstream from
// RightSites). Verifies the client's identityToken server-side (auth/apple.ts:
// signature, issuer, audience, expiry against Apple's published JWKS) and
// finds-or-creates a passwordless account — match by appleUserId first, then
// link by email (repeat sign-ins from a Private Relay address can omit the
// email, so the appleUserId match is what makes those idempotent). The accepted
// audience list is store config auth.appleClientId / APPLE_CLIENT_IDS — never
// a client-supplied bundle id. apple_user_id is read/written via raw SQL: the
// column lands in migration 0061 and schema-core.ts is owned by another lane.
auth.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/auth/apple',
    summary: 'Sign in with Apple',
    request: { body: { content: { 'application/json': { schema: z.object({ identityToken: z.string().min(20) }) } } } },
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: z.object({ token: z.string(), customer: CustomerOut }) } } },
      401: { description: 'Invalid token', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      409: { description: 'Not configured', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const audiences = appleClientIds(st.config);
    if (!audiences.length) return c.json({ error: 'Sign in with Apple is not configured for this store' }, 409);
    const { identityToken } = c.req.valid('json');
    let apple: Awaited<ReturnType<typeof verifyAppleIdentityToken>> = null;
    for (const aud of audiences) {
      apple = await verifyAppleIdentityToken(identityToken, aud);
      if (apple) break;
    }
    if (!apple) return c.json({ error: 'invalid Apple identity token' }, 401);
    const { sub, email: appleEmail, emailVerified } = apple;
    const out = await withStore(st.id, async (tx): Promise<{ token: string; customer: z.infer<typeof CustomerOut> }> => {
      type CustomerRow = { id: string; email: string; first_name: string | null; last_name: string | null; phone: string | null; email_verified: boolean; password_hash: string | null };
      let [cust] = (await tx.execute(sql`SELECT * FROM customer WHERE apple_user_id = ${sub} AND store_id = ${st.id} LIMIT 1`)).rows as CustomerRow[];
      if (!cust && appleEmail) {
        const [byEmail] = (await tx.execute(sql`SELECT * FROM customer WHERE email = ${normalizeEmail(appleEmail)} AND store_id = ${st.id} LIMIT 1`)).rows as CustomerRow[];
        if (byEmail) {
          await tx.execute(sql`UPDATE customer SET apple_user_id = ${sub}, updated_at = now() WHERE id = ${byEmail.id}`);
          cust = byEmail;
        }
      }
      if (!cust) {
        // Apple's Private Relay can omit email on repeat sign-ins; a fresh
        // account with no email yet is legitimate here — the email column is
        // NOT NULL so fall back to an opaque per-sub placeholder that can
        // never collide with a real address (.invalid is reserved, RFC 2606)
        // and is never shown to the user.
        const email = appleEmail ? normalizeEmail(appleEmail) : `apple-${sub}@no-email.invalid`;
        const [created] = (await tx.execute(sql`
          INSERT INTO customer (store_id, email, apple_user_id, email_verified)
          VALUES (${st.id}, ${email}, ${sub}, ${emailVerified}) RETURNING *`)).rows as CustomerRow[];
        cust = created!;
      }
      const token = await createSession(tx, st.id, cust.id, sessionPolicy(st.config));
      return { token, customer: { id: cust.id, email: cust.email, firstName: cust.first_name, lastName: cust.last_name, phone: cust.phone, emailVerified: cust.email_verified, isMigrated: cust.password_hash == null } };
    });
    setCustomerCookies(c, out.token, newCsrf(), customerCookieSeconds(st));
    return c.json(out, 200);
  },
);

// POST /v1/shop/auth/magic-link/request — passwordless sign-in. Always 200 for
// a well-formed request (no account enumeration — same response whether or not
// the email exists), mirrors forgot-password. The email goes through the
// durable outbox inside the same txn as the token mint, sender + storefront
// URL resolved per store (SR-05/SR-12).
auth.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/auth/magic-link/request',
    summary: 'Request a passwordless sign-in link',
    request: { body: { content: { 'application/json': { schema: z.object({ email: z.string().email() }) } } } },
    responses: {
      200: { description: 'Always OK', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } },
      409: { description: 'Not enabled', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      429: { description: 'Rate limited', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const policy = magicLinkPolicy(st.config);
    if (!policy.enabled) return c.json({ error: 'magic-link sign-in is not enabled for this store' }, 409);
    const email = normalizeEmail(c.req.valid('json').email);
    const ip = clientIp(c);
    // Attempt-counted in practice: every request records — each one can trigger
    // an outgoing email, so it's abuse-relevant whether or not an account exists.
    const bucket = `magiclink:${email}`;
    const retry = loginRetryAfter(ip, bucket);
    if (retry > 0) return c.json({ error: `too many attempts — try again in ${retry}s` }, 429);
    await withStore(st.id, async (tx) => {
      const [cust] = await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.email, email)).limit(1);
      if (!cust) return; // enumeration-safe: identical 200, no token, no email
      const raw = await mintMagicLink(tx, st.id, cust.id, policy.ttlMinutes);
      const url = `${resolveStorefrontUrl(emailStoreCtx(st))}${policy.path}?token=${raw}`;
      await enqueueMagicLink(tx, st.id, emailStoreCtx(st), email, { url, ttlMinutes: policy.ttlMinutes });
    });
    recordLoginFailure(ip, bucket);
    return c.json({ ok: true }, 200);
  },
);

// POST /v1/shop/auth/magic-link/consume — exchange the one-time token for a
// session. Redemption is a single conditional UPDATE (consumeMagicLink), so
// concurrent consumes of one token issue exactly one session.
auth.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/auth/magic-link/consume',
    summary: 'Exchange a magic-link token for a session',
    request: { body: { content: { 'application/json': { schema: z.object({ token: z.string().min(20) }) } } } },
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: z.object({ token: z.string(), customer: CustomerOut }) } } },
      409: { description: 'Invalid/expired/used or not enabled', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    if (!magicLinkPolicy(st.config).enabled) return c.json({ error: 'magic-link sign-in is not enabled for this store' }, 409);
    const { token: raw } = c.req.valid('json');
    const out = await withStore(st.id, async (tx): Promise<{ ok: false } | { ok: true; token: string; customer: z.infer<typeof CustomerOut> }> => {
      const consumed = await consumeMagicLink(tx, st.id, raw);
      if (!consumed) return { ok: false };
      const [cust] = await tx.select().from(s.customer).where(eq(s.customer.id, consumed.customerId)).limit(1);
      if (!cust) return { ok: false };
      // A magic-link sign-in proves control of the mailbox — treat it the same
      // as an explicit email-verify token.
      if (!cust.emailVerified) await tx.update(s.customer).set({ emailVerified: true, updatedAt: new Date() }).where(eq(s.customer.id, cust.id));
      const sessionToken = await createSession(tx, st.id, cust.id, sessionPolicy(st.config));
      return { ok: true, token: sessionToken, customer: { id: cust.id, email: cust.email, firstName: cust.firstName, lastName: cust.lastName, phone: cust.phone, emailVerified: true, isMigrated: cust.passwordHash == null } };
    });
    if (!out.ok) return c.json({ error: 'token is invalid, expired, or already used' }, 409);
    setCustomerCookies(c, out.token, newCsrf(), customerCookieSeconds(st));
    return c.json({ token: out.token, customer: out.customer }, 200);
  },
);

// GET /v1/shop/auth/me
auth.openapi(
  createRoute({
    method: 'get',
    path: '/v1/shop/auth/me',
    summary: 'Current customer',
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: CustomerOut } } },
      401: { description: 'Unauthenticated', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const token = customerToken(c);
    if (!token) return c.json({ error: 'not authenticated' }, 401);
    // /auth/me is the explicit account-refresh read — make it authoritative:
    // a renewable session extends here even outside the renew window.
    const cust = await withStore(st.id, (tx) => resolveCustomer(tx, token, true));
    if (!cust) return c.json({ error: 'not authenticated' }, 401);
    return c.json({ id: cust.id, email: cust.email, firstName: cust.firstName, lastName: cust.lastName, phone: cust.phone, emailVerified: cust.emailVerified, isMigrated: cust.isMigrated }, 200);
  },
);

// GET /v1/shop/auth/check-email?email= — pre-submit UX ("email already in use").
// WP4a. This is a deliberate account-existence oracle, so it's rate-limited per
// IP (8/15min, same bucket family as login) to blunt enumeration/scraping.
auth.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/auth/check-email',
    summary: 'Check if an email is already registered (rate-limited)',
    request: { query: z.object({ email: z.string().email(), turnstileToken: z.string().max(2048).optional(), honeypot: z.string().max(1024).optional() }) },
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: z.object({ exists: z.boolean() }) } } },
      429: { description: 'Too many attempts', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const ip = clientIp(c);
    const retry = loginRetryAfter(ip, `checkemail:${ip}`);
    if (retry > 0) return c.json({ error: `too many attempts — try again in ${retry}s` }, 429);
    recordLoginFailure(ip, `checkemail:${ip}`); // count every probe toward the throttle
    const query = c.req.valid('query');
    if (query.honeypot || !(await turnstileOk(st.config, query.turnstileToken, ip))) {
      return c.json({ exists: false }, 200);
    }
    const email = normalizeEmail(query.email);
    const exists = await withStore(st.id, async (tx) => {
      const [row] = await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.email, email)).limit(1);
      return !!row;
    });
    return c.json({ exists }, 200);
  },
);

// POST /v1/shop/auth/logout
auth.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/auth/logout',
    summary: 'Log out',
    responses: { 200: { description: 'OK', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } }, 403: { description: 'CSRF', content: { 'application/json': { schema: z.object({ error: z.string() }) } } } },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    if (!customerCsrfValid(c)) return c.json({ error: 'invalid CSRF token' }, 403);
    const token = customerToken(c);
    if (token) await withStore(st.id, (tx) => deleteSession(tx, token));
    clearCustomerCookies(c);
    return c.json({ ok: true }, 200);
  },
);
