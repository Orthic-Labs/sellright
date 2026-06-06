/**
 * Cookie-based admin sessions. The session token rides in an **httpOnly** cookie
 * (JS can't read it → XSS can't steal it). A separate non-httpOnly CSRF cookie is
 * echoed back by the SPA in `x-csrf-token` (double-submit) and checked on
 * mutations. `Secure` is set only in production (dev runs over http://localhost).
 */
import { randomBytes } from 'node:crypto';

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

export function setAuthCookies(c: Ctx, token: string, csrf: string): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
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
  return !!header && !!cooked && header === cooked;
}

// ── Storefront customer cookies (separate names from the admin app) ───────────
export const CUST_COOKIE = 'sr_cust';
export const CUST_CSRF_COOKIE = 'sr_cust_csrf';

export function setCustomerCookies(c: Ctx, token: string, csrf: string): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
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
  return !!header && !!cooked && header === cooked;
}
