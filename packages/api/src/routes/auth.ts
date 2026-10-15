import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { grantSignupBonus } from '../loyalty/bonus.js';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import { resolveStoreFromCtx } from './store-context.js';
import { type StoreCtx } from '../store-context.js';
import * as s from '../db/schema.js';
import { hashPassword, passwordNeedsRehash, verifyPassword } from '../auth/password.js';
import { customerToken, createSession, deleteSession, resolveCustomer, sessionPolicy } from '../auth/session.js';
import { consumeMagicLink, magicLinkPolicy, mintMagicLink } from '../auth/magic-link.js';
import { googleAuthoritativeForEmail, verifyGoogleIdToken, type GoogleIdentity } from '../auth/google.js';
import { FEDERATED_LINK_TTL_MS, federatedLinkAvailable, hashLinkNonce, newLinkNonce, nonceMatches, redeemFederatedLink, signFederatedLink, verifyFederatedLink } from '../auth/federated-link.js';
import { appleAuthoritativeForEmail, appleClientIds, verifyAppleIdentityToken } from '../auth/apple.js';
import { setCustomerCookies, clearCustomerCookies, customerCsrfValid, newCsrf, cookie, FEDERATED_NONCE_COOKIE, setFederatedNonceCookie, clearFederatedNonceCookie } from '../auth/cookies.js';
import { clientIp, loginRetryAfter, recordLoginFailure, clearLoginAttempts } from '../auth/rate-limit.js';
import { normalizeEmail } from '../auth/email.js';
import { createHash, randomBytes } from 'node:crypto';
import { apiErrorSchema, errJson } from '../lib/api-error.js';
import { enqueueEmailVerify, enqueueFederatedLinkConfirm, enqueueMagicLink, resolveStorefrontUrl } from '../email/dispatch.js';
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

// rememberMe (login only): "keep me signed in" opts INTO the store's normal
// (long) session TTL — the default. Declining it shortens the session to
// this fixed 1-day ceiling, min()'d against the store's own policy so a
// store configured shorter than a day is never LENGTHENED by this flag.
const NOT_REMEMBERED_TTL_MS = 24 * 60 * 60 * 1000;
function loginSessionPolicy(st: StoreCtx, rememberMe: boolean) {
  const policy = sessionPolicy(st.config);
  if (rememberMe) return policy;
  return { ...policy, ttlMs: Math.min(policy.ttlMs, NOT_REMEMBERED_TTL_MS) };
}

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

/** Strict variant: no secret → verifyTurnstileToken's policy (production fails
 *  closed unless TURNSTILE_DISABLED=true). Used by resend-verification; the
 *  shared turnstileOk above is left untouched for register/sign-in/magic-link. */
