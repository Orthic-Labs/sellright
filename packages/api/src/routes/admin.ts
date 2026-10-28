import { assertImportedFinancialReconciliationAllowed, importedFinancialReconciliationRequired, ImportedFinancialReconciliationError } from '../orders/imported-financial-reconciliation.js';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { refundQuantity, refundStockEffectsProjection, refundMerchandiseCompletionProjection } from '../payments/refunds.js';
import { refundUnitBases, refundLineCashAmount, availableCreditRefundUnits, refundCreditProjection } from '../payments/refund-credit.js';
import { readCurrentCreditEvidence } from '../account-credit/service.js';
import { hasUnresolvedPayment } from '../payments/hold.js';
import { assertNoPendingOrderEdit } from '../orders/edit-stage.js';
import { OrderEditError } from '../orders/order-edit.js';
import { errJson } from '../lib/api-error.js';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { withAdvisoryLock, withStore } from '../db/client.js';
import { withLockedSet, orderIdByCode } from '../db/locks.js';
import * as s from '../db/schema.js';
import { cancelOrderStripeIntents, stripeDiscoverable } from '../payments/stripe-reconcile.js';
import { release } from '../payments/reservation.js';
import { releaseOrderLoyalty } from '../loyalty/ledger.js';
import { bearer } from '../auth/session.js';
import { ADMIN_PASSWORD_MIN, hashPassword, passwordNeedsRehash, verifyPassword, verifyPasswordAgainstDummy } from '../auth/password.js';
import { createAdminSessionIfCredential, deleteAdminSession, findAdminByEmail, rehashAdminPasswordIfUnchanged, resolveAdmin } from '../auth/admin-session.js';
import { adminAuthFacts, adminMailStore, adminPasskeyCount, attemptLoginChallenge, issueLoginChallenge, redeemLoginChallenge, issuePasswordReset, adminPasskeyLabels, LOGIN_CHALLENGE_TTL_SECONDS, PASSWORD_RESET_TTL_SECONDS, peekLoginChallenge, peekPasswordReset, redeemPasswordReset } from '../auth/admin-auth-challenge.js';
import { sendAdminPasswordReset } from '../email/dispatch.js';
import { resolveStoreFromCtx } from './store-context.js';
import { storeIdentityFromConfig } from './store-identity.js';
import { isStorePublished } from '../store-publish.js';
import { adminPublicUrl } from '../env.js';
import { log } from '../lib/logger.js';
import { secondFactorEnrollmentRequired } from '../auth/mfa-policy.js';
import type { Context } from 'hono';
import { canTransition, type OrderState } from '../money/fsm.js';
import { HttpError, J, errBody, requireAdmin, requireStore, requireWrite, requirePermission, guard, Page } from './admin-helpers.js';
import { clientIp, reserveAdminAuthAttempt, reserveAdminSecondStepAttempt, reserveAdminResetRequest, reserveAdminResetTokenUse, clearAdminAuthFailures } from '../auth/rate-limit.js';
import { setAuthCookies, clearAuthCookies, newCsrf, cookie, csrfValid, SESSION_COOKIE } from '../auth/cookies.js';
import { verifyLoginFactor } from '../auth/second-factor.js';
import { normalizeEmail } from '../auth/email.js';
import { enqueueShippingNotification } from '../email/dispatch.js';
import { resolveOrderRecipient } from '../orders/recipient.js';
import { orderContact, orderContactSql, orderSearchSql } from '../orders/contact.js';
import { emitEvent } from '../webhooks/emit.js';
import { onStockChanged } from '../manifest/stock-hook.js';
import { amountDueForOrder } from '../payments/settle.js';
import { deriveFulfillmentStatus, derivePaymentStatus, wirePaymentState } from '../orders/status.js';
import { variantShippingLabel } from '../lib/shipping-label.js';
import { ORDER_TABS, orderTabSql, openQtySql, openPreOrderQtySql, shippedQtySql } from '../orders/tabs-sql.js';
import { fulfillmentStatusSql, paymentStatusWithBalanceSql } from '../orders/status-sql.js';
import { orderAttribution } from '../orders/attribution.js';
import { orderLineLabel } from '../orders/line-label.js';

export const admin = new OpenAPIHono();

const StoreAccess = z.object({ storeId: z.string(), slug: z.string(), name: z.string(), currency: z.string(), role: z.string() });

// ── auth: login / logout / me ─────────────────────────────────────────────
const LoginOk = z.object({
  token: z.string().optional(), csrfToken: z.string().optional(), totpEnrollmentRequired: z.boolean().optional(),
  admin: z.object({ email: z.string() }).optional(), stores: z.array(StoreAccess).optional(),
  // Issue #333 step 1 for an account with a second factor: no session, a short-lived single-use challenge instead.
  twoFactorRequired: z.boolean().optional(), challengeToken: z.string().optional(), expiresInSeconds: z.number().int().optional(),
  methods: z.array(z.enum(['totp', 'passkey', 'recovery_code'])).optional(),
});
const BAD_LOGIN = 'invalid email or password';
/** 429 with a Retry-After header and `retryAfterSeconds` in the body, so the sign-in screen can count down. */
function rateLimited(c: Context, retry: number, what: 'attempts' | 'requests'): HttpError {
  c.header('Retry-After', String(retry));
  return new HttpError(429, `too many ${what} — try again in ${retry}s`, 'RATE_LIMITED', undefined, { retryAfterSeconds: retry });
}
const BAD_LOGIN_WITH_CODE = 'invalid email, password, or 2FA code';
const CHALLENGE_DEAD = 'your sign-in expired — enter your password again';

/** Shared success tail of every sign-in: httpOnly session cookie + CSRF cookie, the account's stores. */
async function signedIn(c: Context, token: string, email: string, returnToken: boolean | undefined) {
  const csrf = newCsrf();
  setAuthCookies(c, token, csrf); // httpOnly session cookie + CSRF cookie
  const principal = await resolveAdmin(token);
  // P1b / #333: when policy requires a second factor and none is enrolled, the session can only enrol (admin-agent-guard).
  const totpEnrollmentRequired = secondFactorEnrollmentRequired(principal);
  // P2: the session token is in the httpOnly cookie; it is only echoed in the body for an explicit API client
  // (`returnToken: true`), so page script (or an XSS) in a cookie client never sees it.
  return c.json({ ...(returnToken === true ? { token } : {}), csrfToken: csrf, admin: { email }, stores: principal?.stores ?? [], ...(totpEnrollmentRequired ? { totpEnrollmentRequired } : {}) }, 200);
}

