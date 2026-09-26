/**
 * Internal Cloudflare cache-purge route. Deliberately NOT gated by the admin
 * session (requireAdmin/requireStore) — it is a machine-to-machine ops
 * endpoint (deploy scripts, on-call runbooks), authenticated by a single
 * shared secret instead. Fail closed when that secret isn't configured
 * (never fall back to an unauthenticated purge), constant-time compare it
 * (never `===`, which leaks timing info about how many leading bytes match),
 * and rate-limit it (a purge is a real outbound Cloudflare API call, and a
 * shared token is easier to guess than a full login).
 *
 * Automatic purges on product/variant/stock change are wired separately, at
 * commit time, via cache/purge-hook.ts (see manifest/stock-hook.ts and
 * webhooks/catalog.ts) — this route is for a manual/scripted "purge now".
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';
import { standardPurgeUrls } from '../cache/purge-hook.js';
import { purgeCloudflareUrls, resolveCloudflareConfig } from '../cache/cloudflare-purge.js';
import { attemptRetryAfter, clientIp } from '../auth/rate-limit.js';
import { HttpError, J, errBody, guard } from './admin-helpers.js';

export const adminCache = new OpenAPIHono();

export const CACHE_ADMIN_TOKEN_HEADER = 'x-cache-admin-token';

/** Constant-time token compare. Different lengths short-circuit (this only
 * leaks the fact that the guess had the wrong length, not which bytes of a
 * same-length guess matched) before ever calling timingSafeEqual, which
 * throws on mismatched buffer lengths. */
function tokenMatches(expected: string, provided: string | undefined | null): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

adminCache.openapi(
  createRoute({
    method: 'post',
    path: '/v1/admin/cache/purge',
    summary: "Purge a store's Cloudflare edge cache (internal ops token, not an admin session)",
    request: {
      body: {
        content: J(z.object({
          storeSlug: z.string().min(1),
          // Explicit URLs to purge; omit to purge the standard shop/sitemap set for this store.
          urls: z.array(z.string().url()).max(100).optional(),
        })),
      },
    },
    responses: {
      200: { description: 'OK', content: J(z.object({ ok: z.boolean(), purged: z.boolean(), reason: z.string().optional() })) },
      401: { description: 'Bad/missing token', ...errBody },
      429: { description: 'Rate limited', ...errBody },
      503: { description: 'CACHE_ADMIN_TOKEN is not configured (fail closed)', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const expected = env.CACHE_ADMIN_TOKEN;
    if (!expected) throw new HttpError(503, 'CACHE_ADMIN_TOKEN is not configured');

    const provided = c.req.header(CACHE_ADMIN_TOKEN_HEADER);
    if (!tokenMatches(expected, provided)) throw new HttpError(401, 'invalid or missing cache admin token');

    const retryAfter = attemptRetryAfter(clientIp(c), 'cache-purge');
    if (retryAfter > 0) {
      c.header('retry-after', String(retryAfter));
      throw new HttpError(429, 'rate limited — try again shortly');
    }

    const { storeSlug, urls: requested } = c.req.valid('json');

    if (!resolveCloudflareConfig(storeSlug)) {
      return c.json({ ok: true, purged: false, reason: 'no Cloudflare zone/token configured for this store' }, 200);
    }

    const urls = requested?.length ? requested : standardPurgeUrls(storeSlug);
    if (!urls) return c.json({ ok: true, purged: false, reason: 'no storefront origin configured for this store' }, 200);

    const purged = await purgeCloudflareUrls(storeSlug, urls);
    return c.json({ ok: true, purged }, 200);
  }),
);
