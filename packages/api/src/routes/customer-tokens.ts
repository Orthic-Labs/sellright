/**
 * Customer one-time token routes (WP2d). Endpoints: forgot-password,
 * reset-password, verify-email. set_password kind is minted by the
 * migrated-customer activation flow (WP5), not exposed as a public endpoint.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import { type StoreCtx } from '../store-context.js';
import { resolveStoreFromCtx } from './store-context.js';
import * as s from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { normalizeEmail } from '../auth/email.js';
import { sendEmail } from '../email/mailer.js';
import { passwordReset } from '../email/templates.js';
import { clientIp, loginRetryAfter, recordLoginFailure } from '../auth/rate-limit.js';
import { env } from '../env.js';

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
const TTL_HOURS = 2;

function storeCtxForEmail(st: StoreCtx): { name: string; currency: string; storefrontUrl: string; fromEmail: string } {
  return { name: st.name, currency: st.currency, storefrontUrl: env.STOREFRONT_URL, fromEmail: env.SMTP_FROM };
}

export const customerTokens = new OpenAPIHono();

// POST /v1/shop/auth/forgot-password — always 200 (no account enumeration).
customerTokens.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/auth/forgot-password',
    summary: 'Request a password-reset email',
    request: { body: { content: { 'application/json': { schema: z.object({ email: z.string().email() }) } } } },
    responses: { 200: { description: 'Always OK', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } }, 429: { description: 'Rate limited', content: { 'application/json': { schema: z.object({ error: z.string() }) } } } },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { email: rawEmail } = c.req.valid('json');
    const email = normalizeEmail(rawEmail);
    const ip = clientIp(c);
    const retry = loginRetryAfter(ip, `forgot:${email}`);
    if (retry > 0) return c.json({ error: `too many attempts — try again in ${retry}s` }, 429);
    await withStore(st.id, async (tx) => {
      const [cust] = await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.email, email)).limit(1);
      if (!cust) return; // enumeration-safe: no email if no account
      const raw = randomBytes(32).toString('base64url');
      await tx.insert(s.customerToken).values({ storeId: st.id, customerId: cust.id, kind: 'password_reset', tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + TTL_HOURS * 3600 * 1000) });
      const url = `${env.STOREFRONT_URL}/password-reset?token=${raw}`;
      await sendEmail({ to: email, ...passwordReset(storeCtxForEmail(st), { url, ttlHours: TTL_HOURS }) });
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