admin.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/login', summary: 'Admin login, step 1 (email + password). An account with a second factor gets a single-use challenge for POST /v1/admin/login/2fa, never a session',
    request: { body: { content: J(z.object({ email: z.string().email(), password: z.string().max(1024),
      // Single-request form for API clients: the code travels with the password (no challenge is issued).
      totp: z.string().max(64).optional(),
      // P2: explicit API clients ask for the bearer token in the body; browser (cookie) clients never get it.
      returnToken: z.boolean().optional() })) } },
    responses: {
      200: { description: 'Signed in, or (twoFactorRequired) the password was right and the code step follows', content: J(LoginOk) },
      401: { description: 'Invalid', ...errBody },
      429: { description: 'Too many attempts', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { email: rawEmail, password, totp, returnToken } = c.req.valid('json');
    const email = normalizeEmail(rawEmail);
    const ip = clientIp(c);
    const bad = totp ? BAD_LOGIN_WITH_CODE : BAD_LOGIN; // depends only on the request shape, never on the account
    // P1a: (ip, account) + per-account (all IPs) + per-IP (all accounts) budgets.
    const retry = await reserveAdminAuthAttempt(ip, email);
    if (retry > 0) throw rateLimited(c, retry, 'attempts');
    const u = await findAdminByEmail(email);
    // P1a: an unknown address (or an agent identity) still pays one full Argon2id
    // verification, so timing does not reveal which admin e-mails exist. Unknown e-mail and wrong password answer the
    // same generic 401.
    const passwordOk = u && u.kind !== 'agent' && u.passwordHash ? await verifyPassword(password, u.passwordHash) : await verifyPasswordAgainstDummy(password);
    if (!u || !passwordOk) { throw new HttpError(401, bad, 'INVALID_CREDENTIALS'); }
    // Issue #333 (supersedes WP1.5's single-request rule for browsers): the second step is revealed only AFTER the
    // password verified, so it tells nothing to anyone without the password; both steps spend the same budgets, and the
    // password-guessing budgets are cleared only when the whole sign-in succeeds.
    const passkeys = await adminPasskeyCount(u.id);
    const hasSecondFactor = !!u.totpSecret || passkeys > 0;
    if (hasSecondFactor && !totp) {
      let verifiedHash = u.passwordHash!;
      if (passwordNeedsRehash(verifiedHash)) {
        // Best-effort, conditional on the hash still being the one just verified; the challenge binds the result.
        try { const next = await hashPassword(password); if (await rehashAdminPasswordIfUnchanged(u.id, verifiedHash, next)) verifiedHash = next; } catch { /* next sign-in */ }
      }
      const challengeToken = await issueLoginChallenge(u.id, verifiedHash, u.securityEpoch);
      const methods = [...(u.totpSecret ? ['totp' as const] : []), ...(passkeys > 0 ? ['passkey' as const] : []), 'recovery_code' as const];
      return c.json({ twoFactorRequired: true, challengeToken, expiresInSeconds: LOGIN_CHALLENGE_TTL_SECONDS, methods }, 200);
    }
    let receipt: { id: string; usedAt: Date } | undefined;
    if (hasSecondFactor) {
      // P1b: a 6-digit TOTP code or a one-time recovery code (consumed on success; 0108: its receipt is re-checked
      // under the owner lock so a code from a replaced set cannot sign in).
      const factor = await verifyLoginFactor(u.id, u.totpSecret, totp);
      if (!factor.ok) { throw new HttpError(401, bad, 'INVALID_CREDENTIALS'); }
      receipt = factor.receipt;
    }
    await clearAdminAuthFailures(ip, email);
    // Upgrade a legacy hash (pre-Argon2id scrypt — e.g. RightSites admins — or outdated Argon2 parameters)
    // now that the plaintext has just been verified. Best-effort: a failure never blocks the sign-in.
    // 0108: the rehash is applied INSIDE the session transaction, after the credential snapshot is re-checked.
    let rehashTo: string | undefined;
    if (passwordNeedsRehash(u.passwordHash!)) {
      try { rehashTo = await hashPassword(password); } catch { /* retried on the next sign-in */ }
    }
    // The session is created only if the password verified above is still the account's password (P1b review).
    const token = await createAdminSessionIfCredential(u.id, u.passwordHash!, hasSecondFactor, { epoch: u.securityEpoch, totpVersion: u.totpVersion, receipt, rehashTo });
    if (!token) throw new HttpError(401, bad, 'INVALID_CREDENTIALS');
    return signedIn(c, token, u.email, returnToken);
  }),
);

admin.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/login/2fa', summary: 'Admin login, step 2: redeem the step-1 challenge once with a TOTP or recovery code',
    request: { body: { content: J(z.object({ challengeToken: z.string().min(16).max(128), code: z.string().min(1).max(64), returnToken: z.boolean().optional() })) } },
    responses: {
      200: { description: 'Signed in', content: J(LoginOk) },
      401: { description: 'INVALID_CODE (try again), LOGIN_CHALLENGE_EXHAUSTED or LOGIN_CHALLENGE_EXPIRED (start over with the password)', ...errBody },
      429: { description: 'Too many attempts', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { challengeToken, code, returnToken } = c.req.valid('json');
    const ip = clientIp(c);
    const peek = await peekLoginChallenge(challengeToken);
    const owner = peek ? await adminAuthFacts(peek.adminUserId) : null;
    // Same three admin budgets as step 1 (a dead token spends only the per-IP budget).
    const retry = await reserveAdminSecondStepAttempt(ip, owner?.email ?? null);
    if (retry > 0) throw rateLimited(c, retry, 'attempts');
    if (!owner || owner.kind !== 'human') throw new HttpError(401, CHALLENGE_DEAD, 'LOGIN_CHALLENGE_EXPIRED');
    const attempt = await attemptLoginChallenge(challengeToken);
    if (!attempt.ok) {
      if (attempt.reason === 'exhausted') throw new HttpError(401, 'too many incorrect codes — enter your password again', 'LOGIN_CHALLENGE_EXHAUSTED');
      throw new HttpError(401, CHALLENGE_DEAD, 'LOGIN_CHALLENGE_EXPIRED');
    }
    // Claim + factor + session in ONE transaction under the owner lock (auth/admin-auth-challenge.ts).
    const r = await redeemLoginChallenge(challengeToken, owner.id, code);
    if (!r.ok) {
      if (r.reason === 'invalid_code') throw new HttpError(401, 'that code didn\'t work — check your authenticator app and try again', 'INVALID_CODE');
      throw new HttpError(401, CHALLENGE_DEAD, 'LOGIN_CHALLENGE_EXPIRED');
    }
    const token = r.sessionToken;
    await clearAdminAuthFailures(ip, owner.email);
    return signedIn(c, token, owner.email, returnToken);
  }),
);

// ── auth screens: store branding + forgot / reset password (issue #333) ───────
const HEX = /^#[0-9a-fA-F]{6}$/;
const FAMILY = /^[A-Za-z0-9 ,'"-]{1,160}$/;
const FONT_URL = /^\/[A-Za-z0-9/._-]{1,200}\.woff2$/; // same-origin path only (admin CSP: font-src 'self')
const Branding = z.object({
  storeName: z.string().nullable(), logoUrl: z.string().nullable(),
  theme: z.object({ primary: z.string(), background: z.string(), surface: z.string(), text: z.string(), textMuted: z.string(), border: z.string(),
    fontDisplay: z.string().nullable(), fontBody: z.string().nullable(),
    /** identity.fonts.logo: the typeface of the store's wordmark (shown next to a logo image only when set). */
    fontLogo: z.string().nullable() }).nullable(),
  fontFaces: z.array(z.object({ family: z.string(), url: z.string(), weight: z.string(), style: z.enum(['normal', 'italic']) })),
});
type BrandingT = z.infer<typeof Branding>;
const NEUTRAL_BRANDING: BrandingT = { storeName: null, logoUrl: null, theme: null, fontFaces: [] };

/** Store identity for the sign-in screens, from store.config.identity (the store's own design tokens: colors, fonts,
 *  logo; `identity.fontFaces` lists same-origin .woff2 files). Only display facts; every value is validated so a bad
 *  config cannot inject CSS. An unpublished store, an unknown host or a malformed value answers the neutral default. */
export function brandingFromStore(st: { name: string; currency: string; config: unknown }): BrandingT {
  if (!isStorePublished(st.config)) return NEUTRAL_BRANDING;
  const raw = ((st.config ?? {}) as { identity?: Record<string, unknown> }).identity ?? {};
  const id = storeIdentityFromConfig(st, true);
  // A store has a theme once it set its own primary colour; the identity module's neutral fallbacks are not a theme.
  const colorsSet = !!raw.colors && typeof raw.colors === 'object' && typeof (raw.colors as Record<string, unknown>).primary === 'string';
  const c = id.colors;
  const allHex = [c.primary, c.background, c.surface, c.text, c.textMuted, c.border].every((v) => HEX.test(v));
  const fontsIn = (raw.fonts ?? {}) as Record<string, unknown>;
  const family = (v: unknown) => (typeof v === 'string' && FAMILY.test(v) ? v : null);
  const faces = Array.isArray(raw.fontFaces) ? raw.fontFaces : [];
  const logo = id.logoImageUrl && /^(https:\/\/|\/)[^\s"'()<>]{1,500}$/.test(id.logoImageUrl) ? id.logoImageUrl : null;
  return {
    storeName: id.storeName,
    logoUrl: logo,
    theme: colorsSet && allHex ? { primary: c.primary, background: c.background, surface: c.surface, text: c.text, textMuted: c.textMuted, border: c.border,
      fontDisplay: family(fontsIn.display), fontBody: family(fontsIn.body), fontLogo: family(fontsIn.logo) } : null,
    fontFaces: faces.flatMap((f) => {
      const x = (f ?? {}) as Record<string, unknown>;
      const ok = typeof x.family === 'string' && FAMILY.test(x.family) && typeof x.url === 'string' && FONT_URL.test(x.url) && !x.url.includes('..');
      if (!ok) return [];
      const weight = typeof x.weight === 'string' && /^\d{3}( \d{3})?$/.test(x.weight) ? x.weight : '400';
      return [{ family: x.family as string, url: x.url as string, weight, style: x.style === 'italic' ? 'italic' as const : 'normal' as const }];
    }).slice(0, 12),
  };
}

admin.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/branding', summary: 'Pre-session: the store identity shown on the admin sign-in screens (name, logo, theme tokens) for the resolved host',
    responses: { 200: { description: 'OK (neutral default for an unknown host or an unpublished store)', content: J(Branding) } },
  }),
  async (c) => {
    let out = NEUTRAL_BRANDING;
    try { out = brandingFromStore(await resolveStoreFromCtx(c)); } catch { /* unknown host / store: neutral */ }
    c.header('cache-control', 'no-store');
    return c.json(out, 200);
  },
);

