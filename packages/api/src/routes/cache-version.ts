/**
 * SEO-1 / cache-version: lets a storefront know "has anything changed since I
 * last fetched?" without polling every catalog/content endpoint. Always
 * live — see seo/cache-version.ts for why this is a MAX(updated_at) query
 * and not a counter. `Cache-Control: no-store` because the version itself
 * must never be served stale (a cached "nothing changed" answer defeats the
 * entire point).
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { withStore } from '../db/client.js';
import { resolveStoreFromCtx } from './store-context.js';
import { computeCacheVersion } from '../seo/cache-version.js';

export const cacheVersion = new OpenAPIHono();

cacheVersion.openapi(
  createRoute({
    method: 'get',
    path: '/v1/shop/cache-version',
    summary: 'Per-store monotonic cache-invalidation token',
    responses: {
      200: { description: 'Version', content: { 'application/json': { schema: z.object({ version: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const version = await withStore(st.id, (tx) => computeCacheVersion(tx, st.id));
    return c.json({ version }, 200, { 'cache-control': 'no-store' });
  },
);
