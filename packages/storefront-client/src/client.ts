/**
 * Thin typed fetch client over the SellRight REST API — no GraphQL, no
 * hand-duplicated response shapes (everything comes from
 * `generated/schema.d.ts`, produced from the API's own OpenAPI contract by
 * `pnpm generate`). Wraps `openapi-fetch` with the request/response
 * behaviors every SellRight storefront needs:
 *
 *   - a configurable base URL + per-store resolution header
 *   - `credentials: 'include'` so the session/CSRF cookies the API sets ride
 *     along automatically in a browser
 *   - the double-submit CSRF header (`x-csrf-token`, read from the
 *     `sr_cust_csrf` cookie) attached automatically on mutating methods —
 *     see packages/api/src/auth/cookies.ts's `customerCsrfValid`
 *   - `idempotency-key` passthrough (the generated types already require it
 *     on the endpoints that need it — e.g. POST .../gateway-payment — this
 *     just documents the convention; nothing to opt into)
 *   - typed errors: every non-2xx response is thrown as an `ApiError`
 *     carrying `status`/`code`/`message`/`param`/`requestId`
 *   - a request timeout (default 8s, matching the SSR fetch timeout the
 *     current storefront's `sr()` helper uses) via `AbortSignal.timeout`
 *
 * SSR + browser safe: nothing here references `window`/`document` at module
 * scope — the CSRF cookie read only happens inside a request, guarded by an
 * `isBrowser` check, and SSR callers pass `forwardCookie` explicitly (the
 * same pattern the current storefront's `sellright-request-context.server`
 * uses) instead of relying on `document.cookie`. Tree-shakeable: this module
 * has no side effects at import time (`"sideEffects": false` in
 * package.json), and `errors.ts`/`types.ts` are separate entry points a
 * bundler can drop if unused.
 */
import createOpenApiClient, { type Middleware } from 'openapi-fetch';
import type { paths } from './generated/schema.js';
import { ApiError, NetworkError, unknownApiError } from './errors.js';

const isBrowser = typeof document !== 'undefined';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Matches packages/api/src/auth/cookies.ts's CUST_CSRF_COOKIE. Intentionally
 *  NOT the admin `sr_csrf` cookie — this client is shop-surface only. */
const CUST_CSRF_COOKIE = 'sr_cust_csrf';
const DEFAULT_TIMEOUT_MS = 8000;

export interface StorefrontClientOptions {
  /** e.g. `https://api.example.com` or `http://127.0.0.1:3300` for SSR. */
  baseUrl: string;
  /** Sent as `x-store-slug` on every request — the same header
   *  `resolveStoreFromCtx` reads (packages/api/src/routes/store-context.ts).
   *  Omit when resolving by Host instead (pass `forwardedHost`). */
  storeSlug?: string;
  /** SSR per-host store resolution (WS-C): forwarded as `x-forwarded-host`
   *  when `storeSlug` isn't set, mirroring the current storefront's
   *  `storeResolutionHeaders()`. Never read in the browser (the browser's
   *  own Host header already resolves the store). */
  forwardedHost?: string;
  /** SSR only: the incoming request's own `Cookie` header, forwarded so a
   *  server-side call resolves to the SAME session the browser has, instead
   *  of an anonymous server-to-server call. Never used in the browser
   *  (cookies ride along natively via `credentials: 'include'`). */
  forwardCookie?: string;
  /** Milliseconds before a request is aborted. `0`/`Infinity` disables the
   *  timeout — only ever do that for a caller that supplies its own
   *  AbortSignal. Default 8000, matching the storefront's existing SSR
   *  fetch bound. */
  timeoutMs?: number;
  /** Override the CSRF cookie read (tests, non-browser environments with
   *  their own cookie jar). Defaults to reading `sr_cust_csrf` from
   *  `document.cookie` in a browser, and to nothing during SSR (SSR
   *  mutations authenticate via `forwardCookie`, whose CSRF cookie is
   *  already IN that forwarded Cookie header — double-submit still checks
   *  it against the `x-csrf-token` header, so SSR callers that mutate on a
   *  customer's behalf must supply this explicitly, read from the same
   *  incoming request). */
  getCsrfToken?: () => string | undefined;
  /** Swap the underlying fetch (tests, non-standard runtimes). Matches
   *  openapi-fetch's own `fetch` option signature — narrower than the global
   *  `fetch` (it's always called with a fully-formed `Request`, never a bare
   *  URL string). */
  fetch?: (input: Request) => Promise<Response>;
}

function readBrowserCsrfCookie(): string | undefined {
  if (!isBrowser) return undefined;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${CUST_CSRF_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1] as string) : undefined;
}

function csrfMiddleware(getCsrfToken: () => string | undefined): Middleware {
  return {
    onRequest({ request }) {
      if (!MUTATING_METHODS.has(request.method)) return undefined;
      const token = getCsrfToken();
      if (token) request.headers.set('x-csrf-token', token);
      return undefined;
    },
  };
}

