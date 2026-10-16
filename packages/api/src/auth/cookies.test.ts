import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetEnvForTest, envOrigin, initEnv } from '../env.js';
import {
  shouldSetSecureCookie,
  setAuthCookies,
  setCustomerCookies,
  setFederatedNonceCookie,
  csrfValid,
  customerCsrfValid,
  newCsrf,
  CSRF_COOKIE,
  CUST_CSRF_COOKIE,
} from './cookies.js';

/**
 * SEC-5: the Secure cookie flag must reflect the actual request scheme, not
 * just NODE_ENV — a staging box booted without NODE_ENV=production must not
 * serve session cookies without Secure over plain HTTP. Pure unit tests, no
 * DB, no server.
 */
function headers(map: Record<string, string>) {
  return { get: (k: string) => map[k] };
}

describe('shouldSetSecureCookie', () => {
  it('sets Secure when the request came in over https (x-forwarded-proto)', () => {
    expect(shouldSetSecureCookie(headers({ 'x-forwarded-proto': 'https' }), 'development')).toBe(true);
  });

  it('does not set Secure for plain http in development (keeps localhost dev working)', () => {
    expect(shouldSetSecureCookie(headers({ 'x-forwarded-proto': 'http' }), 'development')).toBe(false);
  });

  it('does not set Secure when the header is absent and NODE_ENV is not production', () => {
    expect(shouldSetSecureCookie(headers({}), 'development')).toBe(false);
  });

  it('still sets Secure in production even if x-forwarded-proto is missing (no regression floor)', () => {
    expect(shouldSetSecureCookie(headers({}), 'production')).toBe(true);
  });

  it('sets Secure when NODE_ENV is production AND scheme is https', () => {
    expect(shouldSetSecureCookie(headers({ 'x-forwarded-proto': 'https' }), 'production')).toBe(true);
  });

  it('does NOT set Secure for a staging box with unset NODE_ENV over plain http (the SEC-5 footgun)', () => {
    expect(shouldSetSecureCookie(headers({ 'x-forwarded-proto': 'http' }), 'test')).toBe(false);
  });
});

/** Minimal fake `c` matching the `{ req: { header } }` shape every cookies.ts
 *  helper accepts — no DB, no real Hono app. */
function fakeCtx(hdrs: Record<string, string | undefined>) {
  return { req: { header: (k: string) => hdrs[k.toLowerCase()] } };
}

describe('csrfValid', () => {
  it('is false when authorization is absent and no CSRF cookie/header pair is present', () => {
    expect(csrfValid(fakeCtx({}))).toBe(false);
  });

  it('is false when authorization is absent and the CSRF header/cookie mismatch', () => {
    expect(
      csrfValid(
        fakeCtx({
          'x-csrf-token': 'abc123',
          cookie: `${CSRF_COOKIE}=different`,
        }),
      ),
    ).toBe(false);
  });

  it('is false when authorization is present but empty/malformed (not a real bearer)', () => {
    expect(csrfValid(fakeCtx({ authorization: '' }))).toBe(false);
    expect(csrfValid(fakeCtx({ authorization: 'Bearer' }))).toBe(false);
    expect(csrfValid(fakeCtx({ authorization: 'Bearer   ' }))).toBe(false);
    expect(csrfValid(fakeCtx({ authorization: 'Basic dXNlcjpwYXNz' }))).toBe(false);
    expect(csrfValid(fakeCtx({ authorization: 'garbage-not-a-scheme' }))).toBe(false);
  });

  it('is true for a well-formed bearer, even with no CSRF cookie/header', () => {
    expect(csrfValid(fakeCtx({ authorization: 'Bearer sometoken123' }))).toBe(true);
  });

  it('is true when authorization is absent but the CSRF header matches the cookie', () => {
    const token = newCsrf();
    expect(
      csrfValid(
        fakeCtx({
          'x-csrf-token': token,
          cookie: `${CSRF_COOKIE}=${token}`,
        }),
      ),
    ).toBe(true);
  });
});

describe('customerCsrfValid', () => {
  it('is false when authorization is absent and no CSRF cookie/header pair is present', () => {
    expect(customerCsrfValid(fakeCtx({}))).toBe(false);
  });

  it('is false when authorization is present but empty/malformed (not a real bearer)', () => {
    expect(customerCsrfValid(fakeCtx({ authorization: '' }))).toBe(false);
    expect(customerCsrfValid(fakeCtx({ authorization: 'Bearer' }))).toBe(false);
  });

  it('is true for a well-formed bearer', () => {
    expect(customerCsrfValid(fakeCtx({ authorization: 'Bearer sometoken123' }))).toBe(true);
  });

  it('is true when authorization is absent but the CSRF header matches the cookie', () => {
    const token = newCsrf();
    expect(
      customerCsrfValid(
        fakeCtx({
          'x-csrf-token': token,
          cookie: `${CUST_CSRF_COOKIE}=${token}`,
        }),
      ),
    ).toBe(true);
  });
});


describe('cookie Secure config source', () => {
  beforeEach(() => { _resetEnvForTest(); });
  afterEach(() => { _resetEnvForTest(); vi.unstubAllEnvs(); });

  function cookieContext() {
    const values: string[] = [];
    return {
      values,
      req: { header: (_key: string) => undefined },
      header: (_key: string, value: string) => { values.push(value); },
    };
  }

  it('sets Secure from explicit production config when ambient NODE_ENV is development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    initEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgres://unit:unit@localhost/merchant', STOREFRONT_URL: 'https://shop.example.test' });
    const c = cookieContext();
    setAuthCookies(c, 'admin-token', 'csrf');
    setCustomerCookies(c, 'customer-token', 'csrf');
    setFederatedNonceCookie(c, 'nonce', 60);
    expect(c.values).toHaveLength(5);
    expect(c.values.every((value) => value.includes('; Secure'))).toBe(true);
    expect(process.env.NODE_ENV).toBe('development');
  });

  it('uses explicit development config even when ambient NODE_ENV is production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    initEnv({ NODE_ENV: 'development' });
    const c = cookieContext();
    setFederatedNonceCookie(c, 'nonce', 60);
    expect(c.values[0]).not.toContain('; Secure');
  });

  it('preserves standalone ambient behavior without parsing database config', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', 'invalid-url');
    const c = cookieContext();
    setFederatedNonceCookie(c, 'nonce', 60);
    expect(c.values[0]).toContain('; Secure');
    expect(envOrigin()).toBeUndefined();
  });
});