async function turnstileGate(config: unknown, token: string | undefined, remoteIp: string): Promise<boolean> {
  return verifyTurnstileToken({ secret: turnstileSecret(config), token: token ?? null, remoteIp });
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
      403: { description: 'Bot check failed', content: { 'application/json': { schema: apiErrorSchema() } } },
      409: { description: 'Email taken', content: { 'application/json': { schema: apiErrorSchema() } } },
      429: { description: 'Rate limited', content: { 'application/json': { schema: apiErrorSchema() } } },
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
    const regRetry = await loginRetryAfter(regIp, regBucket);
    if (regRetry > 0) return errJson(c, 429, 'RATE_LIMITED', `too many attempts — try again in ${regRetry}s`);
    // PAR-06: server-side Turnstile when the store config carries a secret.
    if (!(await turnstileOk(st.config, turnstileToken, regIp))) {
      await recordLoginFailure(regIp, regBucket);
      return errJson(c, 403, 'BOT_CHECK_FAILED', 'verification failed');
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
      const verifyUrl = `${resolveStorefrontUrl(emailStoreCtx(st))}/verify?token=${verifyRaw}`;
      await enqueueEmailVerify(tx, st.id, emailStoreCtx(st), email, { url: verifyUrl });
      return { token, id: cust!.id, firstName: cust!.firstName, lastName: cust!.lastName };
    });
    if ('taken' in out) { await recordLoginFailure(regIp, regBucket); return errJson(c, 409, 'EMAIL_TAKEN', 'email already registered'); }
    await clearLoginAttempts(regIp, regBucket);
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
    request: { body: { content: { 'application/json': { schema: z.object({ email: z.string().email(), password: z.string(), turnstileToken: z.string().optional(), rememberMe: z.boolean().default(true) }) } } } },
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: z.object({ token: z.string(), customer: CustomerOut }) } } },
      401: { description: 'Invalid', content: { 'application/json': { schema: apiErrorSchema() } } },
      403: { description: 'Bot check failed or email not verified', content: { 'application/json': { schema: apiErrorSchema().extend({ code: z.literal('not_verified').optional() }) } } },
      429: { description: 'Too many attempts', content: { 'application/json': { schema: apiErrorSchema() } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { email: rawEmail, password, turnstileToken, rememberMe } = c.req.valid('json');
    const email = normalizeEmail(rawEmail);
    const ip = clientIp(c);
    const retry = await loginRetryAfter(ip, email);
    if (retry > 0) return errJson(c, 429, 'RATE_LIMITED', `too many attempts — try again in ${retry}s`);
    if (!(await turnstileOk(st.config, turnstileToken, ip))) {
      await recordLoginFailure(ip, email);
      return errJson(c, 403, 'BOT_CHECK_FAILED', 'verification failed');
    }
    const out = await withStore(st.id, async (tx): Promise<{ ok: false } | { ok: 'not_verified' } | { ok: true; token: string; ttlMs: number; customer: z.infer<typeof CustomerOut> }> => {
      const [cust] = await tx.select({ id: s.customer.id, email: s.customer.email, firstName: s.customer.firstName, lastName: s.customer.lastName, phone: s.customer.phone, emailVerified: s.customer.emailVerified, passwordHash: s.customer.passwordHash }).from(s.customer).where(eq(s.customer.email, email)).limit(1);
      if (!cust || !(await verifyPassword(password, cust.passwordHash))) return { ok: false };

      // Keep the native password format on the current Argon2id work factor.
      // This upgrades SellRight's pre-Argon2 scrypt hashes and future lower-cost
      // Argon2 hashes only after the supplied password has been verified.
      if (passwordNeedsRehash(cust.passwordHash)) {
        await tx.update(s.customer).set({ passwordHash: await hashPassword(password), updatedAt: new Date() }).where(eq(s.customer.id, cust.id));
      }

      // SEC: the password matched, but the account was never proven to own its
      // mailbox — a native login must not hand out a session for it. Checked
      // AFTER password verification so this can't become a second account-
      // existence oracle (same 401 as a wrong password for a bad guess).
      if (!cust.emailVerified) return { ok: 'not_verified' };

      const policy = loginSessionPolicy(st, rememberMe);
      const token = await createSession(tx, st.id, cust.id, policy);
      return { ok: true, token, ttlMs: policy.ttlMs, customer: { id: cust.id, email: cust.email, firstName: cust.firstName, lastName: cust.lastName, phone: cust.phone, emailVerified: cust.emailVerified, isMigrated: false } };
    });
    if (out.ok === false) { await recordLoginFailure(ip, email); return errJson(c, 401, 'INVALID_CREDENTIALS', 'invalid email or password'); }
    if (out.ok === 'not_verified') {
      // A correct password DOES clear the login-failure counter here — this is
      // a legitimate credential, just an unverified account — so a real user
      // isn't throttled out of resending their verification email.
      await clearLoginAttempts(ip, email);
      return errJson(c, 403, 'EMAIL_NOT_VERIFIED', 'please verify your email before signing in', { extra: { code: 'not_verified' as const } });
    }
    await clearLoginAttempts(ip, email);
    // Cookie Max-Age tracks the SAME (possibly shortened) TTL the session row
    // just got — rememberMe:false must not hand out a long-lived cookie for a
    // short-lived session.
    setCustomerCookies(c, out.token, newCsrf(), Math.ceil(out.ttlMs / 1000));
    return c.json({ token: out.token, customer: out.customer }, 200);
  },
);

// POST /v1/shop/auth/resend-verification — re-send the email-verify link for
// an unverified account. Enumeration-safe: identical 200 whether or not the
// email exists or is already verified (mirrors magic-link/request). Rate-
// limited per (ip, email) on the SAME bucket family as register, since it is
// exactly as mail-abuse-relevant.
auth.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/auth/resend-verification',
    summary: 'Resend the email verification link',
    request: { body: { content: { 'application/json': { schema: z.object({ email: z.string().email(), turnstileToken: z.string().max(2048).optional() }) } } } },
    responses: {
      200: { description: 'Always OK', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } },
      403: { description: 'Bot check failed', content: { 'application/json': { schema: apiErrorSchema() } } },
      429: { description: 'Rate limited', content: { 'application/json': { schema: apiErrorSchema() } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { email: rawEmail, turnstileToken } = c.req.valid('json');
    const email = normalizeEmail(rawEmail);
    const ip = clientIp(c);
    const bucket = `resendverify:${email}`;
    const retry = await loginRetryAfter(ip, bucket);
    if (retry > 0) return errJson(c, 429, 'RATE_LIMITED', `too many attempts — try again in ${retry}s`);
    await recordLoginFailure(ip, bucket);
    if (!(await turnstileGate(st.config, turnstileToken, ip))) {
      return errJson(c, 403, 'BOT_CHECK_FAILED', 'verification failed');
    }
    await withStore(st.id, async (tx) => {
      const [cust] = await tx.select({ id: s.customer.id, emailVerified: s.customer.emailVerified })
        .from(s.customer).where(eq(s.customer.email, email)).limit(1);
      if (!cust || cust.emailVerified) return; // enumeration-safe: identical 200 either way
      const verifyRaw = randomBytes(32).toString('base64url');
      await tx.insert(s.customerToken).values({ storeId: st.id, customerId: cust.id, kind: 'email_verify', tokenHash: hashToken(verifyRaw), expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_HOURS * 3600 * 1000) });
      const verifyUrl = `${resolveStorefrontUrl(emailStoreCtx(st))}/verify?token=${verifyRaw}`;
      await enqueueEmailVerify(tx, st.id, emailStoreCtx(st), email, { url: verifyUrl });
    });
    return c.json({ ok: true }, 200);
  },
);

