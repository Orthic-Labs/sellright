/**
 * Device registration for the admin mobile app (0039).
 *
 * The device token comes from APNs on the phone and is meaningless to anyone
 * else — but it links a person to a physical device, so it's treated as personal
 * data: RLS-scoped like every other table, bound to the AUTHENTICATED admin (the
 * client never says who it is), and deleted on logout / 410 / admin deletion.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import { J, errBody, requireAdmin, requireStore, guard } from './admin-helpers.js';

export const adminPush = new OpenAPIHono();

const DeviceBody = z.object({
  token: z.string().min(32).max(400),
  // 'apns' = alert pushes; 'live_activity' = the push-to-start token that lets
  // the server light up the Dynamic Island for a new order. A device registers
  // both, separately, as iOS hands them over.
  kind: z.enum(['apns', 'live_activity']).optional(),
  // The app reports which APNs environment its token was minted in. A Debug
  // build's token is sandbox-only; pushing it to the production host fails with
  // BadDeviceToken. Getting this wrong is the single most common "push silently
  // does nothing" cause, so it's explicit rather than inferred server-side.
  environment: z.enum(['production', 'sandbox']).optional(),
  topics: z.array(z.string()).min(1).max(20).optional(),
});

adminPush.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/devices', summary: 'Register this device for push',
    request: { body: { content: J(DeviceBody) } },
    responses: {
      200: { description: 'Registered', content: J(z.object({ ok: z.boolean(), topics: z.array(z.string()) })) },
      401: { description: 'Unauthorized', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const body = c.req.valid('json');
    const topics = body.topics ?? ['order.paid'];
    const environment = body.environment ?? env.APNS_DEFAULT_ENVIRONMENT;

    await withStore(st.storeId, async (tx) => {
      // `token` is unique across the table: the same phone re-registering (app
      // relaunch, token rotation, or a DIFFERENT operator signing in on a shared
      // device) rebinds the row to whoever is authenticated now. Without the
      // rebind, a device handed over would keep pushing to its previous owner.
      await tx
        .insert(s.adminDeviceToken)
        .values({ storeId: st.storeId, adminUserId: admin.id, token: body.token, kind: body.kind ?? 'apns', environment, topics })
        .onConflictDoUpdate({
          target: s.adminDeviceToken.token,
          set: { storeId: st.storeId, adminUserId: admin.id, kind: body.kind ?? 'apns', environment, topics, lastSeenAt: new Date() },
        });
    });
    return c.json({ ok: true, topics }, 200);
  }),
);

adminPush.openapi(
  createRoute({
    method: 'delete', path: '/v1/admin/devices/{token}', summary: 'Unregister this device',
    request: { params: z.object({ token: z.string() }) },
    responses: {
      200: { description: 'Unregistered', content: J(z.object({ ok: z.boolean() })) },
      401: { description: 'Unauthorized', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { token } = c.req.valid('param');
    await withStore(st.storeId, async (tx) => {
      // Scoped to the calling admin: signing out of your phone must not be able
      // to silence a colleague's device by guessing their token. RLS already
      // pins the store; this pins the operator.
      await tx.delete(s.adminDeviceToken).where(
        and(eq(s.adminDeviceToken.token, token), eq(s.adminDeviceToken.adminUserId, admin.id)),
      );
    });
    // Idempotent by design: unregistering an already-gone token is a success,
    // so a retry after a flaky logout doesn't strand the client in an error.
    return c.json({ ok: true }, 200);
  }),
);
