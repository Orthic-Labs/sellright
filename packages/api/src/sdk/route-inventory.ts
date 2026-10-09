/**
 * Route inventory (plan 2.5): every method+path registered on the composed app,
 * including handlers added with plain `.get()` / `.on()` that never reach the
 * OpenAPI document. The OpenAPI doc covers only `.openapi()` routes; comparing the
 * two exposes routes that exist but are undocumented, so a new one cannot appear silently.
 */
import type { OpenAPIHono } from '@hono/zod-openapi';

export interface InventoryRoute {
  method: string;
  /** OpenAPI-style path (`/v1/x/{id}`). */
  path: string;
}

export interface RouteInventory {
  /** Every concrete (non-`ALL`) method+path handler, de-duplicated, sorted. */
  routes: InventoryRoute[];
  /** Method-less (`use`/`all`) registrations — middleware and catch-alls — as raw Hono paths, sorted. */
  middleware: string[];
  /** Subset of `routes` present in the OpenAPI document. */
  documented: InventoryRoute[];
  /** `routes` minus `documented`: registered but not in /v1/openapi.json. */
  undocumented: InventoryRoute[];
  /** OpenAPI operations with no registered route (must always be empty). */
  orphanedOpenApi: InventoryRoute[];
}

const toOpenApiPath = (p: string): string => p.replace(/:([A-Za-z0-9_]+)(\{[^}]*\})?/g, '{$1}');
const key = (r: InventoryRoute): string => `${r.method} ${r.path}`;
const sortRoutes = (rs: InventoryRoute[]): InventoryRoute[] => [...rs].sort((a, b) => key(a).localeCompare(key(b)));

export async function routeInventory(app: OpenAPIHono, openapiPath = '/v1/openapi.json'): Promise<RouteInventory> {
  const seen = new Map<string, InventoryRoute>();
  const middleware = new Set<string>();
  for (const r of app.routes) {
    if (r.method === 'ALL') { middleware.add(r.path); continue; }
    const route = { method: r.method.toUpperCase(), path: toOpenApiPath(r.path) };
    seen.set(key(route), route);
  }
  const doc = (await (await app.request(openapiPath)).json()) as { paths?: Record<string, Record<string, unknown>> };
  const openapi: InventoryRoute[] = [];
  for (const [path, ops] of Object.entries(doc.paths ?? {})) {
    for (const method of Object.keys(ops)) {
      if (['get', 'put', 'post', 'delete', 'patch', 'head', 'options'].includes(method)) openapi.push({ method: method.toUpperCase(), path });
    }
  }
  const openapiKeys = new Set(openapi.map(key));
  const routes = sortRoutes([...seen.values()]);
  return {
    routes,
    middleware: [...middleware].sort(),
    documented: routes.filter((r) => openapiKeys.has(key(r))),
    undocumented: routes.filter((r) => !openapiKeys.has(key(r))),
    orphanedOpenApi: sortRoutes(openapi.filter((o) => !seen.has(key(o)))),
  };
}
