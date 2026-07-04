import { describe, expect, it } from 'vitest';
import { shouldSetSecureCookie } from './cookies.js';

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
