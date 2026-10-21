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
import { grantSignupBonus } from '../loyalty/bonus.js';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { deleteCustomerPasskeysForRecovery } from '../auth/passkeys-shop.js';
import { withStore } from '../db/client.js';
import { withLockedSet } from '../db/locks.js';
import { type StoreCtx } from '../store-context.js';
import { resolveStoreFromCtx } from './store-context.js';
import * as s from '../db/schema.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { orderProvenanceFilter } from '../auth/order-access.js';
import { normalizeEmail } from '../auth/email.js';
import { customerToken, resolveCustomer } from '../auth/session.js';
import { attemptRetryAfter, clientIp, loginRetryAfter, recordLoginFailure } from '../auth/rate-limit.js';
import { rateLimitBackend } from '../auth/rate-limit-backend.js';
import { verifyTurnstileToken } from '../security/turnstile.js';
import { enqueuePasswordReset, enqueueEmailAddressChange, enqueueEmailAddressChangedNotice, resolveStorefrontUrl, type StoreEmailCtx } from '../email/dispatch.js';
import { apiErrorSchema, errJson } from '../lib/api-error.js';
import { env } from '../env.js';

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
/** Thrown inside the locked set to roll back a consume whose token customer changed. */
class TokenCustomerMoved extends Error {}
const TTL_HOURS = 2;
const EMAIL_CHANGE_TTL_HOURS = 24; // bounded lifetime for the change link

function storeEmailCtx(st: StoreCtx): StoreEmailCtx {
  return { name: st.name, currency: st.currency, config: st.config, storeId: st.id };
}

// 'email_change' joined the customer_token kind CHECK in migration 0057. The
// drizzle enum in schema-content.ts is owned by another lane, so inserts pin
// the literal via raw SQL — the seam stays in this file instead of a shared
// schema edit mid-flight.
const EMAIL_CHANGE_KIND = 'email_change';

