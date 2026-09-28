/**
 * Unit tests for the thin fetch client — store-slug/host resolution, the
 * CSRF double-submit header, idempotency-key passthrough, typed errors, and
 * the timeout guard. Runs in Node (isBrowser === false at module load time,
 * since there's no global `document`) — see client.browser.test.ts for the
 * browser-only CSRF-cookie-read path.
 */
import { describe, expect, it, vi } from 'vitest';
import { createStorefrontClient, request } from './client.js';
import { ApiError, NetworkError } from './errors.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Records every Request the client's fetch was called with, and returns
 *  whatever `respond` produces for it. Typed against `typeof fetch`'s full
 *  `RequestInfo | URL` parameter (not just `Request`) so it's structurally
 *  assignable to `StorefrontClientOptions['fetch']` — openapi-fetch always
 *  calls it with a `Request` instance in practice, which is what every
 *  caller here relies on. */
function fakeFetch(respond: (req: Request) => Response) {
  const calls: Request[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    const req = input as Request;
    calls.push(req);
    return respond(req);
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

describe('store resolution', () => {
  it('sends x-store-slug on every request when storeSlug is configured', async () => {
    const { fetchFn, calls } = fakeFetch(() => jsonResponse(200, { status: 'ok' }));
    const client = createStorefrontClient({ baseUrl: 'http://api.test', storeSlug: 'acme', fetch: fetchFn });
    await client.raw.GET('/v1/health');
    expect(calls[0]?.headers.get('x-store-slug')).toBe('acme');
    expect(calls[0]?.headers.get('x-forwarded-host')).toBeNull();
  });

  it('falls back to x-forwarded-host when no storeSlug is configured (WS-C per-host resolution)', async () => {
    const { fetchFn, calls } = fakeFetch(() => jsonResponse(200, { status: 'ok' }));
    const client = createStorefrontClient({ baseUrl: 'http://api.test', forwardedHost: 'shop.example.com', fetch: fetchFn });
    await client.raw.GET('/v1/health');
    expect(calls[0]?.headers.get('x-forwarded-host')).toBe('shop.example.com');
    expect(calls[0]?.headers.get('x-store-slug')).toBeNull();
  });
});

describe('CSRF double-submit header', () => {
  it('attaches x-csrf-token on a mutating call when getCsrfToken returns a value', async () => {
    const { fetchFn, calls } = fakeFetch(() => jsonResponse(200, { token: 't', status: 'active', email: null, customerId: null, currency: 'USD', lines: [], subtotal: 0, discountTotal: 0, shippingTotal: 0, taxTotal: 0, grandTotal: 0, revision: 0, coupon: null, unavailable: [] }));
    const client = createStorefrontClient({ baseUrl: 'http://api.test', getCsrfToken: () => 'csrf-token-value', fetch: fetchFn });
    await client.raw.POST('/v1/shop/cart', { body: {} });
    expect(calls[0]?.headers.get('x-csrf-token')).toBe('csrf-token-value');
  });

  it('does NOT attach x-csrf-token on a GET (never a mutation)', async () => {
    const { fetchFn, calls } = fakeFetch(() => jsonResponse(200, { status: 'ok' }));
    const client = createStorefrontClient({ baseUrl: 'http://api.test', getCsrfToken: () => 'csrf-token-value', fetch: fetchFn });
    await client.raw.GET('/v1/health');
    expect(calls[0]?.headers.get('x-csrf-token')).toBeNull();
  });

  it('omits the header entirely when getCsrfToken has nothing (guest, no cookie yet)', async () => {
    const { fetchFn, calls } = fakeFetch(() => jsonResponse(200, {}));
    const client = createStorefrontClient({ baseUrl: 'http://api.test', getCsrfToken: () => undefined, fetch: fetchFn });
    await client.raw.POST('/v1/shop/cart', { body: {} });
    expect(calls[0]?.headers.get('x-csrf-token')).toBeNull();
  });
});

describe('idempotency-key passthrough', () => {
  it('forwards a caller-supplied idempotency-key header untouched', async () => {
    const { fetchFn, calls } = fakeFetch(() => jsonResponse(200, { attemptId: '00000000-0000-4000-8000-000000000000', status: 'pending' }));
    const client = createStorefrontClient({ baseUrl: 'http://api.test', fetch: fetchFn });
    await client.raw.POST('/v1/shop/orders/{code}/gateway-payment', {
      params: { path: { code: 'ORD-1' }, header: { 'idempotency-key': 'my-idem-key-123' } },
      body: { method: 'nmi' },
    });
    expect(calls[0]?.headers.get('idempotency-key')).toBe('my-idem-key-123');
  });
});

describe('request() — typed errors', () => {
  it('returns data on a 2xx response', async () => {
    const { fetchFn } = fakeFetch(() => jsonResponse(200, { status: 'ok', version: '0.1.0' }));
    const client = createStorefrontClient({ baseUrl: 'http://api.test', fetch: fetchFn });
    const data = await request(client.raw.GET('/v1/health'));
    expect(data).toEqual({ status: 'ok', version: '0.1.0' });
  });

  it('throws ApiError with status/code/message on a non-2xx structured envelope', async () => {
    const { fetchFn } = fakeFetch(() =>
      jsonResponse(404, { error: { code: 'PRODUCT_NOT_FOUND', message: 'not found', requestId: 'req-1' } }),
    );
    const client = createStorefrontClient({ baseUrl: 'http://api.test', fetch: fetchFn });
    await expect(request(client.raw.GET('/v1/shop/catalog/products/{slug}', { params: { path: { slug: 'x' } } })))
      .rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.status).toBe(404);
        expect(apiErr.code).toBe('PRODUCT_NOT_FOUND');
        expect(apiErr.message).toBe('not found');
        expect(apiErr.requestId).toBe('req-1');
        return true;
      });
  });

  it('produces a generic ApiError (not a crash) for a non-envelope error body (proxy/edge error page)', async () => {
    const { fetchFn } = fakeFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
    const client = createStorefrontClient({ baseUrl: 'http://api.test', fetch: fetchFn });
    await expect(request(client.raw.GET('/v1/health'))).rejects.toMatchObject({ status: 502, code: 'UNKNOWN_ERROR' });
  });
});

describe('timeout', () => {
  it('aborts and throws NetworkError when the request exceeds timeoutMs', async () => {
    const fetchFn = vi.fn((input: Request) => new Promise<Response>((_resolve, reject) => {
      input.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const client = createStorefrontClient({ baseUrl: 'http://api.test', timeoutMs: 20, fetch: fetchFn });
    await expect(client.raw.GET('/v1/health')).rejects.toBeInstanceOf(NetworkError);
  });
});
