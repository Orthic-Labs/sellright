/**
 * Browser-only behavior: reading the CSRF token from `document.cookie` (the
 * `sr_cust_csrf` cookie — see packages/api/src/auth/cookies.ts's
 * CUST_CSRF_COOKIE, deliberately NOT the admin `sr_csrf` cookie). `isBrowser`
 * is computed once at module load time, so `document` must exist BEFORE
 * `./client.js` is imported — this file stubs a minimal `document` and
 * dynamically imports the client fresh (`vi.resetModules()`), rather than
 * importing it statically like client.test.ts does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalDocument = (globalThis as { document?: unknown }).document;

beforeEach(() => {
  vi.resetModules();
  (globalThis as { document?: unknown }).document = { cookie: '' };
});

afterEach(() => {
  (globalThis as { document?: unknown }).document = originalDocument;
  vi.resetModules();
});

function setCookie(cookie: string) {
  (globalThis as { document: { cookie: string } }).document.cookie = cookie;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('browser CSRF cookie read', () => {
  it('reads sr_cust_csrf (not the admin sr_csrf cookie) and sends it as x-csrf-token on a mutation', async () => {
    setCookie('sr_session=abc; sr_cust_csrf=browser-csrf-value; other=1');
    const { createStorefrontClient } = await import('./client.js');
    const calls: Request[] = [];
    const fetchFn = vi.fn(async (input: Request) => { calls.push(input); return jsonResponse(200, {}); });
    const client = createStorefrontClient({ baseUrl: 'http://api.test', fetch: fetchFn });
    await client.raw.POST('/v1/shop/cart', { body: {} });
    expect(calls[0]?.headers.get('x-csrf-token')).toBe('browser-csrf-value');
  });

  it('does NOT pick up the admin sr_csrf cookie for a shop-surface call', async () => {
    setCookie('sr_csrf=admin-csrf-value'); // no sr_cust_csrf at all
    const { createStorefrontClient } = await import('./client.js');
    const calls: Request[] = [];
    const fetchFn = vi.fn(async (input: Request) => { calls.push(input); return jsonResponse(200, {}); });
    const client = createStorefrontClient({ baseUrl: 'http://api.test', fetch: fetchFn });
    await client.raw.POST('/v1/shop/cart', { body: {} });
    expect(calls[0]?.headers.get('x-csrf-token')).toBeNull();
  });

  it('an explicit getCsrfToken override wins over the browser cookie read', async () => {
    setCookie('sr_cust_csrf=from-cookie');
    const { createStorefrontClient } = await import('./client.js');
    const calls: Request[] = [];
    const fetchFn = vi.fn(async (input: Request) => { calls.push(input); return jsonResponse(200, {}); });
    const client = createStorefrontClient({ baseUrl: 'http://api.test', getCsrfToken: () => 'from-override', fetch: fetchFn });
    await client.raw.POST('/v1/shop/cart', { body: {} });
    expect(calls[0]?.headers.get('x-csrf-token')).toBe('from-override');
  });
});
