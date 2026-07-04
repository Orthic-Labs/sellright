/**
 * Cookie-based admin sessions. The session token rides in an **httpOnly** cookie
 * (JS can't read it → XSS can't steal it). A separate non-httpOnly CSRF cookie is
 * echoed back by the SPA in `x-csrf-token` (double-submit) and checked on
 * mutations. `Secure` is derived from the request's actual scheme (via
 * `X-Forwarded-Proto`, set by our proxy/nginx/Cloudflare in front of the API) OR
 * `NODE_ENV=production`, so a session served over plain HTTP never gets a
 * Secure cookie (dev/localhost keeps working) while a production box that
 * somehow lost X-Forwarded-Proto still defaults Secure on. See SEC-5: gating
 * Secure on NODE_ENV alone meant a staging box booted without that env var
 * served session cookies without Secure over HTTP.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Constant-time double-submit token compare (mirrors the password compare in auth/password.ts). */
function csrfEqual(header: string | undefined, cooked: string | undefined): boolean {
  if (!header || !cooked) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(cooked);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const SESSION_COOKIE = 'sr_admin';
export const CSRF_COOKIE = 'sr_csrf';
const MAX_AGE = 14 * 24 * 3600;

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

type Ctx = { req: { header: (k: string) => string | undefined }; header: (k: string, v: string, opts?: { append?: boolean }) => void };

export function cookie(c: { req: { header: (k: string) => string | undefined } }, name: string): string | undefined {
  return parseCookies(c.req.header('cookie'))[name];
}

export function newCsrf(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Pure decision logic for the cookie `Secure` flag, unit-testable without a
 * Hono context. Scheme-based (`x-forwarded-proto: https`) is the primary
 * signal — it reflects what the CLIENT actually connected over, set by
 * whatever terminates TLS in front of this process (Cloudflare/nginx/etc).
 * `NODE_ENV=production` is OR'd in as a floor so this never REGRESSES current
 * production behavior even if a proxy fails to forward the header.
 */
export function shouldSetSecureCookie(headers: { get: (k: string) => string | undefined }, nodeEnv: string): boolean {
  return headers.get('x-forwarded-proto') === 'https' || nodeEnv === 'production';
}

function secureFlag(c: { req: { header: (k: string) => string | undefined } }): string {
  return shouldSetSecureCookie({ get: (k) => c.req.header(k) }, process.env.NODE_ENV ?? 'development') ? '; Secure' : '';
}

export function setAuthCookies(c: Ctx, token: string, csrf: string): void {
  const secure = secureFlag(c);
  const base = `Path=/; Max-Age=${MAX_AGE}; SameSite=Lax${secure}`;
  c.header('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; ${base}`, { append: true });
  c.header('Set-Cookie', `${CSRF_COOKIE}=${csrf}; ${base}`, { append: true });
}

export function clearAuthCookies(c: Ctx): void {
  c.header('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`, { append: true });
  c.header('Set-Cookie', `${CSRF_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`, { append: true });
}

/** CSRF check for browser (cookie-based) mutations. Requests authenticated by an
 *  explicit Authorization bearer header are NOT CSRF-vulnerable (not auto-sent),
 *  so they're exempt — keeping API clients working. */
export function csrfValid(c: { req: { header: (k: string) => string | undefined } }): boolean {
  if (c.req.header('authorization')) return true; // bearer client, not cookie
  const header = c.req.header('x-csrf-token');
  const cooked = cookie(c, CSRF_COOKIE);
  return csrfEqual(header, cooked);
}

// ── Storefront customer cookies (separate names from the admin app) ───────────
export const CUST_COOKIE = 'sr_cust';
export const CUST_CSRF_COOKIE = 'sr_cust_csrf';

export function setCustomerCookies(c: Ctx, token: string, csrf: string): void {
  const secure = secureFlag(c);
  const base = `Path=/; Max-Age=${MAX_AGE}; SameSite=Lax${secure}`;
  c.header('Set-Cookie', `${CUST_COOKIE}=${token}; HttpOnly; ${base}`, { append: true });
  c.header('Set-Cookie', `${CUST_CSRF_COOKIE}=${csrf}; ${base}`, { append: true });
}

export function clearCustomerCookies(c: Ctx): void {
  c.header('Set-Cookie', `${CUST_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`, { append: true });
  c.header('Set-Cookie', `${CUST_CSRF_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`, { append: true });
}

/** CSRF check for cookie-authenticated customer mutations (bearer is exempt). */
export function customerCsrfValid(c: { req: { header: (k: string) => string | undefined } }): boolean {
  if (c.req.header('authorization')) return true;
  const header = c.req.header('x-csrf-token');
  const cooked = cookie(c, CUST_CSRF_COOKIE);
  return csrfEqual(header, cooked);
}

/** Get the customer session token from the request cookie (or undefined for guests). */
export function getCustomerSessionToken(c: { req: { header: (k: string) => string | undefined } }): string | undefined {
  return cookie(c, CUST_COOKIE);
}
