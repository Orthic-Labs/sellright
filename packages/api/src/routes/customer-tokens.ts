/**
 * Customer one-time token routes (WP2d). Endpoints: forgot-password,
 * reset-password, verify-email, request-email-change, verify-email-change.
 * set_password kind is minted by the migrated-customer activation flow (WP5),
 * not exposed as a public endpoint.
 *
 * SR-12: every send goes through the email outbox (enqueue inside the same txn
 * that mints the token) — no inline SMTP here, so a mail outage can never drop
 * a token link the customer is waiting on.
 * SR-05: sender + storefront URL resolve per store (store.config.storefrontUrl
 * / emailFrom, with per-app env overrides still winning when an appKey is set).
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import { type StoreCtx } from '../store-context.js';
import { resolveStoreFromCtx } from './store-context.js';
import * as s from '../db/schema.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { normalizeEmail } from '../auth/email.js';
import { customerToken, resolveCustomer } from '../auth/session.js';
import { clientIp, loginRetryAfter, recordLoginFailure } from '../auth/rate-limit.js';
import { verifyTurnstileToken } from '../security/turnstile.js';
import { enqueuePasswordReset, enqueueEmailAddressChange, resolveStorefrontUrl, type StoreEmailCtx } from '../email/dispatch.js';
import { env } from '../env.js';

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
const TTL_HOURS = 2;
const EMAIL_CHANGE_TTL_HOURS = 24; // bounded lifetime for the change link

function storeEmailCtx(st: StoreCtx): StoreEmailCtx {
  return { name: st.name, currency: st.currency, config: st.config };
}

// 'email_change' joined the customer_token kind CHECK in migration 0057. The
// drizzle enum in schema-content.ts is owned by another lane, so inserts pin
// the literal via raw SQL — the seam stays in this file instead of a shared
// schema edit mid-flight.
const EMAIL_CHANGE_KIND = 'email_change';

// PAR-06: per-store anti-bot. The secret lives in store.config
// (turnstileSecretKey, or turnstile.secretKey nested) — no secret configured
// means the feature is off and verifyTurnstileToken returns true.
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
  // Fail closed on verification failure — a configured store never proceeds on
  // a missing/invalid token.
  return verifyTurnstileToken({ secret, token: token ?? null, remoteIp });
}

export const customerTokens = new OpenAPIHono();

// POST /v1/shop/auth/forgot-password — always 200 (no account enumeration).
customerTokens.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/auth/forgot-password',
    summary: 'Request a password-reset email',
    request: { body: { content: { 'application/json': { schema: z.object({ email: z.string().email(), turnstileToken: z.string().optional() }) } } } },
    responses: {
      200: { description: 'Always OK', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } },
      403: { description: 'Bot check failed', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      429: { description: 'Rate limited', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { email: rawEmail, turnstileToken } = c.req.valid('json');
    const email = normalizeEmail(rawEmail);
    const ip = clientIp(c);
    const retry = loginRetryAfter(ip, `forgot:${email}`);
    if (retry > 0) return c.json({ error: `too many attempts — try again in ${retry}s` }, 429);
    if (!(await turnstileOk(st.config, turnstileToken, ip))) {
      recordLoginFailure(ip, `forgot:${email}`);
      return c.json({ error: 'verification failed' }, 403);
    }
    await withStore(st.id, async (tx) => {
      const [cust] = await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.email, email)).limit(1);
      if (!cust) return; // enumeration-safe: no email if no account
      const raw = randomBytes(32).toString('base64url');
      await tx.insert(s.customerToken).values({ storeId: st.id, customerId: cust.id, kind: 'password_reset', tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + TTL_HOURS * 3600 * 1000) });
      const url = `${resolveStorefrontUrl(storeEmailCtx(st))}/password-reset?token=${raw}`;
      // Same txn as the token mint — the email can never outlive a rollback,
      // and the outbox retries delivery instead of dropping it (SR-12).
      await enqueuePasswordReset(tx, st.id, storeEmailCtx(st), email, { url, ttlHours: TTL_HOURS });
    });
    recordLoginFailure(ip, `forgot:${email}`); // throttle: per-IP+email bucket, not per-account,
    // so an attacker can't lock a real customer out by spamming forgot-password,
    // but the attacker themselves is throttled.
    return c.json({ ok: true }, 200);
  },
);

// POST /v1/shop/auth/reset-password — exchange token for new password.
customerTokens.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/auth/reset-password',
    summary: 'Reset password using a one-time token',
    request: { body: { content: { 'application/json': { schema: z.object({ token: z.string().min(20), password: z.string().min(8) }) } } } },
    responses: { 200: { description: 'OK', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } }, 409: { description: 'Invalid/expired/used', content: { 'application/json': { schema: z.object({ error: z.string() }) } } } },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { token, password } = c.req.valid('json');
    const tokenHash = hashToken(token);
    const ok = await withStore(st.id, async (tx): Promise<boolean> => {
      const [row] = await tx.select({ id: s.customerToken.id, customerId: s.customerToken.customerId }).from(s.customerToken)
        .where(and(eq(s.customerToken.tokenHash, tokenHash), eq(s.customerToken.kind, 'password_reset'), gt(s.customerToken.expiresAt, new Date()), isNull(s.customerToken.usedAt))).limit(1);
      if (!row) return false;
      const passwordHash = await hashPassword(password);
      await tx.update(s.customer).set({ passwordHash, updatedAt: new Date() }).where(eq(s.customer.id, row.customerId));
      await tx.update(s.customerToken).set({ usedAt: new Date() }).where(eq(s.customerToken.id, row.id));
      // Invalidate this customer's sessions in THIS store. (session is RLS-exempt
      // for token lookup, so we must filter by storeId explicitly.)
      await tx.delete(s.session).where(and(eq(s.session.customerId, row.customerId), eq(s.session.storeId, st.id)));
      return true;
    });
    if (!ok) return c.json({ error: 'token is invalid, expired, or already used' }, 409);
    return c.json({ ok: true }, 200);
  },
);

// POST /v1/shop/auth/verify-email — flip emailVerified on the customer.
customerTokens.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/auth/verify-email',
    summary: 'Verify an email-verify token',
    request: { body: { content: { 'application/json': { schema: z.object({ token: z.string().min(20) }) } } } },
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } },
      409: { description: 'Invalid/expired/used', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      429: { description: 'Rate limited', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { token } = c.req.valid('json');
    const tokenHash = hashToken(token);
    const ip = clientIp(c);
    // Per-IP-only bucket — a single client hammering verify from one IP trips
    // the throttle for that IP, but multiple customers behind the same NAT
    // still throttles cleanly.
    const bucket = `verify:${ip}`;
    const retry = loginRetryAfter(ip, bucket);
    if (retry > 0) return c.json({ error: `too many attempts — try again in ${retry}s` }, 429);
    const ok = await withStore(st.id, async (tx): Promise<boolean> => {
      const [row] = await tx.select({ id: s.customerToken.id, customerId: s.customerToken.customerId }).from(s.customerToken)
        .where(and(eq(s.customerToken.tokenHash, tokenHash), eq(s.customerToken.kind, 'email_verify'), gt(s.customerToken.expiresAt, new Date()), isNull(s.customerToken.usedAt))).limit(1);
      if (!row) return false;
      await tx.update(s.customer).set({ emailVerified: true, updatedAt: new Date() }).where(eq(s.customer.id, row.customerId));
      await tx.update(s.customerToken).set({ usedAt: new Date() }).where(eq(s.customerToken.id, row.id));
      return true;
    });
    if (!ok) { recordLoginFailure(ip, bucket); return c.json({ error: 'token is invalid, expired, or already used' }, 409); }
    return c.json({ ok: true }, 200);
  },
);

// ── email-address-change (emailAddressChangeHandler parity) ──────────────────
// Flow mirrors the source stores' Vendure handler: the signed, single-use,
// TTL'd link goes to the NEW address; consuming it flips customer.email and
// invalidates the account's sessions in this store.

// POST /v1/shop/auth/request-email-change — authenticated; requires the current
// password so a stolen session alone can't hijack the account's identifier.
customerTokens.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/auth/request-email-change',
    summary: 'Request an email-address change (verification link goes to the NEW address)',
    request: { body: { content: { 'application/json': { schema: z.object({ newEmail: z.string().email(), password: z.string().min(1) }) } } } },
    responses: {
      200: { description: 'Verification email enqueued', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } },
      401: { description: 'Unauthenticated or wrong password', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      409: { description: 'Email unavailable', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      429: { description: 'Rate limited', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { newEmail: rawNewEmail, password } = c.req.valid('json');
    const newEmail = normalizeEmail(rawNewEmail);
    const ip = clientIp(c);
    const bucket = `emailchange:${newEmail}`;
    const retry = loginRetryAfter(ip, bucket);
    if (retry > 0) return c.json({ error: `too many attempts — try again in ${retry}s` }, 429);
    const out = await withStore(st.id, async (tx): Promise<'unauth' | 'wrong' | 'same' | 'taken' | 'ok'> => {
      const token = customerToken(c);
      const cust = token ? await resolveCustomer(tx, token) : null;
      if (!cust) return 'unauth';
      const [row] = await tx.select({ passwordHash: s.customer.passwordHash }).from(s.customer).where(eq(s.customer.id, cust.id)).limit(1);
      // Migrated/OAuth-only accounts have no password to check — they must set
      // one via forgot-password first (same constraint the source flow imposes).
      if (!row?.passwordHash || !(await verifyPassword(password, row.passwordHash))) return 'wrong';
      if (normalizeEmail(cust.email) === newEmail) return 'same';
      const [clash] = await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.email, newEmail)).limit(1);
      if (clash) return 'taken';
      // Supersede any outstanding change requests — only the newest link works.
      await tx.execute(sql`UPDATE customer_token SET used_at = now() WHERE customer_id = ${cust.id} AND kind = ${EMAIL_CHANGE_KIND} AND used_at IS NULL`);
      const raw = randomBytes(32).toString('base64url');
      await tx.execute(sql`INSERT INTO customer_token (store_id, customer_id, kind, token_hash, expires_at, payload)
        VALUES (${st.id}, ${cust.id}, ${EMAIL_CHANGE_KIND}, ${hashToken(raw)}, ${new Date(Date.now() + EMAIL_CHANGE_TTL_HOURS * 3600 * 1000)}, ${JSON.stringify({ newEmail })}::jsonb)`);
      const url = `${resolveStorefrontUrl(storeEmailCtx(st))}/verify-email-address-change?token=${raw}`;
      await enqueueEmailAddressChange(tx, st.id, storeEmailCtx(st), newEmail, { url, newEmail, ttlHours: EMAIL_CHANGE_TTL_HOURS });
      await tx.insert(s.auditLog).values({ storeId: st.id, actor: cust.email, entity: 'customer', entityId: cust.id, action: 'email_change_requested' });
      return 'ok';
    });
    recordLoginFailure(ip, bucket); // mailbomb guard for the target address
    if (out === 'unauth') return c.json({ error: 'not authenticated' }, 401);
    if (out === 'wrong') return c.json({ error: 'password is incorrect' }, 401);
    if (out === 'same') return c.json({ error: 'that is already your email address' }, 409);
    if (out === 'taken') return c.json({ error: 'email address is unavailable' }, 409);
    return c.json({ ok: true }, 200);
  },
);

// POST /v1/shop/auth/verify-email-change — consume the link mailed to the new address.
customerTokens.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/auth/verify-email-change',
    summary: 'Complete an email-address change with the emailed token',
    request: { body: { content: { 'application/json': { schema: z.object({ token: z.string().min(20) }) } } } },
    responses: {
      200: { description: 'Email changed', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } },
      409: { description: 'Invalid/expired/used', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      429: { description: 'Rate limited', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { token } = c.req.valid('json');
    const tokenHash = hashToken(token);
    const ip = clientIp(c);
    const bucket = `verify-change:${ip}`;
    const retry = loginRetryAfter(ip, bucket);
    if (retry > 0) return c.json({ error: `too many attempts — try again in ${retry}s` }, 429);
    const out = await withStore(st.id, async (tx): Promise<'invalid' | 'taken' | 'ok'> => {
      // Atomic consume: used_at flips only when the token is still pending —
      // a replayed/second click can never win the UPDATE (single-use).
      const consumed = await tx.execute(sql`UPDATE customer_token SET used_at = now()
        WHERE token_hash = ${tokenHash} AND kind = ${EMAIL_CHANGE_KIND} AND used_at IS NULL AND expires_at > now()
        RETURNING id, customer_id AS "customerId", payload`);
      const row = consumed.rows[0] as { id: string; customerId: string; payload: { newEmail?: string } | null } | undefined;
      if (!row) return 'invalid';
      const newEmail = normalizeEmail(row.payload?.newEmail ?? '');
      if (!newEmail) return 'invalid';
      // Re-check availability at consume time — another account may have
      // claimed the address since the request was minted.
      const [clash] = await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.email, newEmail)).limit(1);
      if (clash) return 'taken';
      // The customer just proved control of the NEW address — verified by construction.
      await tx.update(s.customer).set({ email: newEmail, emailVerified: true, updatedAt: new Date() }).where(eq(s.customer.id, row.customerId));
      // Identifier changed: invalidate all sessions for this account in this
      // store (session is RLS-exempt for token lookup — filter storeId).
      await tx.delete(s.session).where(and(eq(s.session.customerId, row.customerId), eq(s.session.storeId, st.id)));
      // Burn any other pending change links so only the consumed one ever worked.
      await tx.execute(sql`UPDATE customer_token SET used_at = now() WHERE customer_id = ${row.customerId} AND kind = ${EMAIL_CHANGE_KIND} AND used_at IS NULL`);
      await tx.insert(s.auditLog).values({ storeId: st.id, actor: `customer:${row.customerId}`, entity: 'customer', entityId: row.customerId, action: 'email_changed', data: { email: newEmail } });
      return 'ok';
    });
    if (out !== 'ok') { recordLoginFailure(ip, bucket); return c.json({ error: 'token is invalid, expired, or already used' }, 409); }
    return c.json({ ok: true }, 200);
  },
);
