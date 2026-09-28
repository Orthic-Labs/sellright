/**
 * Framework-agnostic equivalent of the native SellRight client a storefront
 * fork prototyped directly inside its own tree
 * (`packages/storefront/src/sellright/client.ts`, branch `sf-native`):
 * `sellright()`, `SellRightError`, `idempotency()`. That version hard-coded
 * Qwik (`@qwik.dev/core/build`'s `isServer`, the storefront's own
 * `apiBase()`/`storeResolutionHeaders()`/`sellrightRequestCookie`) directly
 * into the client module — fine for one storefront, not reusable as a
 * package.
 *
 * This module is the SAME three names, SAME call-site shapes, built on top
 * of `createStorefrontClient` (`client.ts`) instead — every environment
 * dependency (base URL, "is this SSR", cookie/CSRF reads, store headers) is
 * injected via `configureSellRightClient()` instead of imported directly.
 * A storefront adopting this package writes ONE small adapter file that
 * calls `configureSellRightClient({...})` with its own framework's
 * primitives and re-exports `sellright`/`idempotency`/`SellRightError` from
 * here — every existing call site (`sellright().GET(...)`,
 * `err instanceof SellRightError`, `idempotency(key)`) then keeps compiling
 * unchanged, because it never imported this package directly in the first
 * place.
 *
 * Values are thunks (`() => T`), not static values, because SSR needs a
 * PER-REQUEST base URL/cookie/store header — a config object built once at
 * module scope can't carry that; a function re-read on every `sellright()`
 * call can.
 */
import { createStorefrontClient, type StorefrontClient } from './client.js';
import { ApiError } from './errors.js';

/** Same class as `ApiError` (not a subclass) — `err instanceof SellRightError`
 *  is `true` for exactly the errors this client already throws as `ApiError`,
 *  with the same `status`/`code`/`message`/`param`/`requestId`/`body`. */
export const SellRightError = ApiError;
export type SellRightError = ApiError;

export interface SellRightClientConfig {
  /** e.g. `() => 'https://api.example.com'`, or `() => ''` for same-origin
   *  browser calls. Re-read on every `sellright()` call — the SSR base URL
   *  can differ per request (multi-tenant/per-host deploys). */
  baseUrl: () => string;
  /** `true` during SSR/SSG, `false` in the browser — gates which of
   *  `forwardCookie`/`getCsrfToken` actually applies (mirrors the sf-native
   *  prototype's `isServer` branch). Defaults to `typeof document ===
   *  'undefined'` when omitted. */
  isServer?: () => boolean;
  /** SSR only: the incoming request's `Cookie` header, so a server-side call
   *  resolves to the browser's own session instead of an anonymous one. */
  forwardCookie?: () => string | undefined;
  /** Sent as `x-store-slug`. Omit (or return `undefined`) to resolve by
   *  `forwardedHost`/Host instead. */
  storeSlug?: () => string | undefined;
  /** SSR per-host store resolution, forwarded as `x-forwarded-host`. */
  forwardedHost?: () => string | undefined;
  /** Browser CSRF cookie read (double-submit `x-csrf-token` on mutations).
   *  Defaults to reading `sr_cust_csrf` from `document.cookie` — override
   *  only for a non-browser-cookie-jar environment or tests. */
  getCsrfToken?: () => string | undefined;
  /** Default 8000ms (see `client.ts`'s `DEFAULT_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Swap the underlying fetch (tests, non-standard runtimes). */
  fetch?: typeof fetch;
}

let config: SellRightClientConfig | undefined;

/** Call once, at app/adapter startup, with this storefront's own
 *  environment primitives. Safe to call again (e.g. in tests) — replaces
 *  the previous configuration outright. `undefined` clears it back to the
 *  unconfigured state (tests only — a real adapter never needs this). */
export function configureSellRightClient(next: SellRightClientConfig | undefined): void {
  config = next;
}

function readBrowserCsrfCookie(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.match(/(?:^|;\s*)sr_cust_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1] as string) : undefined;
}

/** Build a client bound to the CURRENT request's environment (resolves every
 *  configured thunk fresh). Cheap — safe to call per-request in SSR or once
 *  per call in the browser, exactly like the sf-native prototype's
 *  zero-argument `sellright()`. Throws if `configureSellRightClient` was
 *  never called — a storefront adopting this package must configure it
 *  before first use (its adapter file's whole job). */
export function sellright(): StorefrontClient['raw'] {
  if (!config) {
    throw new Error(
      'sellright(): configureSellRightClient() was never called. ' +
        'Call it once at startup (your storefront-client adapter file) with this app\'s baseUrl/store/cookie primitives.',
    );
  }
  const isServer = config.isServer ? config.isServer() : typeof document === 'undefined';
  const forwardCookie = isServer ? config.forwardCookie?.() : undefined;
  const getCsrfToken = config.getCsrfToken ?? readBrowserCsrfCookie;

  return createStorefrontClient({
    baseUrl: config.baseUrl(),
    storeSlug: config.storeSlug?.(),
    forwardedHost: config.forwardedHost?.(),
    forwardCookie,
    getCsrfToken,
    timeoutMs: config.timeoutMs,
    fetch: config.fetch,
  }).raw;
}

/** Idempotency header for retry-safe mutations (checkout, gateway-payment
 *  attempts). Spread into the call's headers — this package puts it under
 *  `params.header` for `openapi-fetch`'s typed calls; a plain object either
 *  way. */
export function idempotency(key: string): { 'idempotency-key': string } {
  return { 'idempotency-key': key };
}
