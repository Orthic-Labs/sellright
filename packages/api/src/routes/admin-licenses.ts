import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { desc, eq } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { mintLicense } from '../licensing/mint.js';
import { getEntitlementIssuanceInventory } from '../licensing/activations.js';
import { normalizeEmail } from '../auth/email.js';
import { requireAdmin, requireStore, requireWrite, requirePermission, guard, J, errBody } from './admin-helpers.js';

export const adminLicenses = new OpenAPIHono();

const addDays = (days: number | null): Date | null =>
  days == null ? null : new Date(Date.now() + days * 86_400_000);

const MintIn = z.object({
  appKey: z.string().min(1),
  seats: z.number().int().min(1).default(1),
  // null/omitted => perpetual. A positive number => that many days from now.
  licenseDurationDays: z.number().int().positive().nullable().optional(),
  updatesDurationDays: z.number().int().positive().nullable().optional(),
  email: z.string().email().optional(),
  licenseKey: z.string().min(3).optional(),
  // Audit requirement: orderless issuance carries EXPLICIT provenance — a
  // non-empty human-readable reason is mandatory, the authorizing admin is
  // taken from the session (never the request body), and every mint writes an
  // audit_log row. No silent license creation.
  reason: z.string().trim().min(3),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

adminLicenses.openapi(
  createRoute({
    method: 'get',
    path: '/v1/admin/licenses/entitlement-inventory',
    summary: 'Inventory canonical entitlement issuance before legacy-verifier removal',
    request: { query: z.object({ appKey: z.string().min(1).optional() }) },
    responses: {
      200: {
        description: 'Canonical entitlement issuance inventory',
        content: J(z.object({
          appKey: z.string().nullable(),
          canonicalV2: z.number().int().nonnegative(),
          legacyOrUnknown: z.number().int().nonnegative(),
          canRemoveLegacyVerifier: z.boolean(),
        })),
      },
      401: { description: 'Unauthorized', ...errBody },
      403: { description: 'Forbidden', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { appKey } = c.req.valid('query');
    const inventory = await withStore(st.storeId, (tx) =>
      getEntitlementIssuanceInventory(tx, { appKey }));
    return c.json({ appKey: appKey ?? null, ...inventory }, 200);
  }),
);

adminLicenses.openapi(
  createRoute({
    method: 'post',
    path: '/v1/admin/licenses',
    summary: 'Mint a license outside the order pipeline (creator/comp/support)',
    request: { body: { content: J(MintIn) } },
    responses: {
      200: {
        description: 'Minted',
        content: J(z.object({
          licenseId: z.string(), licenseKey: z.string(), appKey: z.string(),
          seats: z.number().int(), updatesUntil: z.string().nullable(), expiresAt: z.string().nullable(),
        })),
      },
      400: { description: 'Bad request', ...errBody },
      401: { description: 'Unauthorized', ...errBody },
      403: { description: 'Forbidden', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    // Non-revenue entitlement creation is a manage-class capability: staff
    // need the explicit 'licenses' permission, owner/manager pass by role.
    requireWrite(st); requirePermission(st, 'licenses');
    const body = c.req.valid('json');
    const out = await withStore(st.storeId, async (tx) => {
      let customerId: string | null = null;
      if (body.email) {
        const [cust] = await tx.select({ id: s.customer.id }).from(s.customer)
          .where(eq(s.customer.email, normalizeEmail(body.email))).limit(1);
        customerId = cust?.id ?? null;
      }
      const updatesUntil = addDays(body.updatesDurationDays ?? null);
      const expiresAt = addDays(body.licenseDurationDays ?? null);
      const r = await mintLicense(tx, {
        storeId: st.storeId, appKey: body.appKey, seats: body.seats,
        updatesUntil, expiresAt, customerId, licenseKey: body.licenseKey,
        metadata: body.metadata ?? null,
        issuedBy: admin.email, reason: body.reason,
      });
      await tx.insert(s.auditLog).values({
        storeId: st.storeId, actor: admin.email, entity: 'license', entityId: r.licenseId,
        action: 'mint',
        data: { appKey: body.appKey, seats: body.seats, reason: body.reason, email: body.email ?? null },
      });
      return { ...r, updatesUntil, expiresAt };
    });
    return c.json({
      licenseId: out.licenseId, licenseKey: out.licenseKey, appKey: body.appKey, seats: body.seats,
      updatesUntil: out.updatesUntil?.toISOString() ?? null, expiresAt: out.expiresAt?.toISOString() ?? null,
    }, 200);
  }),
);

adminLicenses.openapi(
  createRoute({
    method: 'get',
    path: '/v1/admin/licenses',
    summary: 'List licenses',
    request: { query: z.object({ appKey: z.string().optional() }) },
    responses: {
      200: { description: 'Licenses', content: J(z.object({ items: z.array(z.unknown()) })) },
      401: { description: 'Unauthorized', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { appKey } = c.req.valid('query');
    const items = await withStore(st.storeId, (tx) => tx
      .select({
        id: s.license.id, appKey: s.license.appKey, licenseKey: s.license.licenseKey,
        source: s.license.source, status: s.license.status, seats: s.license.seats,
        issuedBy: s.license.issuedBy, issueReason: s.license.issueReason,
        updatesUntil: s.license.updatesUntil, expiresAt: s.license.expiresAt,
      })
      .from(s.license)
      .where(appKey ? eq(s.license.appKey, appKey) : undefined)
      .orderBy(desc(s.license.createdAt)).limit(200));
    return c.json({
      items: items.map((i) => ({
        ...i,
        updatesUntil: i.updatesUntil?.toISOString() ?? null,
        expiresAt: i.expiresAt?.toISOString() ?? null,
      })),
    }, 200);
  }),
);
