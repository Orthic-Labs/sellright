// Tenant-bound revocation feed (de-fork Phase 5). Read-only, unauthenticated
// list of revoked license ids for ONE tenant (store). The tenant is chosen by
// the caller-supplied resolver (never by request input), the query carries an
// explicit store predicate on top of per-store RLS, and only opaque license ids
// leave the process. Wire shape is frozen for shipped Workers:
// `{"ids":[...],"updatedAt":"<ISO>"}` with `cache-control: public, max-age=60`.
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { and, eq, asc } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { J } from '../routes/admin-helpers.js';

export interface RevocationFeedOptions {
  /** Resolve the tenant (store id) for this request. Must not read request input. */
  resolveTenant: (c: Context) => Promise<{ id: string }>;
  /** Override the compatibility path; defaults to the frozen public URL. */
  path?: string;
}

export const REVOCATION_FEED_PATH = '/v1/pro/revocations';

export function createLicenseRevocationFeed(options: RevocationFeedOptions): OpenAPIHono {
  const app = new OpenAPIHono();
  app.openapi(
    createRoute({
      method: 'get',
      path: options.path ?? REVOCATION_FEED_PATH,
      summary: 'Opaque list of revoked license ids for one tenant',
      responses: {
        200: {
          description: 'Revoked license ids',
          content: J(z.object({ ids: z.array(z.string()), updatedAt: z.string() })),
        },
      },
    }),
    async (c) => {
      const tenant = await options.resolveTenant(c);
      const rows = await withStore(tenant.id, (tx) => tx
        .select({ id: s.license.id })
        .from(s.license)
        .where(and(eq(s.license.storeId, tenant.id), eq(s.license.status, 'revoked')))
        .orderBy(asc(s.license.id)));
      c.header('cache-control', 'public, max-age=60');
      return c.json({ ids: rows.map((r) => r.id), updatedAt: new Date().toISOString() }, 200);
    },
  );
  return app;
}