admin.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/password/forgot', summary: 'Pre-session: e-mail a single-use admin password reset link. Always the same answer, whether or not the address has an account',
    request: { body: { content: J(z.object({ email: z.string().email().max(320) })) } },
    responses: { 200: { description: 'Accepted', content: J(z.object({ ok: z.boolean() })) }, 429: { description: 'Too many requests', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const email = normalizeEmail(c.req.valid('json').email);
    const retry = await reserveAdminResetRequest(clientIp(c), email);
    if (retry > 0) throw rateLimited(c, retry, 'requests');
    let hostStoreId: string | null = null;
    try { hostStoreId = (await resolveStoreFromCtx(c)).id; } catch { /* unknown host: the admin's own store mails it */ }
    // No enumeration: the lookup, token and mail run after the response is decided, off the request path, so the answer
    // and its timing are the same for every address.
    void (async () => {
      const u = await findAdminByEmail(email);
      if (!u || u.kind === 'agent') return;
      const store = await adminMailStore(u.id, hostStoreId);
      if (!store) return;
      const token = await issuePasswordReset(u.id, u.passwordHash, u.securityEpoch);
      const r = await sendAdminPasswordReset({ name: store.name, currency: store.currency, config: store.config, storeId: store.id }, u.email,
        { url: `${adminPublicUrl()}/reset-password?token=${encodeURIComponent(token)}`, ttlMinutes: PASSWORD_RESET_TTL_SECONDS / 60, passkeys: await adminPasskeyLabels(u.id) });
      if (!r.delivered) log.warn('admin_password_reset_not_delivered', { adminId: u.id, reason: r.reason });
    })().catch((e) => log.warn('admin_password_reset_failed', { error: e instanceof Error ? e.message : String(e) }));
    return c.json({ ok: true }, 200);
  }),
);

admin.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/password/reset/check', summary: 'Pre-session: is this reset link still usable? (the reset screen shows the form only for a live link)',
    request: { body: { content: J(z.object({ token: z.string().min(1).max(128) })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ valid: z.boolean() })) }, 429: { description: 'Too many attempts', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { token } = c.req.valid('json');
    const retry = await reserveAdminResetTokenUse(clientIp(c));
    if (retry > 0) throw rateLimited(c, retry, 'attempts');
    return c.json({ valid: !!(await peekPasswordReset(token)) }, 200);
  }),
);

admin.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/password/reset', summary: 'Pre-session: set a new admin password with a reset link token (single use); bumps the security epoch, signs out every session, puts passkeys under review. 2FA is unchanged',
    request: { body: { content: J(z.object({ token: z.string().min(16).max(128), password: z.string().min(ADMIN_PASSWORD_MIN).max(256) })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) }, 400: { description: 'RESET_INVALID', ...errBody }, 429: { description: 'Too many attempts', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { token, password } = c.req.valid('json');
    const retry = await reserveAdminResetTokenUse(clientIp(c));
    if (retry > 0) throw rateLimited(c, retry, 'attempts');
    const invalid = () => new HttpError(400, 'this reset link is invalid or has expired — ask for a new one', 'RESET_INVALID');
    if (!(await peekPasswordReset(token))) throw invalid();
    const done = await redeemPasswordReset(token, await hashPassword(password));
    if (!done) throw invalid();
    log.info('admin_password_reset', { adminId: done.adminUserId });
    return c.json({ ok: true }, 200);
  }),
);

admin.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/logout', summary: 'Admin logout',
    responses: {
      200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) },
      403: { description: 'CSRF', ...errBody },
    },
  }),
  async (c) => {
    if (!csrfValid(c)) return errJson(c, 403, 'CSRF_INVALID', 'invalid CSRF token');
    const token = bearer(c.req.header('authorization')) ?? cookie(c, SESSION_COOKIE);
    if (token) await deleteAdminSession(token);
    clearAuthCookies(c);
    return c.json({ ok: true }, 200);
  },
);

admin.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/me', summary: 'Current admin + accessible stores',
    responses: {
      200: { description: 'OK', content: J(z.object({ email: z.string(), isInstallationAdmin: z.boolean(), kind: z.enum(['human', 'agent']), auth: z.enum(['session', 'api_token']), stores: z.array(StoreAccess), totpEnabled: z.boolean(), passkeyEnabled: z.boolean(), passkeyReviewRequired: z.boolean(), totpEnrollmentRequired: z.boolean() })) },
      401: { description: 'Unauthorized', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    return c.json({ email: admin.email, isInstallationAdmin: admin.isInstallationAdmin, kind: admin.kind, auth: admin.auth, stores: admin.stores, totpEnabled: admin.totpEnabled === true, passkeyEnabled: admin.passkeyEnabled === true, passkeyReviewRequired: admin.passkeyReviewRequired === true, totpEnrollmentRequired: secondFactorEnrollmentRequired(admin) }, 200);
  }),
);

