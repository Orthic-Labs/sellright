/**
 * Pre-route response policy (defork plan 3.1).
 *
 * A plugin may declare a route set plus an error-body transformer. For error
 * responses (status >= 400, JSON body) on a declared route the engine hands
 * the parsed body to the transformer and re-emits the result. Status, headers
 * (including x-request-id) are carried over from the original response by
 * construction; the transformer can only replace the JSON body.
 *
 * The admin API (`/v1/admin`) is never transformed, whatever a plugin declares.
 */
import type { MiddlewareHandler } from 'hono';
import type { ApiPlugin } from './plugins.js';
import { err } from './lib/logger.js';

/** A route a policy applies to. `method` defaults to every method. */
export interface RoutePattern {
  method?: string | readonly string[];
  /**
   * Exact path, `/prefix/*` (the prefix and everything under it), or a path
   * with `:param` segments matching exactly one segment each.
   */
  path: string;
}

export interface ErrorResponseContext {
  status: number;
  method: string;
  path: string;
  /** Request id echoed on the response, if any. */
  requestId: string | undefined;
  /** Original response headers (read-only snapshot). */
  headers: Headers;
}

/** Return a replacement JSON body, or `undefined` to leave the response untouched. */
export type ErrorBodyTransformer = (body: unknown, ctx: ErrorResponseContext) => unknown | undefined;

export interface ErrorResponsePolicy {
  routes: readonly RoutePattern[];
  transform: ErrorBodyTransformer;
}

/** Never transformed by any plugin policy. */
const PROTECTED_PREFIXES = ['/v1/admin'];

export function isProtectedPath(path: string): boolean {
  return PROTECTED_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

export function pathMatches(pattern: string, path: string): boolean {
  if (pattern === '/*') return true;
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2);
    return path === prefix || path.startsWith(prefix + '/');
  }
  if (!pattern.includes(':')) return pattern === path;
  const a = pattern.split('/');
  const b = path.split('/');
  return a.length === b.length && a.every((seg, i) => (seg.startsWith(':') ? (b[i] ?? '') !== '' : seg === b[i]));
}

export function routeMatches(routes: readonly RoutePattern[], method: string, path: string): boolean {
  const m = method.toUpperCase();
  return routes.some((r) => {
    const methods = r.method === undefined ? undefined : typeof r.method === 'string' ? [r.method] : r.method;
    const methodOk = !methods || methods.some((x) => x === '*' || x.toUpperCase() === m);
    return methodOk && pathMatches(r.path, path);
  });
}

/**
 * Middleware applying every registered plugin's `errorPolicy`, in registration
 * order. Plugins are read per request so registration order relative to
 * createApp() cannot matter. Mount right after the request-id middleware so
 * app.onError output (which Hono sets as c.res) is covered.
 */
export function preRoutePolicy(getPlugins: () => readonly ApiPlugin[]): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const policies = getPlugins().flatMap((p) => (p.errorPolicy ? [p.errorPolicy] : []));
    if (policies.length === 0) return;
    let res = c.res;
    if (res.status < 400) return;
    const method = c.req.method;
    const path = c.req.path;
    if (isProtectedPath(path)) return;
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) return;
    const active = policies.filter((p) => routeMatches(p.routes, method, path));
    if (active.length === 0) return;
    let body: unknown;
    try { body = await res.clone().json(); } catch { return; }
    let changed = false;
    for (const policy of active) {
      let next: unknown;
      try {
        next = policy.transform(body, {
          status: res.status,
          method,
          path,
          requestId: res.headers.get('x-request-id') ?? undefined,
          headers: new Headers(res.headers),
        });
      } catch (e) {
        // A faulty plugin transformer must never turn an error response into a
        // different failure: keep the body produced so far and log.
        err.error('pre-route policy transformer threw; keeping original body', e, { method, path });
        continue;
      }
      if (next !== undefined) { body = next; changed = true; }
    }
    if (!changed) return;
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    res = new Response(JSON.stringify(body), { status: res.status, headers });
    c.res = res;
  };
}