// Find-or-link-or-create for a Google identity. `mailboxProven` is true when the
// caller already proved CURRENT control of the address (the authoritative-domain
// check, or a click on the fresh-verification link); only then may an existing
// account be linked by email.
type SignInOutcome = { kind: 'blocked' } | { kind: 'not_linkable' } | { kind: 'ok'; token: string; customer: z.infer<typeof CustomerOut> };
async function completeGoogleSignIn(tx: Parameters<Parameters<typeof withStore>[1]>[0], st: StoreCtx, g: Pick<GoogleIdentity, 'sub' | 'email' | 'firstName' | 'lastName'>, mailboxProven: boolean): Promise<SignInOutcome> {
  // Match by googleSub first, then link by email, else create.
  let [cust] = await tx.select().from(s.customer).where(eq(s.customer.googleSub, g.sub)).limit(1);
  if (!cust) {
    // SEC: an identity that reaches here without mailbox proof was matched by subject a moment ago and has since been
    // unbound; it may neither link nor create.
    if (!mailboxProven) return { kind: 'not_linkable' };
    // SEC: the row is locked (FOR UPDATE) so every check below is made against the committed row. A concurrent email
    // change that commits first means this address no longer names that account: the locked read re-evaluates the
    // email predicate and returns nothing, so proof of the abandoned mailbox cannot attach to the account.
    const [byEmail] = await tx.select().from(s.customer).where(eq(s.customer.email, g.email)).limit(1).for('update');
    // SEC: auto-linking Google sign-in into an EXISTING account by email
    // match is an account-takeover vector if that account has a password
    // and its email was never proven — anyone who can register
    // unverified@victim.com and later prove that SAME address via Google
    // would otherwise silently inherit the victim's pre-existing account.
    // Google itself proved this email (g.emailVerified, checked above),
    // so the only unsafe case is: the target account is unverified AND
    // has a password of its own (someone else set it up first). Refuse
    // the link there rather than clearing the password ourselves — this
    // is not the account owner authenticating, so we don't get to make
    // destructive changes to it; the legitimate owner can still sign in
    // with their password + verify normally, or use the account-recovery
    // flow. A passwordless (isMigrated) unverified account is safe to
    // link: nothing to steal, no credential to invalidate.
    if (byEmail && !byEmail.emailVerified && byEmail.passwordHash) return { kind: 'blocked' };
    // SEC: email-based linking requires proof of CURRENT control of the address:
    // Google authoritative for it (Gmail, or a Workspace `hd` matching the
    // domain) or a fresh email-verification click. Callers never reach here for
    // a non-authoritative identity without that proof (the request handler
    // answers those identically for existing and unknown addresses).
    if (byEmail) {
      // SEC: never re-bind. An account already tied to a DIFFERENT Google subject keeps it (a reassigned address must
      // not let a new Google identity displace the existing one). The UPDATE is conditional too, so a concurrent
      // link between the read above and this write also lands as not_linkable rather than overwriting.
      if (byEmail.googleSub && byEmail.googleSub !== g.sub) return { kind: 'not_linkable' };
      const linked = await tx.update(s.customer).set({ googleSub: g.sub, emailVerified: true, updatedAt: new Date() })
        .where(and(eq(s.customer.id, byEmail.id), eq(s.customer.email, g.email), or(isNull(s.customer.googleSub), eq(s.customer.googleSub, g.sub))))
        .returning({ id: s.customer.id });
      if (linked.length === 0) return { kind: 'not_linkable' };
      cust = byEmail;
    } else {
      const [created] = await tx.insert(s.customer).values({ storeId: st.id, email: g.email, firstName: g.firstName, lastName: g.lastName, googleSub: g.sub, emailVerified: true }).onConflictDoNothing().returning();
      // SEC: another transaction claimed this address (or this subject) after the locked read saw none. Fail closed
      // rather than 500; the shopper starts again and the normal guards apply to the row that now exists.
      if (!created) return { kind: 'not_linkable' };
      cust = created;
    }
  }
  await grantSignupBonus(tx, st.id, cust.id); // REWARDS-1: no-op unless the rule is on
  const token = await createSession(tx, st.id, cust.id, sessionPolicy(st.config));
  return { kind: 'ok', token, customer: { id: cust.id, email: cust.email, firstName: cust.firstName, lastName: cust.lastName, phone: cust.phone, emailVerified: true, isMigrated: cust.passwordHash == null } };
}

