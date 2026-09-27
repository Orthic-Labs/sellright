/**
 * Server-only per-request Host, threaded to `sr()` (utils/sellright.ts) so an
 * SSR fetch to the SellRight API can resolve the correct store by the
 * INCOMING browser request's Host header — not a build-time slug (WS-C:
 * runtime storefront configuration, plan §1.9). One generic image serves any
 * store because this, not VITE_SELLRIGHT_STORE_SLUG, is what tells the API
 * which store's config to return.
 *
 * `.server.ts` is a Qwik City convention: stripped from the client bundle
 * (replaced with a throwing stub) — safe to import isomorphically as long as
 * the actual call stays behind `isServer`, matching
 * sellright-request-context.server.ts's cookie-forwarding sibling.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const sellrightRequestHost = new AsyncLocalStorage<string | undefined>();