// ── orders: list / detail / fulfill / cancel ────────────────────────────────
admin.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/orders', summary: 'List orders',
    request: { query: z.object({
      state: z.string().optional(), q: z.string().optional(), preOrder: z.coerce.boolean().optional(), excludeDemo: z.enum(['1']).optional(), trashed: z.coerce.boolean().default(false),
      // Wire-facing status filters (BREAKING, pre-1.0 — see CHANGELOG.md), on
      // top of the legacy combined `state` filter above.
      // 'active' = open + completed (the owner-facing "Open": not cancelled, not archived).
      status: z.enum(['open', 'completed', 'cancelled', 'archived', 'active']).optional(),
      // Inclusive YYYY-MM-DD bounds (UTC) on the order date (placed, else created).
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      paymentStatus: z.enum(['pending', 'authorized', 'paid', 'partially_refunded', 'refunded', 'voided', 'failed', 'balance_due']).optional(),
      shippingMethod: z.string().max(120).optional(), // shipping_method_code; '__none__' = no recorded method
      fulfillmentStatus: z.enum(['unfulfilled', 'partially_fulfilled', 'fulfilled', 'partially_delivered', 'delivered']).optional(),
      // #406 admin tabs (orders/tabs-sql.ts); counts per tab come from /v1/admin/orders/tab-counts.
      tab: z.enum(ORDER_TABS).optional(),
      page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
    }) },
    responses: { 200: { description: 'OK', content: J(Page) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { state, q, preOrder, excludeDemo, trashed, status, paymentStatus, shippingMethod, fulfillmentStatus, tab, from, to, page, pageSize } = c.req.valid('query');
    const out = await withStore(st.storeId, async (tx) => {
      const conds = [] as ReturnType<typeof eq>[];
      // Trash filter FIRST: ?trashed=1 shows ONLY soft-deleted orders; default
      // shows only live ones. Without this, trashed orders leak into every list.
      conds.push((trashed ? sql`${s.order.deletedAt} is not null` : sql`${s.order.deletedAt} is null`) as never);
      if (excludeDemo === '1') conds.push(eq(s.order.isDemo, false) as never);
      if (state) conds.push(sql`${s.order.state} = ${state}` as never);
      if (status === 'active') conds.push(sql`${s.order.status} in ('open', 'completed')` as never);
      else if (status) conds.push(eq(s.order.status, status) as never);
      if (from) conds.push(sql`coalesce(${s.order.placedAt}, ${s.order.createdAt}) >= ${`${from}T00:00:00Z`}::timestamptz` as never);
      if (to) conds.push(sql`coalesce(${s.order.placedAt}, ${s.order.createdAt}) < (${`${to}T00:00:00Z`}::timestamptz + interval '1 day')` as never);
      if (paymentStatus) conds.push(sql`${paymentStatusWithBalanceSql()} = ${paymentStatus}` as never);
      if (shippingMethod) conds.push((shippingMethod === '__none__' ? sql`${s.order.shippingMethodCode} is null` : eq(s.order.shippingMethodCode, shippingMethod)) as never);
      if (fulfillmentStatus) conds.push(sql`${fulfillmentStatusSql()} = ${fulfillmentStatus}` as never);
      if (preOrder) conds.push(eq(s.order.isPreOrder, true) as never);
      if (tab) conds.push(orderTabSql(tab) as never);
      if (q) conds.push(orderSearchSql(q, 'customer') as never);
      const where = conds.length ? and(...conds) : undefined;
      const contactSql = orderContactSql('customer');
      const base = tx
        .select({
          code: s.order.code, state: s.order.state, status: s.order.status,
          paymentStatus: paymentStatusWithBalanceSql(), shippingMethodName: s.order.shippingMethodName, fulfillmentStatus: fulfillmentStatusSql(),
          isPreOrder: s.order.isPreOrder, grandTotal: s.order.grandTotal, currency: s.order.currency, placedAt: s.order.placedAt, createdAt: s.order.createdAt,
          // #374: a guest order (no linked customer) shows its own checkout contact.
          email: contactSql.email, customerName: contactSql.name,
          firstName: s.customer.firstName, lastName: s.customer.lastName,
          openQty: openQtySql(), openPreOrderQty: openPreOrderQtySql(), shippedQty: shippedQtySql(),
        })
        .from(s.order)
        .leftJoin(s.customer, eq(s.customer.id, s.order.customerId))
        .$dynamic();
      const rows = await (where ? base.where(where) : base)
        .orderBy(desc(sql`coalesce(${s.order.placedAt}, ${s.order.createdAt})`))
        .limit(pageSize).offset((page - 1) * pageSize);
      const cntBase = tx.select({ n: sql<number>`count(*)::int` }).from(s.order).leftJoin(s.customer, eq(s.customer.id, s.order.customerId)).$dynamic();
      const [cnt] = await (where ? cntBase.where(where) : cntBase);
      return {
        items: rows.map((r) => ({ ...r, placedAt: r.placedAt ? r.placedAt.toISOString() : null, createdAt: r.createdAt.toISOString() })),
        total: cnt?.n ?? 0, page, pageSize,
      };
    });
    return c.json(out, 200);
  }),
);