function signInOutcomeResponse(c: Parameters<typeof errJson>[0], st: StoreCtx, out: SignInOutcome) {
  if (out.kind === 'blocked') {
    return errJson(c, 409, 'EMAIL_TAKEN_UNVERIFIED', 'an account with this email already exists — sign in with your password and verify your email first');
  }
  if (out.kind === 'not_linkable') {
    return errJson(c, 409, 'EMAIL_TAKEN', 'an account with this email already exists — sign in with your password or a sign-in link first');
  }
  setCustomerCookies(c, out.token, newCsrf(), customerCookieSeconds(st));
  return c.json({ token: out.token, customer: out.customer }, 200);
}

// Rate gate for federated confirmation mail (Google, Apple). Attempt-counted twice: per (ip, address) like magic-link,
// and per address alone so a distributed sender cannot flood one inbox. Both are keyed on the address only (never on
// account state), so a 429 is identical for existing and unknown addresses.
async function federatedMailGate(c: Parameters<typeof clientIp>[0], email: string) {
  const ip = clientIp(c);
  const ipBucket = `federatedlink:${email}`;
  const addrBucket = `federatedlink-addr:${email}`;
  const retry = Math.max(await loginRetryAfter(ip, ipBucket), await loginRetryAfter('*', addrBucket));
  return { retry, record: async () => { await recordLoginFailure(ip, ipBucket); await recordLoginFailure('*', addrBucket); } };
}

// POST /v1/shop/auth/google — sign in / up with a Google ID token (GIS credential).
// A linked Google subject, or an identity Google is authoritative for, signs in
// (200). Any OTHER valid identity gets 202 and a confirmation link mailed to its
// address — with no account lookup, so the response is byte-identical whether
// or not the address already has an account (no enumeration of reassigned
// addresses). The 202 also sets an HttpOnly nonce cookie the link is bound to:
// it redeems only in this browser, at /federated/confirm (auth/federated-link.ts). The same nonce is also returned in the 202
// body (always, so the shape is identical for every address) for native apps with no cookie jar: they finish via a
// universal link carrying the token and POST token + their held nonce. The token reaches only the mailbox holder and the
// nonce only the initiator, so both are needed either way; a nonce is never read from a URL.
auth.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/auth/google',
    summary: 'Sign in with Google',
    request: { body: { content: { 'application/json': { schema: z.object({ credential: z.string().min(20) }) } } } },
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: z.object({ token: z.string(), customer: CustomerOut }) } } },
      202: { description: 'Google cannot vouch for this address: a confirmation link was sent to it (identical whether or not an account exists)', content: { 'application/json': { schema: z.object({ verificationRequired: z.literal(true), nonce: z.string() }) } } },
      401: { description: 'Invalid token', content: { 'application/json': { schema: apiErrorSchema() } } },
      409: { description: 'Not configured, or an unverified account already owns this email', content: { 'application/json': { schema: apiErrorSchema() } } },
      429: { description: 'Rate limited', content: { 'application/json': { schema: apiErrorSchema() } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const clientId = await googleClientId(st.id);
    if (!clientId) return errJson(c, 409, 'GOOGLE_SIGNIN_NOT_CONFIGURED', 'Google sign-in is not configured for this store');
    const { credential } = c.req.valid('json');
    const g = await verifyGoogleIdToken(credential, clientId);
    if (!g || !g.emailVerified) return errJson(c, 401, 'GOOGLE_TOKEN_INVALID', 'invalid or unverified Google token');
    const authoritative = googleAuthoritativeForEmail(g);
    // A returning, already-linked subject (matched by sub only, never by email) needs no confirmation mail, so the
    // link-secret check and the mail throttle do not apply to it.
    const needsMail = !authoritative
      && (await withStore(st.id, (tx) => tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.googleSub, g.sub)).limit(1))).length === 0;
    let gate: Awaited<ReturnType<typeof federatedMailGate>> | undefined;
    if (needsMail) {
      // Deployment misconfiguration (no usable link secret in production), same answer for every address.
      if (!federatedLinkAvailable()) return errJson(c, 409, 'GOOGLE_SIGNIN_NOT_CONFIGURED', 'Google sign-in is not configured for this store');
      gate = await federatedMailGate(c, g.email);
      if (gate.retry > 0) return errJson(c, 429, 'RATE_LIMITED', `too many attempts — try again in ${gate.retry}s`);
    }
    const nonce = newLinkNonce();
    const out = await withStore(st.id, async (tx): Promise<SignInOutcome | { kind: 'verify_sent' }> => {
      if (needsMail) {
        // No customer lookup by address here — that is the whole point.
        const token = signFederatedLink({ provider: 'google', storeId: st.id, subject: g.sub, email: g.email, firstName: g.firstName, lastName: g.lastName }, hashLinkNonce(nonce));
        const url = `${resolveStorefrontUrl(emailStoreCtx(st))}/sign-in/confirm?token=${token}`;
        await enqueueFederatedLinkConfirm(tx, st.id, emailStoreCtx(st), g.email, { url, providerName: 'Google', providerEmail: g.email, ttlMinutes: FEDERATED_LINK_TTL_MS / 60000 });
        return { kind: 'verify_sent' };
      }
      return completeGoogleSignIn(tx, st, g, authoritative);
    });
    if (out.kind === 'verify_sent') {
      await gate?.record();
      setFederatedNonceCookie(c, nonce, FEDERATED_LINK_TTL_MS / 1000);
      return c.json({ verificationRequired: true as const, nonce }, 202);
    }
    return signInOutcomeResponse(c, st, out);
  },
);