function storeResolutionMiddleware(opts: Pick<StorefrontClientOptions, 'storeSlug' | 'forwardedHost'>): Middleware {
  return {
    onRequest({ request }) {
      if (opts.storeSlug) request.headers.set('x-store-slug', opts.storeSlug);
      else if (opts.forwardedHost) request.headers.set('x-forwarded-host', opts.forwardedHost);
      return undefined;
    },
  };
}

function forwardCookieMiddleware(cookieHeader: string): Middleware {
  return {
    onRequest({ request }) {
      request.headers.set('cookie', cookieHeader);
      return undefined;
    },
  };
}

/** Bounds every request to `timeoutMs` via `AbortSignal.any` — combines
 *  whatever signal the request already carries (a caller-supplied one, or
 *  fetch's own default non-aborting signal when none was given) with a fresh
 *  timeout signal, so a caller's own AbortController still works exactly as
 *  before AND a request that would otherwise hang forever is still bounded.
 *  This is what makes the client's stock/cart/checkout calls fail CLOSED
 *  within a predictable window instead of hanging an SSR render — see the
 *  locked stock-architecture rule: no request may block indefinitely. */
function timeoutMiddleware(timeoutMs: number): Middleware {
  return {
    onRequest({ request }) {
      if (!timeoutMs || !Number.isFinite(timeoutMs)) return undefined;
      const bounded = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
      return new Request(request, { signal: bounded });
    },
  };
}

/** Throws NetworkError so an unreachable API is never confused with a
 *  well-formed non-2xx `ApiError` — callers that need to fail closed (stock,
 *  cart, checkout) branch on this. */
function networkErrorMiddleware(): Middleware {
  return {
    async onError({ error }) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new NetworkError('SellRight API request timed out', error);
      }
      throw new NetworkError('SellRight API request failed', error);
    },
  };
}

export type StorefrontApiPaths = paths;

export interface StorefrontClient {
  /** The underlying openapi-fetch client — `GET`/`POST`/`PUT`/`PATCH`/`DELETE`/etc.,
   *  fully typed against `generated/schema.d.ts`. Prefer `request()` below,
   *  which throws `ApiError`/`NetworkError` instead of returning a
   *  `{ data, error }` tuple you have to check every time. */
  raw: ReturnType<typeof createOpenApiClient<paths>>;
}

/** Trims trailing `/` characters WITHOUT a regex — `baseUrl` is caller-
 *  supplied config, but CodeQL flags any `/+$/`-style pattern against
 *  "library input" as a potential polynomial-time ReDoS regardless of
 *  actual exploitability, so this stays a plain, linear-time loop instead. */
function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}

/** Build a client bound to one API instance/store. Cheap — safe to create
 *  per-request in an SSR handler (it holds no connection state) or once at
 *  module scope in the browser. */
export function createStorefrontClient(options: StorefrontClientOptions): StorefrontClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const getCsrfToken = options.getCsrfToken ?? readBrowserCsrfCookie;

  const raw = createOpenApiClient<paths>({
    baseUrl: stripTrailingSlashes(options.baseUrl),
    // Browser: cookies ride along automatically. SSR: there's no cookie jar
    // to include from — forwardCookie (below) carries the browser's own
    // Cookie header instead. `include` is harmless either way.
    credentials: 'include',
    fetch: options.fetch,
  });

  raw.use(storeResolutionMiddleware(options));
  if (!isBrowser && options.forwardCookie) raw.use(forwardCookieMiddleware(options.forwardCookie));
  raw.use(csrfMiddleware(getCsrfToken));
  raw.use(timeoutMiddleware(timeoutMs));
  raw.use(networkErrorMiddleware());

  return { raw };
}

type OpenApiFetchResult<T> = { data?: T; error?: unknown; response: Response };

/** Unwrap an openapi-fetch call result: returns `data` on success, throws a
 *  typed `ApiError` on any non-2xx response. This is the ergonomic surface
 *  most call sites want — `const cart = await request(client.raw.POST(...))`
 *  — instead of checking `.error` by hand at every call site. */
export async function request<T>(result: Promise<OpenApiFetchResult<T>>): Promise<T> {
  const { data, error, response } = await result;
  if (error !== undefined) throw unknownApiError(response.status, error);
  if (data === undefined) {
    // openapi-fetch resolves this way for a 2xx with an unparseable/empty
    // body — never silently return `undefined` as if it were a real value.
    throw new ApiError(response.status, {
      error: { code: 'EMPTY_RESPONSE', message: 'The API returned an empty or unparseable response body' },
    });
  }
  return data;
}

/** Attach a bounded timeout to a per-call `signal` unless the caller already
 *  supplied one. Exported so call sites building their own `fetch` options
 *  (rather than going through `request()`) still get the same fail-closed
 *  timeout behavior `sr()` (the current storefront helper) already relies on. */
export function withTimeout(timeoutMs = DEFAULT_TIMEOUT_MS, existing?: AbortSignal): AbortSignal | undefined {
  if (existing) return existing;
  if (!timeoutMs || !Number.isFinite(timeoutMs)) return undefined;
  return AbortSignal.timeout(timeoutMs);
}