// #406: per-tab counts for the admin orders list, from the same predicates as ?tab=, so tab counts and rows agree.
admin.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/orders/tab-counts', summary: 'Order counts per admin tab',
    request: { query: z.object({ excludeDemo: z.enum(['1']).optional() }) },
    responses: { 200: { description: 'OK', content: J(z.object({ ...Object.fromEntries(ORDER_TABS.map((t) => [t, z.number()])), all: z.number() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { excludeDemo } = c.req.valid('query');
    const out = await withStore(st.storeId, async (tx) => {
      const live = excludeDemo === '1' ? sql`${s.order.deletedAt} is null and ${s.order.isDemo} = false` : sql`${s.order.deletedAt} is null`;
      const cols = Object.fromEntries(ORDER_TABS.map((t) => [t, sql<number>`(count(*) filter (where ${orderTabSql(t)}))::int`]));
      const [row] = await tx.select({ ...cols, all: sql<number>`count(*)::int` }).from(s.order).where(live);
      return row as Record<string, number>;
    });
    return c.json(out as never, 200);
  }),
);

admin.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/orders/{code}', summary: 'Order detail',
    request: { params: z.object({ code: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.any()) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { code } = c.req.valid('param');
    const out = await withStore(st.storeId, async (tx) => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1);
      if (!o) return null;
      const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
      // #406: per-line pre-order flag + ship label from the variant (current), for the order page's Pre-order card.
      const lineVariantIds = [...new Set(lines.map((l) => l.variantId).filter((v): v is string => !!v))];
      const preOrderByVariant = new Map((lineVariantIds.length ? await tx.select({ id: s.productVariant.id, isPreOrder: s.productVariant.isPreOrder, metafields: s.productVariant.metafields })
        .from(s.productVariant).where(inArray(s.productVariant.id, lineVariantIds)) : []).map((v) => [v.id, v]));
      const payments = await tx.select().from(s.payment).where(eq(s.payment.orderId, o.id)).orderBy(desc(s.payment.createdAt));
      const postedCredit = await tx.select({ id: s.accountCreditTransaction.id }).from(s.accountCreditTransaction).where(and(
        eq(s.accountCreditTransaction.orderId, o.id), eq(s.accountCreditTransaction.kind, 'REDEEM'), eq(s.accountCreditTransaction.status, 'POSTED')));
      const fulfillments = await tx.select().from(s.fulfillment).where(eq(s.fulfillment.orderId, o.id)).orderBy(desc(s.fulfillment.createdAt));
      const fulfillmentLines = fulfillments.length
        ? await tx.select().from(s.fulfillmentLine).where(inArray(s.fulfillmentLine.fulfillmentId, fulfillments.map((f) => f.id)))
        : [];
      const refunds = await tx.select().from(s.refund).where(eq(s.refund.orderId, o.id)).orderBy(desc(s.refund.createdAt));
      const refundLines = refunds.length
        ? await tx.select().from(s.refundLine).where(inArray(s.refundLine.refundId, refunds.map((r) => r.id)))
        : [];
      const refundQuotes = new Map<string, { unitPrice: number | null; cashAmounts: number[]; quantity: number; totalQuantity: number }>();
      try {
        const evidence = await readCurrentCreditEvidence(tx, { storeId: st.storeId, orderId: o.id });
        const units = refundUnitBases(o, lines, evidence ?? undefined, evidence?.pricingSources);
        const reserved = refunds.filter(refund => refund.state !== 'Failed').map(refund => {
          const selected = refundLines.filter(line => line.refundId === refund.id);
          const projection = refundCreditProjection(refund.metadata);
          return { metadata: refund.metadata, state: refund.state, lines: selected,
            restored: projection?.state === 'posted' || projection?.state === 'not_applicable' ||
              selected.every(line => evidence?.history.some(row => row.refundId === refund.id && row.orderLineId === line.orderLineId)) };
        });
        const eligible = evidence ? availableCreditRefundUnits(o, lines, evidence, reserved, evidence.pricingSources) : null;
        for (const line of lines) {
          const quantity = eligible?.get(line.id)?.length ?? Math.max(0, refundQuantity(line) - reserved.reduce((sum, refund) =>
            sum + refund.lines.filter(item => item.orderLineId === line.id).reduce((n, item) => n + item.quantity, 0), 0));
          const basis = units.get(line.id) ?? null;
          const positions = eligible?.get(line.id);
          const available = Array.isArray(basis) && positions ? positions.map(position => basis[position]!) : basis;
          const cashAmounts = Array.from({ length: quantity }, (_, index) => refundLineCashAmount(line, index + 1, available, postedCredit.length > 0));
          const first = cashAmounts[0];
          const uniform = first !== undefined && cashAmounts.every((amount, index) => amount === first * (index + 1));
          refundQuotes.set(line.id, { unitPrice: uniform ? first : null, cashAmounts, quantity,
            totalQuantity: Array.isArray(basis) ? basis.length : refundQuantity(line) });
        }
      } catch { /* Read remains available; refund admission refuses unproven money. */ }
      // Locations feed the partial-fulfillment picker — enabled-only, this
      // store's own set (a single-location store still gets its default row).
      const locations = await tx.select({ id: s.location.id, name: s.location.name, code: s.location.code, isDefault: s.location.isDefault })
        .from(s.location).where(and(eq(s.location.storeId, st.storeId), eq(s.location.enabled, true))).orderBy(desc(s.location.isDefault));
      const events = await tx.select().from(s.auditLog).where(and(eq(s.auditLog.entity, 'order'), eq(s.auditLog.entityId, o.id))).orderBy(desc(s.auditLog.at)).limit(50);
      let customer = null as null | { id: string; email: string; firstName: string | null; lastName: string | null; phone: string | null };
      if (o.customerId) {
        const [cu] = await tx.select({ id: s.customer.id, email: s.customer.email, firstName: s.customer.firstName, lastName: s.customer.lastName, phone: s.customer.phone }).from(s.customer).where(eq(s.customer.id, o.customerId)).limit(1);
        customer = cu ?? null;
      }
      // Order editing (G13): what the customer still owes after an edit (+) or is
      // owed back (-); a positive amount reads as paymentStatus `balance_due`.
      const amountDue = importedFinancialReconciliationRequired(o.metadata) ? null : await amountDueForOrder(tx, st.storeId, o.id, o.grandTotal);
      const adjustments = await tx.select().from(s.orderAdjustment).where(eq(s.orderAdjustment.orderId, o.id));
      const paymentStatus = derivePaymentStatus(o.state, payments, amountDue);
      const fulfillmentStatus = deriveFulfillmentStatus(lines, fulfillments);
      return {
        amountDue, shippingOverride: o.shippingOverride,
        shippingMethodCode: o.shippingMethodCode, shippingMethodName: o.shippingMethodName,
        adjustments: adjustments.map((a) => ({ id: a.id, label: a.label, amount: a.amount })),
        code: o.code, state: o.state, status: o.status, paymentStatus, fulfillmentStatus, isPreOrder: o.isPreOrder, currency: o.currency,
        subtotal: o.subtotal, discountTotal: o.discountTotal, shippingTotal: o.shippingTotal, taxTotal: o.taxTotal, grandTotal: o.grandTotal,
        placedAt: o.placedAt ? o.placedAt.toISOString() : null, createdAt: o.createdAt.toISOString(),
        // Landing attribution the storefront sent at checkout (UTM + oppref), or null. A browser claim, display only.
        attribution: orderAttribution(o.metadata),
        shippingAddress: o.shippingAddress ?? null, billingAddress: admin.kind === 'agent' ? null : (o.billingAddress ?? null), // D6: billing address stripped for agents
        customer,
        // #374: the order's own checkout contact; the admin shows it when no customer is linked (guest checkout).
        contact: orderContact(admin.kind === 'agent' ? { metadata: o.metadata, shippingAddress: o.shippingAddress } : o), // D6: no billing fallback for agents
        // `id` is the order_line id the refund/return endpoints key their
        // `lines[].orderLineId` on — without it no consumer of this response can
        // build a per-line refund.
        hasPostedCredit: postedCredit.length === 1,
        lines: lines.map((l) => ({ refundQuantity: refundQuotes.get(l.id)?.totalQuantity ?? refundQuantity(l),
          refundUnitPrice: refundQuotes.get(l.id)?.unitPrice ?? null, refundCashAmounts: refundQuotes.get(l.id)?.cashAmounts ?? null,
          refundAvailableQuantity: refundQuotes.get(l.id)?.quantity ?? 0,
          id: l.id, sku: l.variantSku, name: orderLineLabel(l), quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.lineTotal, fulfilledQty: l.fulfilledQty, cancelledQty: l.cancelledQty, refundedQty: l.refundedQty,
          isPreOrder: (l.variantId && preOrderByVariant.get(l.variantId)?.isPreOrder) === true, shipDateLabel: l.variantId ? variantShippingLabel(preOrderByVariant.get(l.variantId)?.metafields) : null })),
        // `state` here is the individual PAYMENT record's wire state (Settled
        // -> captured — BREAKING, pre-1.0), distinct from the order-level
        // `paymentStatus` above. See orders/status.ts.
        payments: payments.map((p) => ({ id: p.id, method: p.method, amount: p.amount, state: wirePaymentState(p.state), providerRef: p.providerRef, createdAt: p.createdAt.toISOString() })),
        fulfillments: fulfillments.map((f) => ({
          id: f.id, state: f.state, trackingCode: f.trackingCode, carrier: f.carrier,
          locationId: f.locationId, notifyCustomer: f.notifyCustomer, createdAt: f.createdAt.toISOString(),
          lines: fulfillmentLines.filter((fl) => fl.fulfillmentId === f.id).map((fl) => ({ orderLineId: fl.orderLineId, quantity: fl.quantity })),
        })),
        // Per-line refund history: amount + restock so the admin can see
        // exactly what was refunded/restocked, not just a lump order-level sum.
        refunds: refunds.map((r) => ({
          id: r.id, state: r.state, amount: r.amount, itemsAmount: r.itemsAmount, shippingAmount: r.shippingAmount,
          creditRestoration: refundCreditProjection(r.metadata),
          stockEffects: refundStockEffectsProjection(r.metadata),
          merchandiseCompletion: refundMerchandiseCompletionProjection(r.metadata),
          reason: r.reason, createdAt: r.createdAt.toISOString(),
          lines: refundLines.filter((rl) => rl.refundId === r.id).map((rl) => ({ orderLineId: rl.orderLineId, quantity: rl.quantity, amount: rl.amount, restock: rl.restock })),
        })),
        locations: locations.map((l) => ({ id: l.id, name: l.name, code: l.code, isDefault: l.isDefault })),
        // `data` carries internal-note text (action === 'note') and the order-edit
        // summary (edit / edit_address / record_payment / edit_refund) — everything
        // else ignores it. Reusing audit_log keeps notes in the SAME timeline
        // as every other order event instead of a second, disconnected feed.
        events: events.map((e) => ({ id: e.id, action: e.action, fromState: e.fromState, toState: e.toState, actor: e.actor, at: e.at.toISOString(), data: ['note', 'edit', 'edit_address', 'record_payment', 'edit_refund'].includes(e.action) ? e.data : undefined })),
      };
    });
    if (!out) throw new HttpError(404, 'order not found');
    return c.json(out, 200);
  }),
);