// POST /v1/shop/auth/federated/confirm — redeem the link mailed by a federated
// sign-in (provider is inside the signed token). Requires (1) a valid, unexpired
// token, (2) the nonce cookie of the browser that started the flow, (3) first
// use. Clicking proves current control of the address, so it may link an
// existing account or create one; this is the first place account state is
// consulted. Any failure of 1-3 is the same 401 and changes nothing.
auth.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/auth/federated/confirm',
    summary: 'Confirm a federated sign-in from the emailed link',
    request: { body: { content: { 'application/json': { schema: z.object({ token: z.string().min(20).max(2048), nonce: z.string().min(20).max(256).optional() }) } } } },
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: z.object({ token: z.string(), customer: CustomerOut }) } } },
      401: { description: 'Link invalid, expired, already used, or opened in a different browser', content: { 'application/json': { schema: apiErrorSchema() } } },
      409: { description: 'The address already belongs to an account that cannot be linked', content: { 'application/json': { schema: apiErrorSchema() } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const invalid = () => errJson(c, 401, 'TOKEN_INVALID', 'this confirmation link is invalid, expired, or was already used — start the sign-in again in this browser');
    const { token: linkToken, nonce: bodyNonce } = c.req.valid('json');
    const claims = verifyFederatedLink(linkToken, st.id);
    if (!claims) return invalid();
    // The initiator's nonce: request body (native apps) or the HttpOnly cookie (browsers) — never the URL. Other browser /
    // wrong nonce: link stays unspent.
    if (!nonceMatches(bodyNonce ?? cookie(c, FEDERATED_NONCE_COOKIE), claims.nonceHash)) return invalid();
    const out = await withStore(st.id, async (tx): Promise<SignInOutcome | { kind: 'replayed' }> => {
      if (!(await redeemFederatedLink(tx, st.id, claims.jti, claims.exp))) return { kind: 'replayed' };
      // Clicking proved the mailbox, so the provider-specific link/create runs with mailboxProven.
      return claims.provider === 'apple'
        ? completeAppleSignIn(tx, st, { sub: claims.subject, email: claims.email, emailVerified: true }, true)
        : completeGoogleSignIn(tx, st, { sub: claims.subject, email: claims.email, firstName: claims.firstName, lastName: claims.lastName }, true);
    });
    if (out.kind === 'replayed') return invalid();
    clearFederatedNonceCookie(c);
    return signInOutcomeResponse(c, st, out);
  },
);

