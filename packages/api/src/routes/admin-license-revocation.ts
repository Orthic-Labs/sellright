// Admin kill switch routes for the license lifecycle service (de-fork Phase 5).
// Exported as a factory-free Hono app but NOT mounted by app.ts: default SellRight
// behaviour is unchanged. A consumer (RightSites plugin) mounts it explicitly.
// Gated by the dedicated `license_revocation` permission (owner/manager pass).
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { J, guard, requireAdmin, requirePermission, requireStore, requireWrite, HttpError } from './admin-helpers.js';
import { LICENSE_REVOCATION_PERMISSION, licenseLifecycle } from '../licensing/license-revocation.js';

const errBody = { content: J(z.object({ error: z.object({ code: z.string(), message: z.string() }).partial().passthrough() }).passthrough()) };
const Params = z.object({ id: z.string().uuid() });

export const adminLicenseRevocationRoutes = new OpenAPIHono();

adminLicenseRevocationRoutes.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/licenses/{id}/revoke', summary: 'Revoke a license and cascade to its active activations',
    request: { params: Params, body: { content: J(z.object({ reason: z.string().trim().min(1).max(500).optional() })) } },
    responses: {
      200: { description: 'Revoked', content: J(z.object({ id: z.string(), status: z.literal('revoked'), changed: z.boolean(), revokedActivations: z.number().int() })) },
      401: { description: 'Unauthorized', ...errBody },
      403: { description: 'Forbidden', ...errBody },
      404: { description: 'Not found', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    requirePermission(st, LICENSE_REVOCATION_PERMISSION);
    const { id } = c.req.valid('param');
    const { reason } = c.req.valid('json');
    const out = await licenseLifecycle.revoke(st.storeId, id, { actor: admin.email, reason: reason ?? null });
    if (out.kind === 'notfound') throw new HttpError(404, 'license not found', 'NOT_FOUND');
    return c.json({ id: out.licenseId, status: out.status, changed: out.changed, revokedActivations: out.revokedActivationIds.length }, 200);
  }),
);

adminLicenseRevocationRoutes.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/licenses/{id}/restore', summary: 'Restore a revoked license (activations are not reactivated)',
    request: { params: Params },
    responses: {
      200: { description: 'Restored', content: J(z.object({ id: z.string(), status: z.literal('active'), changed: z.boolean() })) },
      401: { description: 'Unauthorized', ...errBody },
      403: { description: 'Forbidden', ...errBody },
      404: { description: 'Not found', ...errBody },
      409: { description: 'Refused (license expired)', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    requireWrite(st);
    requirePermission(st, LICENSE_REVOCATION_PERMISSION);
    const { id } = c.req.valid('param');
    const out = await licenseLifecycle.restore(st.storeId, id, { actor: admin.email });
    if (out.kind === 'notfound') throw new HttpError(404, 'license not found', 'NOT_FOUND');
    if (out.kind === 'refused') throw new HttpError(409, 'license has expired and cannot be restored', 'LICENSE_EXPIRED');
    return c.json({ id: out.licenseId, status: out.status, changed: out.changed }, 200);
  }),
);