// ── internal notes (staff-only, never shown to the customer) ────────────────
// Reuses audit_log (entity='order', action='note') instead of a new table:
// the order-detail timeline already reads audit_log for every other event, so
// a note appears in the SAME chronological feed as fulfillment/refund/cancel
// entries with zero extra joins. `data.note` is the only field the timeline
// reader treats specially for action==='note' (see GET /orders/{code} above).
admin.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/orders/{code}/notes', summary: 'Add an internal note to the order timeline (staff-only)',
    request: { params: z.object({ code: z.string() }), body: { content: J(z.object({ note: z.string().trim().min(1).max(2000) })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    const { code } = c.req.valid('param');
    const { note } = c.req.valid('json');
    const id = await withStore(st.storeId, async (tx) => {
      const [o] = await tx.select({ id: s.order.id }).from(s.order).where(eq(s.order.code, code)).limit(1);
      if (!o) return null;
      const [row] = await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: o.id, action: 'note', data: { note } }).returning({ id: s.auditLog.id });
      return row!.id;
    });
    if (!id) throw new HttpError(404, 'order not found');
    return c.json({ id }, 200);
  }),
);

admin.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/orders/{code}/fulfill', summary: 'Fulfill order (Shipped/Delivered)',
    request: { params: z.object({ code: z.string() }), body: { content: J(z.object({ state: z.enum(['Shipped', 'Delivered']).default('Shipped'), trackingCode: z.string().optional(), carrier: z.string().optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ code: z.string(), fulfillment: z.string() })) }, 404: { description: 'Not found', ...errBody }, 409: { description: 'Conflict', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    const { code } = c.req.valid('param');
    const { state, trackingCode, carrier } = c.req.valid('json');
    let stockChanged = false;
    const res = await withStore(st.storeId, async (tx) => {
      // Shared with bulk/partial fulfillment: serialize before reading shipment
      // state or remaining quantities, including the first fulfillment row.
      const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1).for('update');
      if (!o) return { kind: 'notfound' as const };
      assertImportedFinancialReconciliationAllowed(o.metadata);
      if (o.state !== 'Paid' && o.state !== 'PartiallyRefunded') return { kind: 'badstate' as const, state: o.state };
      const [existing] = await tx.select().from(s.fulfillment).where(eq(s.fulfillment.orderId, o.id)).orderBy(desc(s.fulfillment.createdAt)).limit(1);
      // Fulfillment state only advances: Pending -> Shipped -> Delivered. Block
      // a backward move (e.g. re-shipping an already-Delivered order).
      if (existing && existing.state === 'Delivered' && state === 'Shipped') return { kind: 'regress' as const, state: existing.state };
      if (state === 'Delivered' && (!existing || existing.state !== 'Shipped')) return { kind: 'badstate' as const, state: existing?.state ?? 'Unfulfilled' };
      const advancingToShipped = state === 'Shipped' && (!existing || existing.state === 'Pending');
      let fid: string;
      if (existing) {
        await tx.update(s.fulfillment).set({ state, trackingCode: trackingCode ?? existing.trackingCode, carrier: carrier ?? existing.carrier, updatedAt: new Date() }).where(eq(s.fulfillment.id, existing.id));
        fid = existing.id;
      } else {
        const [f] = await tx.insert(s.fulfillment).values({ storeId: st.storeId, orderId: o.id, state, trackingCode: trackingCode ?? null, carrier: carrier ?? null }).returning({ id: s.fulfillment.id });
        fid = f!.id;
      }
      // On the transition INTO Shipped (not on a repeat call), ship every line in
      // full (all-or-nothing fulfillment — partial qty is a v2 feature). Shipping
      // consumes reserved stock: decrement on_hand AND release allocated for the
      // shipped units, and record the movement.
      if (advancingToShipped) {
        const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
        for (const l of lines) {
          const ship = l.quantity - l.fulfilledQty - l.cancelledQty;
          if (ship <= 0) continue;
          await tx.update(s.orderLine).set({ fulfilledQty: l.quantity - l.cancelledQty }).where(eq(s.orderLine.id, l.id));
          if (l.variantId) {
            await tx.update(s.stock).set({
              onHand: sql`greatest(${s.stock.onHand} - ${ship}, 0)`,
              allocated: sql`greatest(${s.stock.allocated} - ${ship}, 0)`,
            }).where(eq(s.stock.variantId, l.variantId));
            await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: l.variantId, delta: -ship, reason: 'fulfillment', refOrderId: o.id, actor: admin.email });
            stockChanged = true;
          }
        }
      }
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: o.id, action: 'fulfill', toState: state });
      // WP2: emit order.shipped (existing webhook pattern) + durable customer
      // email via the outbox. Only on the first Shipped transition so we don't
      // double-email a re-fulfill that just refreshes tracking. Webhook emit,
      // email enqueue and the Shipped state all commit in the same txn — SR-12:
      // the notification can no longer be lost to an SMTP blip after the state
      // committed (the old inline send failed silently).
      // Webhook fires for ALL orders (3rd-party fulfillment/analytics subscribers);
      // the customer email goes to the resolved recipient (contact email, else account).
      if (state === 'Shipped' && advancingToShipped) {
        await emitEvent(tx, st.storeId, 'order.shipped', { code, trackingCode: trackingCode ?? null, carrier: carrier ?? null });
        // Guests have no customerId: resolveOrderRecipient falls back to the
        // checkout contact email, exactly like the refund email.
        const recipient = await resolveOrderRecipient(tx, o);
        if (recipient) {
          const [storeRow] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1);
          // SR-05: per-store sender + storefront URL from store.config.
          await enqueueShippingNotification(tx, st.storeId,
            { name: st.name, currency: st.currency, config: storeRow?.config ?? null },
            recipient,
            { code, trackingCode: trackingCode ?? null, carrier: carrier ?? null, dedupeKey: `shipping_notification:${o.id}:Shipped` });
        }
      }
      return { kind: 'ok' as const, fid, state };
    });
    if (stockChanged) onStockChanged(st.slug);
    if (res.kind === 'notfound') throw new HttpError(404, 'order not found');
    if (res.kind === 'badstate') throw new HttpError(409, `order not fulfillable in state ${res.state}`);
    if (res.kind === 'regress') throw new HttpError(409, `cannot move fulfillment from ${res.state} back to Shipped`);
    return c.json({ code, fulfillment: res.state }, 200);
  }),
);

