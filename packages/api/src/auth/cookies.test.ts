import { describe, expect, it } from 'vitest';
import {
  shouldSetSecureCookie,
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
