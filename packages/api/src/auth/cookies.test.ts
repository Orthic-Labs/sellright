import { describe, expect, it } from 'vitest';
import { csrfValid, customerCsrfValid, newCsrf, CSRF_COOKIE, CUST_CSRF_COOKIE } from './cookies.js';

/** Minimal fake `c` matching the `{ req: { header } }` shape every cookies.ts
 *  helper accepts — no DB, no real Hono app. */
function fakeCtx(headers: Record<string, string | undefined>) {
  return { req: { header: (k: string) => headers[k.toLowerCase()] } };
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