// ── partial fulfillment (admin-essentials) ───────────────────────────────────
// Ships a SUBSET of an order's lines/quantities as their own fulfillment
// record, distinct from POST /fulfill above (which is all-or-nothing and
// stays as-is for the CSV/bulk-import callers that already depend on it).
// Multiple calls create multiple fulfillment rows — e.g. a 3-item order that
// ships in two boxes from two locations is two rows here, each with its own
// tracking/carrier/location and its own fulfillment_line quantities.
admin.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/orders/{code}/fulfillments', summary: 'Create a fulfillment for selected lines/quantities (partial fulfillment)',
    request: {
      params: z.object({ code: z.string() }),
      body: {
        content: J(z.object({
          lines: z.array(z.object({ orderLineId: z.string().uuid(), quantity: z.number().int().min(1) })).min(1),
          locationId: z.string().uuid().optional(),
          trackingCode: z.string().optional(),
          carrier: z.string().optional(),
        })),
      },
    },
    responses: {
      200: { description: 'OK', content: J(z.object({ code: z.string(), fulfillmentId: z.string(), state: z.string() })) },
      404: { description: 'Not found', ...errBody },
      409: { description: 'Conflict', ...errBody },
      401: { description: 'Unauthorized', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    const { code } = c.req.valid('param');
    const body = c.req.valid('json');
    let stockChanged = false;
    const variantIdsTouched: string[] = [];
    type Res =
      | { kind: 'ok'; fulfillmentId: string }
      | { kind: 'notfound' }
      | { kind: 'badstate'; state: string }
      | { kind: 'badlines' }
      | { kind: 'preorder' }
      | { kind: 'badlocation' };
    const res: Res = await withStore(st.storeId, async (tx): Promise<Res> => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1).for('update');
      if (!o) return { kind: 'notfound' };
      assertImportedFinancialReconciliationAllowed(o.metadata);
      if (o.state !== 'Paid' && o.state !== 'PartiallyRefunded') return { kind: 'badstate', state: o.state };
      if (body.locationId) {
        const [loc] = await tx.select({ id: s.location.id }).from(s.location)
          .where(and(eq(s.location.id, body.locationId), eq(s.location.storeId, st.storeId), eq(s.location.enabled, true))).limit(1);
        if (!loc) return { kind: 'badlocation' };
      }
      const orderLines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id)).for('update');
      const byId = new Map(orderLines.map((l) => [l.id, l]));
      const seen = new Set<string>();
      for (const line of body.lines) {
        if (seen.has(line.orderLineId)) return { kind: 'badlines' };
        seen.add(line.orderLineId);
        const row = byId.get(line.orderLineId);
        if (!row || row.orderId !== o.id) return { kind: 'badlines' };
        const remaining = row.quantity - row.fulfilledQty - row.cancelledQty;
        if (line.quantity > remaining) return { kind: 'badlines' };
      }
      // #406: a line whose variant is still on pre-order cannot ship yet (the UI disables it; this is the commit-time rule).
      const fulfilVariantIds = body.lines.map((l) => byId.get(l.orderLineId)!.variantId).filter((v): v is string => !!v);
      if (fulfilVariantIds.length) {
        const pre = await tx.select({ id: s.productVariant.id }).from(s.productVariant)
          .where(and(inArray(s.productVariant.id, fulfilVariantIds), eq(s.productVariant.isPreOrder, true))).limit(1);
        if (pre.length) return { kind: 'preorder' };
      }
      const [f] = await tx.insert(s.fulfillment).values({
        storeId: st.storeId, orderId: o.id, state: 'Shipped',
        trackingCode: body.trackingCode ?? null, carrier: body.carrier ?? null,
        // #380: the customer is always emailed (Adrian: "emails go when order is fulfilled"); the column stays for history.
        locationId: body.locationId ?? null, notifyCustomer: true,
      }).returning({ id: s.fulfillment.id });
      const fulfillmentId = f!.id;
      await tx.insert(s.fulfillmentLine).values(body.lines.map((l) => ({ storeId: st.storeId, fulfillmentId, orderLineId: l.orderLineId, quantity: l.quantity })));
      for (const line of body.lines) {
        const row = byId.get(line.orderLineId)!;
        await tx.update(s.orderLine).set({ fulfilledQty: sql`${s.orderLine.fulfilledQty} + ${line.quantity}` }).where(eq(s.orderLine.id, row.id));
        if (row.variantId) {
          await tx.update(s.stock).set({
            onHand: sql`greatest(${s.stock.onHand} - ${line.quantity}, 0)`,
            allocated: sql`greatest(${s.stock.allocated} - ${line.quantity}, 0)`,
          }).where(eq(s.stock.variantId, row.variantId));
          await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: row.variantId, delta: -line.quantity, reason: 'fulfillment', refOrderId: o.id, actor: admin.email });
          if (body.locationId) {
            await tx.update(s.stockLocation).set({ onHand: sql`greatest(${s.stockLocation.onHand} - ${line.quantity}, 0)` })
              .where(and(eq(s.stockLocation.variantId, row.variantId), eq(s.stockLocation.locationId, body.locationId)));
          }
          stockChanged = true;
          variantIdsTouched.push(row.variantId);
        }
      }
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: o.id, action: 'fulfill', toState: 'Shipped', data: { partial: true, fulfillmentId, lines: body.lines.length, locationId: body.locationId ?? null } });
      // Webhook fires unconditionally (3rd-party subscribers care about every
      // shipment); the CUSTOMER email always goes too (#380: no opt-out). Each
      // fulfillment gets its own dedupeKey (keyed on fulfillmentId, not
      // orderId:Shipped like the whole-order route) — a second partial
      // shipment on the same order must send its own email, not be treated as
      // a duplicate of the first.
      await emitEvent(tx, st.storeId, 'order.shipped', { code, trackingCode: body.trackingCode ?? null, carrier: body.carrier ?? null, partial: true });
      const recipient = await resolveOrderRecipient(tx, o);
      if (recipient) {
        const [storeRow] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1);
        await enqueueShippingNotification(tx, st.storeId,
          { name: st.name, currency: st.currency, config: storeRow?.config ?? null },
          recipient,
          { code, trackingCode: body.trackingCode ?? null, carrier: body.carrier ?? null, dedupeKey: `shipping_notification:${fulfillmentId}:Shipped` });
      }
      return { kind: 'ok', fulfillmentId };
    });
    if (stockChanged) onStockChanged(st.slug, [...new Set(variantIdsTouched)]);
    if (res.kind === 'notfound') throw new HttpError(404, 'order not found');
    if (res.kind === 'badstate') throw new HttpError(409, `order not fulfillable in state ${res.state}`);
    if (res.kind === 'badlocation') throw new HttpError(409, 'location not found or disabled');
    if (res.kind === 'badlines') throw new HttpError(409, 'duplicate, foreign, or over-quantity line in fulfillment request');
    if (res.kind === 'preorder') throw new HttpError(409, 'pre-order items cannot be fulfilled until the pre-order ends');
    return c.json({ code, fulfillmentId: res.fulfillmentId, state: 'Shipped' }, 200);
  }),
);