// PAR-06: per-store anti-bot; store config or env supplies the secret.
// Without a secret, non-production passes & production fails closed unless
// TURNSTILE_DISABLED=true. Configured secrets always require verification.
function turnstileSecret(config: unknown): string | null {
  const c = (config && typeof config === 'object' ? config : {}) as Record<string, unknown>;
  const nested = (c.turnstile as Record<string, unknown> | undefined)?.secretKey;
  const flat = c.turnstileSecretKey ?? c.turnstile_secret_key ?? c.turnstileSecret;
  const v = (typeof nested === 'string' && nested.trim() ? nested : flat) ??
    env.TURNSTILE_SECRET_KEY ?? process.env.TURNSTILE_SECRET_KEY;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

async function turnstileOk(config: unknown, token: string | undefined, remoteIp: string): Promise<boolean> {
  // verifyTurnstileToken owns the no-secret policy: dev/test pass, production
  // fails closed unless TURNSTILE_DISABLED=true. Fail closed on any failure.
  return verifyTurnstileToken({ secret: turnstileSecret(config), token: token ?? null, remoteIp });
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
      403: { description: 'Bot check failed', content: { 'application/json': { schema: apiErrorSchema() } } },
      429: { description: 'Rate limited', content: { 'application/json': { schema: apiErrorSchema() } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { email: rawEmail, turnstileToken } = c.req.valid('json');
    const email = normalizeEmail(rawEmail);
    const ip = clientIp(c);
    const retry = await loginRetryAfter(ip, `forgot:${email}`);
    if (retry > 0) return errJson(c, 429, 'RATE_LIMITED', `too many attempts — try again in ${retry}s`);
    if (!(await turnstileOk(st.config, turnstileToken, ip))) {
      await recordLoginFailure(ip, `forgot:${email}`);
      return errJson(c, 403, 'BOT_CHECK_FAILED', 'verification failed');
    }
    await withStore(st.id, async (tx) => {
      // FOR UPDATE: serialized with an e-mail change on the same row (see magic-link/request) — never mint a reset
      // link for an address the account has just abandoned.
      const [cust] = await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.email, email)).limit(1).for('update');
      if (!cust) return; // enumeration-safe: no email if no account
      const raw = randomBytes(32).toString('base64url');
      await tx.insert(s.customerToken).values({ storeId: st.id, customerId: cust.id, kind: 'password_reset', tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + TTL_HOURS * 3600 * 1000) });
      const url = `${resolveStorefrontUrl(storeEmailCtx(st))}/password-reset?token=${raw}`;
      // Same txn as the token mint — the email can never outlive a rollback,
      // and the outbox retries delivery instead of dropping it (SR-12).
      await enqueuePasswordReset(tx, st.id, storeEmailCtx(st), email, { url, ttlHours: TTL_HOURS });
    });
    await recordLoginFailure(ip, `forgot:${email}`); // throttle: per-IP+email bucket, not per-account,
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
    responses: { 200: { description: 'OK', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } }, 409: { description: 'Invalid/expired/used', content: { 'application/json': { schema: apiErrorSchema() } } } },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { token, password } = c.req.valid('json');
    const tokenHash = hashToken(token);
    const live = () => and(eq(s.customerToken.tokenHash, tokenHash), eq(s.customerToken.kind, 'password_reset'), gt(s.customerToken.expiresAt, new Date()), isNull(s.customerToken.usedAt));
    // Cheap read first so an unknown token never costs an Argon2 hash; the authoritative claim is below.
    const [probe] = await withStore(st.id, (tx) => tx.select({ id: s.customerToken.id, customerId: s.customerToken.customerId }).from(s.customerToken).where(live()).limit(1));
    if (!probe) return errJson(c, 409, 'TOKEN_INVALID', 'token is invalid, expired, or already used');
    const passwordHash = await hashPassword(password); // outside the transaction (no slow work under row locks)
    const ok = await withStore(st.id, async (tx): Promise<boolean> => {
      // Serialize per customer FIRST (before touching any token row): two resets for the same customer — even with
      // two different tokens — run one after the other, so they can never deadlock on each other's token rows.
      await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.id, probe.customerId)).for('update');
      // ONE transaction: claim the token atomically under that lock (only one request can flip used_at; the claim
      // revalidates expiry/kind/unused), then change the password. A failed claim changes nothing.
      const [row] = await tx.update(s.customerToken).set({ usedAt: new Date() }).where(and(live(), eq(s.customerToken.customerId, probe.customerId)))
        .returning({ id: s.customerToken.id, customerId: s.customerToken.customerId });
      if (!row) return false;
      // Recovery revokes pending identifier changes too. Issuance and consumption
      // take this same customer lock before touching tokens, so neither stale
      // password/session proof nor a pre-reset change link can survive recovery.
      await tx.update(s.customerToken).set({ usedAt: new Date() })
        .where(and(eq(s.customerToken.customerId, row.customerId), inArray(s.customerToken.kind, ['password_reset', EMAIL_CHANGE_KIND]), isNull(s.customerToken.usedAt)));
      await tx.update(s.customer).set({ passwordHash, updatedAt: new Date() }).where(eq(s.customer.id, row.customerId));
      // 0108: a mailbox-proven recovery ends every passkey and every pending passkey authorization (design §4).
      await deleteCustomerPasskeysForRecovery(tx, st.id, row.customerId);
      // Revoke all of this customer's sessions in THIS store. (session is RLS-exempt for token lookup, so
      // filter by storeId explicitly.)
      await tx.delete(s.session).where(and(eq(s.session.customerId, row.customerId), eq(s.session.storeId, st.id)));
      return true;
    });
    if (!ok) return errJson(c, 409, 'TOKEN_INVALID', 'token is invalid, expired, or already used');
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
      409: { description: 'Invalid/expired/used', content: { 'application/json': { schema: apiErrorSchema() } } },
      429: { description: 'Rate limited', content: { 'application/json': { schema: apiErrorSchema() } } },
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
    const retry = await loginRetryAfter(ip, bucket);
    if (retry > 0) return errJson(c, 429, 'RATE_LIMITED', `too many attempts — try again in ${retry}s`);
    const ok = await withStore(st.id, async (tx): Promise<boolean> => {
      const [row] = await tx.select({ id: s.customerToken.id, customerId: s.customerToken.customerId }).from(s.customerToken)
        .where(and(eq(s.customerToken.tokenHash, tokenHash), eq(s.customerToken.kind, 'email_verify'), gt(s.customerToken.expiresAt, new Date()), isNull(s.customerToken.usedAt))).limit(1);
      if (!row) return false;
      // 0108 (design §5): owner first — lock the customer, then claim the token conditionally (a concurrent email
      // change or erasure that won the customer lock already burned it, so the claim finds nothing).
      await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.id, row.customerId)).for('update');
      const claimed = await tx.update(s.customerToken).set({ usedAt: new Date() })
        .where(and(eq(s.customerToken.id, row.id), isNull(s.customerToken.usedAt), gt(s.customerToken.expiresAt, new Date()))).returning({ id: s.customerToken.id });
      if (claimed.length !== 1) return false;
      await tx.update(s.customer).set({ emailVerified: true, updatedAt: new Date() }).where(eq(s.customer.id, row.customerId));
      await grantSignupBonus(tx, st.id, row.customerId); // REWARDS-1: no-op unless the rule is on
      return true;
    });
    if (!ok) { await recordLoginFailure(ip, bucket); return errJson(c, 409, 'TOKEN_INVALID', 'token is invalid, expired, or already used'); }
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
      401: { description: 'Unauthenticated or wrong password', content: { 'application/json': { schema: apiErrorSchema() } } },
      409: { description: 'Email unavailable', content: { 'application/json': { schema: apiErrorSchema() } } },
      429: { description: 'Rate limited', content: { 'application/json': { schema: apiErrorSchema() } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { newEmail: rawNewEmail, password } = c.req.valid('json');
    const newEmail = normalizeEmail(rawNewEmail);
    const ip = clientIp(c);
    // Bound unauthenticated session lookups without a caller-selected account
    // key. The larger IP ceiling allows several customers behind one NAT.
    const ipRetry = await rateLimitBackend().consume('customer-email-change-ip', `${st.id}:${ip}`, 15 * 60 * 1000, 50);
    if (ipRetry > 0) return errJson(c, 429, 'RATE_LIMITED', `too many attempts — try again in ${ipRetry}s`);
    const token = customerToken(c);
    const probe = token ? await withStore(st.id, (tx) => resolveCustomer(tx, token)) : null;
    if (!probe) return errJson(c, 401, 'NOT_AUTHENTICATED', 'not authenticated');
    // Reserve atomically BEFORE password work. Rotating destination addresses
    // cannot reset this validated tenant/customer/IP budget. All rate-limit
    // calls stay outside withStore: the PostgreSQL backend borrows its own connection.
    const credentialRetry = await attemptRetryAfter(ip, `emailchange-customer:${st.id}:${probe.id}`);
    if (credentialRetry > 0) return errJson(c, 429, 'RATE_LIMITED', `too many attempts — try again in ${credentialRetry}s`);
    const bucket = `emailchange:${newEmail}`;
    const retry = await loginRetryAfter(ip, bucket);
    if (retry > 0) return errJson(c, 429, 'RATE_LIMITED', `too many attempts — try again in ${retry}s`);
    // Migrated/OAuth-only accounts must set a password via recovery first.
    // Verify outside the transaction, then bind that proof to the current hash
    // and live session under the same customer-first lock used by recovery.
    const passwordOk = !!probe.passwordHash && await verifyPassword(password, probe.passwordHash);
    const out = !passwordOk ? 'wrong' : await withStore(st.id, async (tx): Promise<'unauth' | 'wrong' | 'same' | 'taken' | 'ok'> => {
      const [row] = await tx.select({ passwordHash: s.customer.passwordHash }).from(s.customer)
        .where(and(eq(s.customer.storeId, st.id), eq(s.customer.id, probe.id))).limit(1).for('update');
      if (!row) return 'unauth';
      const cust = token ? await resolveCustomer(tx, token) : null;
      if (!cust || cust.id !== probe.id) return 'unauth';
      if (row.passwordHash !== probe.passwordHash) return 'wrong';
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
    await recordLoginFailure(ip, bucket); // mailbomb guard for the target address
    if (out === 'unauth') return errJson(c, 401, 'NOT_AUTHENTICATED', 'not authenticated');
    if (out === 'wrong') return errJson(c, 401, 'PASSWORD_INCORRECT', 'password is incorrect');
    if (out === 'same') return errJson(c, 409, 'EMAIL_SAME', 'that is already your email address');
    if (out === 'taken') return errJson(c, 409, 'EMAIL_TAKEN', 'email address is unavailable');
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
      409: { description: 'Invalid/expired/used', content: { 'application/json': { schema: apiErrorSchema() } } },
      429: { description: 'Rate limited', content: { 'application/json': { schema: apiErrorSchema() } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { token } = c.req.valid('json');
    const tokenHash = hashToken(token);
    const ip = clientIp(c);
    const bucket = `verify-change:${ip}`;
    const retry = await loginRetryAfter(ip, bucket);
    if (retry > 0) return errJson(c, 429, 'RATE_LIMITED', `too many attempts — try again in ${retry}s`);
    // Peek the token's customer unlocked to name the lock subject (STOREKIT §5.3).
    // The multi-row order update below runs under {customer, scope:'orders'}; the
    // order ids come from the set's plan and are re-checked under the locks.
    const peeked = await withStore(st.id, async (tx) => {
      const r = await tx.execute(sql`SELECT customer_id AS "customerId" FROM customer_token
        WHERE token_hash = ${tokenHash} AND kind = ${EMAIL_CHANGE_KIND} AND used_at IS NULL AND expires_at > now()`);
      return (r.rows[0] as { customerId: string } | undefined)?.customerId ?? null;
    });
    let out: 'invalid' | 'taken' | 'ok' = 'invalid';
    if (peeked !== null) {
      try {
        out = await withLockedSet(st.id, { kind: 'customer', customerId: peeked, scope: 'orders' }, async (tx, _held, plan): Promise<'invalid' | 'taken' | 'ok'> => {
          // After commerce locks, take the same customer-first order as login,
          // reset and erasure before claiming any token or revoking sessions.
          const [before] = await tx.select({ email: s.customer.email, emailVerified: s.customer.emailVerified }).from(s.customer)
            .where(and(eq(s.customer.storeId, st.id), eq(s.customer.id, peeked))).limit(1).for('update');
          if (!before) return 'invalid';
          // Atomic consume: used_at flips only when the token is still pending —
          // a replayed/second click can never win the UPDATE (single-use).
          const consumed = await tx.execute(sql`UPDATE customer_token SET used_at = now()
            WHERE token_hash = ${tokenHash} AND kind = ${EMAIL_CHANGE_KIND} AND used_at IS NULL AND expires_at > now()
            RETURNING id, customer_id AS "customerId", payload`);
          const row = consumed.rows[0] as { id: string; customerId: string; payload: { newEmail?: string } | null } | undefined;
          if (!row) return 'invalid';
          // The token's customer never changes; a mismatch means the locked set is not the
          // customer whose orders would be updated. Throw to roll back the consume.
          if (row.customerId !== peeked) throw new TokenCustomerMoved();
          const newEmail = normalizeEmail(row.payload?.newEmail ?? '');
          if (!newEmail) return 'invalid';
          // Re-check availability at consume time — another account may have
          // claimed the address since the request was minted.
          const [clash] = await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.email, newEmail)).limit(1);
          if (clash) return 'taken';
          // Capture the OLD address before overwriting it — the security notice
          // below goes to the address being ABANDONED, and it's gone after the
          // UPDATE.
          const oldEmail = before.email;
          // Preserve guest orders whose OLD mailbox was actually proven before
          // changing it. Proving the NEW mailbox must never prove the old one.
          if (before.emailVerified) {
            if (plan.orderIds.length) {
              await tx.update(s.order).set({ metadata: sql`coalesce(${s.order.metadata}, '{}'::jsonb) || '{"linked_via":"verified_email"}'::jsonb` })
                .where(and(inArray(s.order.id, [...plan.orderIds]), eq(s.order.customerId, row.customerId), sql`${s.order.metadata} ->> 'linked_via' = 'email_match'`, orderProvenanceFilter(before)));
            }
          }
          // Burn all outstanding tokens issued under the OLD identifier, including
          // magic links. They cannot authorize the account's new mailbox.
          await tx.execute(sql`UPDATE customer_token SET used_at = now() WHERE customer_id = ${row.customerId} AND used_at IS NULL`);
          // The customer just proved control of the NEW address — verified by construction.
          await tx.update(s.customer).set({ email: newEmail, emailVerified: true, updatedAt: new Date() }).where(eq(s.customer.id, row.customerId));
          // Identifier changed: invalidate all sessions for this account in this
          // store (session is RLS-exempt for token lookup — filter storeId).
          await tx.delete(s.session).where(and(eq(s.session.customerId, row.customerId), eq(s.session.storeId, st.id)));
          // Burn any other pending change links so only the consumed one ever worked.
          await tx.execute(sql`UPDATE customer_token SET used_at = now() WHERE customer_id = ${row.customerId} AND kind = ${EMAIL_CHANGE_KIND} AND used_at IS NULL`);
          await tx.insert(s.auditLog).values({ storeId: st.id, actor: `customer:${row.customerId}`, entity: 'customer', entityId: row.customerId, action: 'email_changed', data: { email: newEmail, previousEmail: oldEmail } });
          // Security notice to the OLD (abandoned) address — unconditional, not
          // gated on session/consent: if a hijacked session made this change,
          // the rightful owner needs to know at the address they can still read.
          if (oldEmail && oldEmail !== newEmail) {
            await enqueueEmailAddressChangedNotice(tx, st.id, storeEmailCtx(st), oldEmail, {
              newEmail,
              dedupeKey: `email-changed-notice:${row.id}`,
        });
      }
      return 'ok';
        });
      } catch (e) {
        if (!(e instanceof TokenCustomerMoved)) throw e;
        out = 'invalid';
      }
    }
    if (out !== 'ok') { await recordLoginFailure(ip, bucket); return errJson(c, 409, 'TOKEN_INVALID', 'token is invalid, expired, or already used'); }
    return c.json({ ok: true }, 200);
  },
);
