/**
 * One gate for every storefront-facing API read and write: an unpublished store
 * answers 404 unless the request carries its preview token. /v1/shop/config
 * keeps its own check (routes/shop-config.ts) and is exempt here.
 *
 * The store is resolved through the same resolver the routes use, which keeps an
 * in-process cache, so a published store costs no extra database query. If the
 * store cannot be resolved the gate steps aside and the route raises its own
 * routing error, exactly as it did before the gate existed.
 */
import type { MiddlewareHandler } from 'hono';
import { resolveStoreFromCtx } from './routes/store-context.js';
import { canViewStorefront, StoreNotPublishedError } from './store-publish.js';

/** The storefront sets this non-HttpOnly cookie while a preview is active; same-origin browser calls carry it. */
export const PREVIEW_TOKEN_COOKIE = 'sr_preview_token';

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    if (!raw) return undefined;
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  return undefined;
}

/** Sources, in order: x-preview-token header, preview_token query param (as shop-config.ts), then the sr_preview_token cookie. */
export function previewTokenFrom(c: { req: { header: (k: string) => string | undefined; query: (k: string) => string | undefined } }): string | undefined {
  return c.req.header('x-preview-token') || c.req.query('preview_token') || cookieValue(c.req.header('cookie'), PREVIEW_TOKEN_COOKIE) || undefined;
}

const EXEMPT_PATHS = new Set(['/v1/shop/config']);

export function storePublishGate(
  resolve: typeof resolveStoreFromCtx = resolveStoreFromCtx,
): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS' || EXEMPT_PATHS.has(c.req.path)) return next();
    let config: unknown;
    try {
      config = (await resolve(c)).config;
    } catch {
      return next();
    }
    if (!canViewStorefront(config, previewTokenFrom(c))) throw new StoreNotPublishedError();
    return next();
  };
}