// ── bulk order fulfillment (Phase 4) ──────────────────────────────────────────
// Per-order outcomes — one bad apple never fails the whole batch. The UI uses
// the per-row result to render an "X succeeded, Y skipped" panel after the
// action. The bulk endpoint is a fan-out of POST /orders/{code}/fulfill
// sharing the same transition rules + audit + shipping notification semantics.
admin.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/orders/bulk-fulfill', summary: 'Fulfill multiple orders in one batch',
    request: {
      body: {
        content: J(z.object({
          orders: z.array(z.object({
            code: z.string().min(1),
            state: z.enum(['Shipped', 'Delivered']).default('Shipped'),
            trackingCode: z.string().optional(),
            carrier: z.string().optional(),
          })).min(1).max(100),
        })),
      },
    },
    responses: {
      200: { description: 'OK', content: J(z.object({
        results: z.array(z.object({
          code: z.string(),
          ok: z.boolean(),
          fulfillment: z.string().optional(),
          error: z.string().optional(),
          errorCode: z.literal('IMPORTED_FINANCIAL_RECONCILIATION_REQUIRED').optional(),
        })),
        succeeded: z.number().int(),
        skipped: z.number().int(),
      })) },
      401: { description: 'Unauthorized', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    const { orders } = c.req.valid('json');
    const results: { code: string; ok: boolean; fulfillment?: string; error?: string; errorCode?: 'IMPORTED_FINANCIAL_RECONCILIATION_REQUIRED' }[] = [];
    // De-duplicate by code within a single request — last write wins, but we
    // only emit one row to the caller. Keeps the result panel honest.
    const seen = new Map<string, typeof orders[number]>();
    for (const o of orders) seen.set(o.code, o);
    const deduped = [...seen.values()];
    for (const o of deduped) {
      let stockChanged = false;
      const res = await withStore(st.storeId, async (tx): Promise<{ kind: 'ok' | 'notfound' | 'badstate' | 'regress' | 'quarantined'; state?: string }> => {
        // Match single/partial fulfillment's order lock before shipment reads.
        // Each order commits separately, preserving the batch's lock ordering.
        const [order] = await tx.select().from(s.order).where(eq(s.order.code, o.code)).limit(1).for('update');
        if (!order) return { kind: 'notfound' };
        if (importedFinancialReconciliationRequired(order.metadata)) return { kind: 'quarantined' };
        if (order.state !== 'Paid' && order.state !== 'PartiallyRefunded') return { kind: 'badstate', state: order.state };
        const [existing] = await tx.select().from(s.fulfillment).where(eq(s.fulfillment.orderId, order.id)).orderBy(desc(s.fulfillment.createdAt)).limit(1);
        if (existing && existing.state === 'Delivered' && o.state === 'Shipped') return { kind: 'regress', state: existing.state };
        if (o.state === 'Delivered' && (!existing || existing.state !== 'Shipped')) return { kind: 'badstate', state: existing?.state ?? 'Unfulfilled' };
        const advancingToShipped = o.state === 'Shipped' && (!existing || existing.state === 'Pending');
        if (existing) {
          await tx.update(s.fulfillment).set({ state: o.state, trackingCode: o.trackingCode ?? existing.trackingCode, carrier: o.carrier ?? existing.carrier, updatedAt: new Date() }).where(eq(s.fulfillment.id, existing.id));
        } else {
          await tx.insert(s.fulfillment).values({ storeId: st.storeId, orderId: order.id, state: o.state, trackingCode: o.trackingCode ?? null, carrier: o.carrier ?? null });
        }
        if (advancingToShipped) {
          const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, order.id));
          for (const l of lines) {
            const ship = l.quantity - l.fulfilledQty - l.cancelledQty;
            if (ship <= 0) continue;
            await tx.update(s.orderLine).set({ fulfilledQty: l.quantity - l.cancelledQty }).where(eq(s.orderLine.id, l.id));
            if (l.variantId) {
              await tx.update(s.stock).set({
                onHand: sql`greatest(${s.stock.onHand} - ${ship}, 0)`,
                allocated: sql`greatest(${s.stock.allocated} - ${ship}, 0)`,
              }).where(eq(s.stock.variantId, l.variantId));
              await tx.insert(s.stockMovement).values({ storeId: st.storeId, variantId: l.variantId, delta: -ship, reason: 'fulfillment', refOrderId: order.id, actor: admin.email });
              stockChanged = true;
            }
          }
        }
        await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: order.id, action: 'fulfill', toState: o.state });
        // SR-12: shipping notification is enqueued in the SAME txn as the
        // Shipped transition (durable retry, no post-commit silent drop).
        if (o.state === 'Shipped' && advancingToShipped) {
          await emitEvent(tx, st.storeId, 'order.shipped', { code: o.code, trackingCode: o.trackingCode ?? null, carrier: o.carrier ?? null });
          const recipient = await resolveOrderRecipient(tx, order);
          if (recipient) {
            const [storeRow] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1);
            await enqueueShippingNotification(tx, st.storeId,
              { name: st.name, currency: st.currency, config: storeRow?.config ?? null },
              recipient,
              { code: o.code, trackingCode: o.trackingCode ?? null, carrier: o.carrier ?? null, dedupeKey: `shipping_notification:${order.id}:Shipped` });
          }
        }
        return { kind: 'ok', state: o.state };
      });
      if (stockChanged) onStockChanged(st.slug);
      if (res.kind === 'ok') {
        results.push({ code: o.code, ok: true, fulfillment: res.state });
      } else if (res.kind === 'quarantined') {
        const refusal = new ImportedFinancialReconciliationError();
        results.push({ code: o.code, ok: false, error: refusal.message, errorCode: refusal.code });
      } else if (res.kind === 'notfound') {
        results.push({ code: o.code, ok: false, error: 'not found' });
      } else if (res.kind === 'badstate') {
        results.push({ code: o.code, ok: false, error: `not fulfillable in state ${res.state}` });
      } else {
        results.push({ code: o.code, ok: false, error: `cannot move fulfillment from ${res.state} back to Shipped` });
      }
    }
    const succeeded = results.filter((r) => r.ok).length;
    const skipped = results.length - succeeded;
    return c.json({ results, succeeded, skipped }, 200);
  }),
);

admin.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/orders/{code}/cancel', summary: 'Cancel order',
    request: { params: z.object({ code: z.string() }), body: { content: J(z.object({ reason: z.string().optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ code: z.string(), state: z.string() })) }, 404: { description: 'Not found', ...errBody }, 409: { description: 'Conflict', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    requirePermission(st, 'cancel_orders');
    const { code } = c.req.valid('param');
    let stockChanged = false;
    // Unlocked id lookup, then the order set (STOREKIT §5.8 #11): the order is
    // re-read FOR UPDATE under the set, so a concurrent edit cannot slip between.
    const orderId = await orderIdByCode(st.storeId, code);
    // PAYMENT-TIMING §3.4: quiescence is evaluated with the stripe discovery flag computed before the transaction (no I/O inside it).
    const [cancelStore] = orderId ? await withStore(st.storeId, (tx) => tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1)) : [];
    const stripeDiscover = orderId ? await stripeDiscoverable(st.storeId, cancelStore?.config ?? {}) : false;
    // X-46: the L0 pay advisory (same key as /pay and gateway recovery) is taken before the order set,
    // so a cancel serialises with an in-flight payment or capture for this order.
    const res = !orderId ? { kind: 'notfound' as const } : await withAdvisoryLock(`pay:${st.storeId}:${code}`, () => withLockedSet(st.storeId, { kind: 'order', orderId }, async (tx, held) => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.code, code)).limit(1).for('update');
      if (!o) return { kind: 'notfound' as const };
      assertImportedFinancialReconciliationAllowed(o.metadata);
      // Only unpaid orders can be cancelled directly — cancelling releases stock
      // but does not touch money. A Paid order must go through Refund so the
      // payment (and any issued licenses) are handled explicitly.
      if (await hasUnresolvedPayment(tx, o.id)) throw new HttpError(409, 'Resolve the pending payment before cancelling');
      if (o.state !== 'PendingPayment') return { kind: 'paid' as const, state: o.state };
      if (!canTransition(o.state as OrderState, 'Cancelled')) return { kind: 'badstate' as const, state: o.state };
      try {
        await assertNoPendingOrderEdit(tx, st.storeId, o.id);
      } catch (error) {
        if (error instanceof OrderEditError && error.code === 'ORDER_EDIT_PENDING') {
          throw new HttpError(error.status, error.message, error.code);
        }
        throw error;
      }
      // Release stock still reserved for unshipped units. Shipped units already
      // had their allocation released (see fulfill), so release = unfulfilled qty.
      const lines = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, o.id));
      for (const l of lines) {
        const release = l.quantity - l.fulfilledQty - l.cancelledQty;
        if (release > 0) {
          // D6: mark released units cancelled so a later refund can't release them again.
          await tx.update(s.orderLine).set({ cancelledQty: sql`${s.orderLine.cancelledQty} + ${release}` }).where(eq(s.orderLine.id, l.id));
        }
        if (release > 0 && l.variantId) {
          await tx.update(s.stock).set({ allocated: sql`greatest(${s.stock.allocated} - ${release}, 0)` })
            .where(and(eq(s.stock.variantId, l.variantId), eq(s.stock.storeId, st.storeId)));
          stockChanged = true;
        }
      }
      await tx.update(s.order).set({ state: 'Cancelled', updatedAt: new Date() }).where(eq(s.order.id, o.id));
      // LOYALTY-1: release points reserved by this order (idempotent).
      await releaseOrderLoyalty(tx, st.storeId, o.id, admin.email);
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'order', entityId: o.id, action: 'cancel', fromState: o.state, toState: 'Cancelled' });
      // PAYMENT-TIMING §5.2 (R3/R4): request the release; it takes effect now if provider work is quiescent, else the sweep settles it.
      await release(tx, held, { storeId: st.storeId, orderId: o.id, reason: 'order_cancelled', stripeDiscoverable: stripeDiscover });
      return { kind: 'ok' as const, orderId: o.id };
    }));
    if (stockChanged) onStockChanged(st.slug);
    // After commit: cancel the order's open Stripe intents (best-effort, audited).
    if (res.kind === 'ok') await cancelOrderStripeIntents(st.storeId, res.orderId, admin.email);
    if (res.kind === 'notfound') throw new HttpError(404, 'order not found');
    if (res.kind === 'paid') throw new HttpError(409, `paid order — use Refund (state ${res.state})`);
    if (res.kind === 'badstate') throw new HttpError(409, `cannot cancel order in state ${res.state}`);
    return c.json({ code, state: 'Cancelled' }, 200);
  }),
);
