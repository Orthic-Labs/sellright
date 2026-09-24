/**
 * Server-only per-request context so `sr()` (utils/sellright.ts) can forward
 * the INCOMING browser request's cookie header on SSR fetches to the
 * SellRight API. Without this, every SSR data load hits the API as an
 * anonymous request — harmless on the normal storefront (auth pages already
 * re-fetch client-side after hydration) but fatal for the isolated demo,
 * where every /v1/* call is scoped to a per-visitor httpOnly cookie
 * (deploy/demo/interactive-server.mjs) and an anonymous SSR fetch 401s.
 *
 * `.server.ts` is a Qwik City convention: this module is stripped from the
 * client bundle (replaced with a throwing stub), so it is safe to import
 * from isomorphic code as long as the actual call stays behind `isServer`.
 * node:async_hooks is Node-only, which is fine — this package only ships a
 * Node/Express adapter (adapters/express).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const sellrightRequestCookie = new AsyncLocalStorage<string | undefined>();