// Find-or-link-or-create for an Apple identity. `mailboxProven` is true when the caller already proved CURRENT control
// of the address (Apple authoritative for it, or a click on the confirmation link); only then may an existing account
// be linked by email. apple_user_id is read/written via raw SQL (see the route comment below).
async function completeAppleSignIn(tx: Parameters<Parameters<typeof withStore>[1]>[0], st: StoreCtx, apple: { sub: string; email: string | null; emailVerified: boolean }, mailboxProven: boolean): Promise<SignInOutcome> {
  const { sub, email: appleEmail, emailVerified } = apple;
  type CustomerRow = { id: string; email: string; first_name: string | null; last_name: string | null; phone: string | null; email_verified: boolean; password_hash: string | null; apple_user_id: string | null };
  let [cust] = (await tx.execute(sql`SELECT * FROM customer WHERE apple_user_id = ${sub} AND store_id = ${st.id} LIMIT 1`)).rows as CustomerRow[];
  if (!cust && appleEmail) {
    // SEC: an identity naming an address without mailbox proof was matched by subject a moment ago and has since been
    // unbound; it may neither link nor create.
    if (!mailboxProven) return { kind: 'not_linkable' };
    // SEC: locked read (FOR UPDATE), same reason as Google: a concurrent email change that commits first makes this
    // return nothing, so proof of the abandoned mailbox cannot attach to the account.
    const [byEmail] = (await tx.execute(sql`SELECT * FROM customer WHERE email = ${normalizeEmail(appleEmail)} AND store_id = ${st.id} LIMIT 1 FOR UPDATE`)).rows as CustomerRow[];
    // SEC: same guards as Google (see completeGoogleSignIn). (1) never link
    // into a password-holding, still-unverified account someone else
    // registered first; (2) email-based linking requires proof of current
    // control of the address — Apple authoritative for it (Apple-hosted /
    // Private Relay) or a fresh confirmation click — otherwise a reassigned
    // third-party address could inherit the current owner's account; (3) never
    // overwrite an account already bound to a different Apple subject. Fail
    // closed with no session. An existing email must NEVER fall through to
    // INSERT (duplicate / oracle).
    // NOTE: the apple_user_id match above is per store, not per audience/
    // team. A user who previously signed in under a different Apple team
    // (different per-team `sub` for the same Apple ID, e.g. after a
    // bundle-id / audience change) no longer relinks to their account by
    // email: they get 409 EMAIL_TAKEN and must sign in another way. There
    // is no signed-in "link Apple" endpoint yet, so the 409 message points
    // only at sign-in methods that exist; it does not promise a link step.
    if (byEmail) {
      if (!byEmail.email_verified && byEmail.password_hash) return { kind: 'blocked' };
      if (byEmail.apple_user_id && byEmail.apple_user_id !== sub) {
        return { kind: 'not_linkable' };
      }
      // Race guard: the SELECT above is not locked, so re-assert in the
      // WHERE that the row is still unbound (or already ours). A concurrent
      // sign-in with another Apple subject that bound it first -> 0 rows.
      const linked = (await tx.execute(sql`UPDATE customer SET apple_user_id = ${sub}, email_verified = true, updated_at = now() WHERE id = ${byEmail.id} AND email = ${normalizeEmail(appleEmail)} AND (apple_user_id IS NULL OR apple_user_id = ${sub}) RETURNING id`)).rows;
      if (!linked.length) return { kind: 'not_linkable' };
      cust = { ...byEmail, email_verified: true };
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
      VALUES (${st.id}, ${email}, ${sub}, ${emailVerified}) ON CONFLICT DO NOTHING RETURNING *`)).rows as CustomerRow[];
    // SEC: another transaction claimed this address (or this subject) after the locked read saw none: fail closed.
    if (!created) return { kind: 'not_linkable' };
    cust = created;
  }
  const token = await createSession(tx, st.id, cust.id, sessionPolicy(st.config));
  return { kind: 'ok', token, customer: { id: cust.id, email: cust.email, firstName: cust.first_name, lastName: cust.last_name, phone: cust.phone, emailVerified: cust.email_verified, isMigrated: cust.password_hash == null } };
}

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
      202: { description: 'Apple cannot vouch for this address: a confirmation link was sent to it (identical whether or not an account exists)', content: { 'application/json': { schema: z.object({ verificationRequired: z.literal(true), nonce: z.string() }) } } },
      401: { description: 'Invalid token', content: { 'application/json': { schema: apiErrorSchema() } } },
      409: { description: 'Not configured (APPLE_SIGNIN_NOT_CONFIGURED), an unverified account owns this email (EMAIL_TAKEN_UNVERIFIED), or an account with this email exists and Apple is not authoritative for it / is bound to another Apple subject (EMAIL_TAKEN)', content: { 'application/json': { schema: apiErrorSchema() } } },
      429: { description: 'Rate limited', content: { 'application/json': { schema: apiErrorSchema() } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const audiences = appleClientIds(st.config);
    if (!audiences.length) return errJson(c, 409, 'APPLE_SIGNIN_NOT_CONFIGURED', 'Sign in with Apple is not configured for this store');
    const { identityToken } = c.req.valid('json');
    let apple: Awaited<ReturnType<typeof verifyAppleIdentityToken>> = null;
    for (const aud of audiences) {
      apple = await verifyAppleIdentityToken(identityToken, aud);
      if (apple) break;
    }
    if (!apple) return errJson(c, 401, 'APPLE_TOKEN_INVALID', 'invalid Apple identity token');
    const { sub, email: appleEmail, emailVerified } = apple;
    // Like Google: a token that carries an email Apple did not verify is
    // rejected outright — never create or link an account from it.
    if (appleEmail && !emailVerified) return errJson(c, 401, 'APPLE_TOKEN_INVALID', 'invalid Apple identity token');
    // An identity that names an address Apple is NOT authoritative for is answered uniformly (see the Google handler):
    // no lookup by address, a confirmation link mailed to it, 202 + nonce cookie, identical for existing and unknown
    // addresses. A returning, already-bound Apple subject and authoritative identities (Apple-hosted / Private Relay)
    // are unchanged; an identity with no email at all names no address, so there is nothing to confirm.
    // The link is bound to the initiator: browsers via the nonce cookie, native apps via the same nonce returned in the
    // 202 body and posted back with the token (see the Google handler comment).
    const authoritative = appleAuthoritativeForEmail(apple);
    // A returning, already-bound subject needs no confirmation mail, so the link-secret check and the mail throttle
    // do not apply to it.
    const confirmByMail = !!appleEmail && !authoritative
      && (await withStore(st.id, (tx) => tx.execute(sql`SELECT 1 FROM customer WHERE apple_user_id = ${sub} AND store_id = ${st.id} LIMIT 1`))).rows.length === 0;
    let gate: Awaited<ReturnType<typeof federatedMailGate>> | undefined;
    if (confirmByMail) {
      if (!federatedLinkAvailable()) return errJson(c, 409, 'APPLE_SIGNIN_NOT_CONFIGURED', 'Sign in with Apple is not configured for this store');
      gate = await federatedMailGate(c, normalizeEmail(appleEmail!));
      if (gate.retry > 0) return errJson(c, 429, 'RATE_LIMITED', `too many attempts — try again in ${gate.retry}s`);
    }
    const nonce = newLinkNonce();
    const out = await withStore(st.id, async (tx): Promise<SignInOutcome | { kind: 'verify_sent' }> => {
      if (confirmByMail) {
        const to = normalizeEmail(appleEmail!);
        const token = signFederatedLink({ provider: 'apple', storeId: st.id, subject: sub, email: to, firstName: null, lastName: null }, hashLinkNonce(nonce));
        const url = `${resolveStorefrontUrl(emailStoreCtx(st))}/sign-in/confirm?token=${token}`;
        await enqueueFederatedLinkConfirm(tx, st.id, emailStoreCtx(st), to, { url, providerName: 'Apple', providerEmail: to, ttlMinutes: FEDERATED_LINK_TTL_MS / 60000 });
        return { kind: 'verify_sent' };
      }
      return completeAppleSignIn(tx, st, apple, authoritative);
    });
    if (out.kind === 'verify_sent') {
      await gate?.record();
      setFederatedNonceCookie(c, nonce, FEDERATED_LINK_TTL_MS / 1000);
      return c.json({ verificationRequired: true as const, nonce }, 202);
    }
    return signInOutcomeResponse(c, st, out);
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
    request: { body: { content: { 'application/json': { schema: z.object({ email: z.string().email(), turnstileToken: z.string().optional() }) } } } },
    responses: {
      200: { description: 'Always OK', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } },
      403: { description: 'Bot check failed', content: { 'application/json': { schema: apiErrorSchema() } } },
      409: { description: 'Not enabled', content: { 'application/json': { schema: apiErrorSchema() } } },
      429: { description: 'Rate limited', content: { 'application/json': { schema: apiErrorSchema() } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const policy = magicLinkPolicy(st.config);
    if (!policy.enabled) return errJson(c, 409, 'MAGIC_LINK_DISABLED', 'magic-link sign-in is not enabled for this store');
    const { email: rawEmail, turnstileToken } = c.req.valid('json');
    const email = normalizeEmail(rawEmail);
    const ip = clientIp(c);
    // Attempt-counted in practice: every request records — each one can trigger
    // an outgoing email, so it's abuse-relevant whether or not an account exists.
    const bucket = `magiclink:${email}`;
    const retry = await loginRetryAfter(ip, bucket);
    if (retry > 0) return errJson(c, 429, 'RATE_LIMITED', `too many attempts — try again in ${retry}s`);
    // Same bot gate as forgot-password: when the store has Turnstile configured, a request
    // without a valid token is refused before any account lookup or outgoing email.
    if (!(await turnstileOk(st.config, turnstileToken, ip))) {
      await recordLoginFailure(ip, bucket);
      return errJson(c, 403, 'BOT_CHECK_FAILED', 'verification failed');
    }
    await withStore(st.id, async (tx) => {
      // FOR UPDATE: an e-mail change for this account (verify-email-change locks the same row) either commits first
      // — then the row no longer matches the OLD address and nothing is minted for it — or waits for this mint and
      // then burns the new link. Without the lock a link for the abandoned mailbox could be minted after the change
      // (B2.16 magic-link vs e-mail-change race).
      const [cust] = await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.email, email)).limit(1).for('update');
      if (!cust) return; // enumeration-safe: identical 200, no token, no email
      const raw = await mintMagicLink(tx, st.id, cust.id, policy.ttlMinutes);
      const url = `${resolveStorefrontUrl(emailStoreCtx(st))}${policy.path}?token=${raw}`;
      await enqueueMagicLink(tx, st.id, emailStoreCtx(st), email, { url, ttlMinutes: policy.ttlMinutes });
    });
    await recordLoginFailure(ip, bucket);
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
      409: { description: 'Invalid/expired/used or not enabled', content: { 'application/json': { schema: apiErrorSchema() } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    if (!magicLinkPolicy(st.config).enabled) return errJson(c, 409, 'MAGIC_LINK_DISABLED', 'magic-link sign-in is not enabled for this store');
    const { token: raw } = c.req.valid('json');
    const out = await withStore(st.id, async (tx): Promise<{ ok: false } | { ok: true; token: string; customer: z.infer<typeof CustomerOut> }> => {
      const consumed = await consumeMagicLink(tx, st.id, raw);
      if (!consumed) return { ok: false };
      const [cust] = await tx.select().from(s.customer).where(eq(s.customer.id, consumed.customerId)).limit(1);
      if (!cust) return { ok: false };
      // A magic-link sign-in proves control of the mailbox — treat it the same
      // as an explicit email-verify token.
      if (!cust.emailVerified) await tx.update(s.customer).set({ emailVerified: true, updatedAt: new Date() }).where(eq(s.customer.id, cust.id));
      await grantSignupBonus(tx, st.id, cust.id); // REWARDS-1: no-op unless the rule is on
      const sessionToken = await createSession(tx, st.id, cust.id, sessionPolicy(st.config));
      return { ok: true, token: sessionToken, customer: { id: cust.id, email: cust.email, firstName: cust.firstName, lastName: cust.lastName, phone: cust.phone, emailVerified: true, isMigrated: cust.passwordHash == null } };
    });
    if (!out.ok) return errJson(c, 409, 'MAGIC_LINK_INVALID', 'token is invalid, expired, or already used');
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
      401: { description: 'Unauthenticated', content: { 'application/json': { schema: apiErrorSchema() } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const token = customerToken(c);
    if (!token) return errJson(c, 401, 'NOT_AUTHENTICATED', 'not authenticated');
    // /auth/me is the explicit account-refresh read — make it authoritative:
    // a renewable session extends here even outside the renew window.
    const cust = await withStore(st.id, (tx) => resolveCustomer(tx, token, true));
    if (!cust) return errJson(c, 401, 'NOT_AUTHENTICATED', 'not authenticated');
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
      // needsPasswordSetup: the account exists but has no password (imported
      // from another platform) — the storefront offers "set your password"
      // (the reset-password email) instead of a password prompt that can never
      // succeed. Only ever true alongside exists: true.
      200: { description: 'OK', content: { 'application/json': { schema: z.object({ exists: z.boolean(), needsPasswordSetup: z.boolean().optional() }) } } },
      429: { description: 'Too many attempts', content: { 'application/json': { schema: apiErrorSchema() } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const ip = clientIp(c);
    const retry = await loginRetryAfter(ip, `checkemail:${ip}`);
    if (retry > 0) return errJson(c, 429, 'RATE_LIMITED', `too many attempts — try again in ${retry}s`);
    await recordLoginFailure(ip, `checkemail:${ip}`); // count every probe toward the throttle
    const query = c.req.valid('query');
    if (query.honeypot || !(await turnstileOk(st.config, query.turnstileToken, ip))) {
      return c.json({ exists: false }, 200);
    }
    const email = normalizeEmail(query.email);
    const row = await withStore(st.id, async (tx) => {
      const [found] = await tx.select({ passwordHash: s.customer.passwordHash, googleSub: s.customer.googleSub, appleUserId: s.customer.appleUserId })
        .from(s.customer).where(eq(s.customer.email, email)).limit(1);
      return found ?? null;
    });
    if (!row) return c.json({ exists: false }, 200);
    // Social-login accounts have no password on purpose; they sign in with
    // their provider, so they are not "needs password setup".
    const needsPasswordSetup = !row.passwordHash && !row.googleSub && !row.appleUserId;
    return c.json({ exists: true, needsPasswordSetup }, 200);
  },
);

// POST /v1/shop/auth/logout
auth.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/auth/logout',
    summary: 'Log out',
    responses: { 200: { description: 'OK', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } }, 403: { description: 'CSRF', content: { 'application/json': { schema: apiErrorSchema() } } } },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    if (!customerCsrfValid(c)) return errJson(c, 403, 'CSRF_INVALID', 'invalid CSRF token');
    const token = customerToken(c);
    if (token) await withStore(st.id, (tx) => deleteSession(tx, token));
    clearCustomerCookies(c);
    return c.json({ ok: true }, 200);
  },
);
