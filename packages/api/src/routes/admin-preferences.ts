// #381: per-admin, per-store UI preferences (table admin_preference, 0114). The Order Export page keeps the settings
// each admin last used and their named presets here, so they follow the admin across browsers. Any admin with access
// to the store may read and write their OWN preferences only (keyed by the signed-in admin's id); values are bounded.
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { HttpError, J, errBody, guard, requireAdmin, requireStore } from './admin-helpers.js';

export const adminPreferences = new OpenAPIHono();

const Key = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const MAX_BYTES = 64 * 1024;

adminPreferences.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/preferences/{key}', summary: "The signed-in admin's saved UI preference for this store (null when none)",
    request: { params: z.object({ key: Key }) },
    responses: { 200: { description: 'OK', content: J(z.object({ key: z.string(), value: z.unknown().nullable() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { key } = c.req.valid('param');
    const [row] = await withStore(st.storeId, (tx) => tx.select({ value: s.adminPreference.value }).from(s.adminPreference)
      .where(and(eq(s.adminPreference.storeId, st.storeId), eq(s.adminPreference.adminUserId, admin.id), eq(s.adminPreference.key, key))).limit(1));
    return c.json({ key, value: row?.value ?? null }, 200);
  }),
);

adminPreferences.openapi(
  createRoute({
    method: 'put', path: '/v1/admin/preferences/{key}', summary: "Save the signed-in admin's UI preference for this store",
    request: { params: z.object({ key: Key }), body: { content: J(z.object({ value: z.unknown() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ key: z.string(), value: z.unknown() })) }, 400: { description: 'Too large', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { key } = c.req.valid('param');
    const { value } = c.req.valid('json');
    if (value === undefined) throw new HttpError(400, 'value is required');
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > MAX_BYTES) throw new HttpError(400, 'preference too large');
    await withStore(st.storeId, (tx) => tx.execute(sql`insert into admin_preference (store_id, admin_user_id, key, value, updated_at)
      values (${st.storeId}, ${admin.id}, ${key}, ${json}::jsonb, now())
      on conflict (store_id, admin_user_id, key) do update set value = excluded.value, updated_at = now()`));
    return c.json({ key, value }, 200);
  }),
);
