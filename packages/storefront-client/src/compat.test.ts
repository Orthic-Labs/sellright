/**
 * Compatibility surface tests — `sellright()`/`SellRightError`/`idempotency()`
 * must behave exactly like the sf-native prototype's storefront-embedded
 * client (see compat.ts's doc comment): a zero-argument `sellright()` after
 * one `configureSellRightClient()` call, typed errors thrown as
 * `SellRightError` (== `ApiError`), and a plain idempotency-key object.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureSellRightClient, idempotency, sellright, SellRightError } from './compat.js';
import { request } from './client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeFetch(respond: (req: Request) => Response) {
  const calls: Request[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    const req = input as Request;
    calls.push(req);
    return respond(req);
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

describe('sellright()', () => {
  afterEach(() => {
    // Reset to an unconfigured state so tests don't leak config into each other.
    configureSellRightClient(undefined);
  });

  it('throws a clear error when called before configureSellRightClient()', () => {
    expect(() => sellright()).toThrow(/configureSellRightClient/);
  });

  it('resolves baseUrl/storeSlug/csrf thunks fresh on every call (SSR per-request safety)', async () => {
    const { fetchFn, calls } = fakeFetch(() => jsonResponse(200, { status: 'ok' }));
    let slug = 'store-a';
    configureSellRightClient({
      baseUrl: () => 'http://api.test',
      storeSlug: () => slug,
      isServer: () => true,
      getCsrfToken: () => 'csrf-1',
      fetch: fetchFn,
    });

    await sellright().GET('/v1/health');
    expect(calls[0]?.headers.get('x-store-slug')).toBe('store-a');

    slug = 'store-b';
    await sellright().GET('/v1/health');
    expect(calls[1]?.headers.get('x-store-slug')).toBe('store-b');
  });

  it('forwards the SSR cookie only when isServer() is true', async () => {
    const { fetchFn, calls } = fakeFetch(() => jsonResponse(200, { status: 'ok' }));
    configureSellRightClient({
      baseUrl: () => 'http://api.test',
      isServer: () => true,
      forwardCookie: () => 'sr_session=abc',
      fetch: fetchFn,
    });
    await sellright().GET('/v1/health');
    expect(calls[0]?.headers.get('cookie')).toBe('sr_session=abc');
  });

  it('never forwards a cookie when isServer() is false, even if forwardCookie is configured', async () => {
    const { fetchFn, calls } = fakeFetch(() => jsonResponse(200, { status: 'ok' }));
    configureSellRightClient({
      baseUrl: () => 'http://api.test',
      isServer: () => false,
      forwardCookie: () => 'sr_session=abc',
      fetch: fetchFn,
    });
    await sellright().GET('/v1/health');
    expect(calls[0]?.headers.get('cookie')).toBeNull();
  });
});

describe('SellRightError', () => {
  it('is the exact same class as ApiError — instanceof works across both names', async () => {
    const { fetchFn } = fakeFetch(() => jsonResponse(404, { error: { code: 'PRODUCT_NOT_FOUND', message: 'not found' } }));
    configureSellRightClient({ baseUrl: () => 'http://api.test', fetch: fetchFn });
    await expect(request(sellright().GET('/v1/shop/catalog/products/{slug}', { params: { path: { slug: 'x' } } })))
      .rejects.toBeInstanceOf(SellRightError);
  });
});

describe('idempotency()', () => {
  it('returns a plain idempotency-key object', () => {
    expect(idempotency('abc-123')).toEqual({ 'idempotency-key': 'abc-123' });
  });
});
