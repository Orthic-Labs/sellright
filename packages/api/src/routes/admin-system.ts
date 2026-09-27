/**
 * One-click install: setup checklist + Publish readiness gate + recovery-kit
 * download (plan §1.5/§1.10). System operations here (recovery-kit download)
 * require installation-admin authority (requireInstallationAdmin) — separate
 * from, and never satisfied by, per-store 'owner'.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import { getRecoveryKitDownloadedAt, markRecoveryKitDownloaded } from '../auth/admin-staff.js';
import { isEnvManaged } from '../security/settings-resolver.js';
// SELLRIGHT_MASTER_KEY/RECOVERY_KIT_ID are read directly from process.env,
// not the parsed `env` singleton — matching security/secret-crypto.ts's own
// convention (see its doc comment): these are infra-only, and reading them
// live (rather than at module-import time) is what lets DB tests set
// process.env.SELLRIGHT_MASTER_KEY in beforeEach() and have it take effect.
import { configuredGatewayAccount } from '../payments/gateway-account.js';
import { stripeCreds } from '../payments/stripe.js';
import { HttpError, J, errBody, guard, requireAdmin, requireInstallationAdmin, requireStore } from './admin-helpers.js';
import { mutateStoreConfig } from './admin-settings.js';

export const adminSystem = new OpenAPIHono();

interface ReadinessItem { ok: boolean; detail: string }
interface Readiness {
  products: ReadinessItem;
  domain: ReadinessItem;
  payments: ReadinessItem;
  email: ReadinessItem;
  shippingAndTax: ReadinessItem;
  recoveryKit: ReadinessItem;
  offSiteBackup: ReadinessItem;
}

const LIVE_MODE: Record<'stripe' | 'nmi' | 'sezzle', string> = { stripe: 'live', nmi: 'live', sezzle: 'production' };

function paymentsLiveVerified(storeId: string, config: Record<string, unknown>): boolean {
  const payments = (config.payments as Record<string, Record<string, { verifiedAt?: string }>> | undefined) ?? {};
  for (const [provider, mode] of Object.entries(LIVE_MODE) as Array<[keyof typeof LIVE_MODE, string]>) {
    if (payments[provider]?.[mode]?.verifiedAt) return true;
    if (provider === 'stripe') {
      if (isEnvManaged(stripeCreds('live').secretKey)) return true;
      continue;
    }
    // NMI/Sezzle env-managed: a GATEWAY_ACCOUNTS_JSON profile exists for this
    // store+method (configuredGatewayAccount throws otherwise) — an operator
    // who wired that up already trusts it, same as admin-payment-settings.ts's
    // own envManaged check.
    try { configuredGatewayAccount(storeId, provider, config); return true; } catch { /* not env-managed */ }
  }
  return false;
}

/**
 * Shared by GET /checklist (informational) and PATCH /settings/publish (the
 * actual gate — see admin-settings.ts) so the two can never drift apart.
 */
export async function computeReadiness(storeId: string, installationAdminId: string | null): Promise<Readiness> {
  const [{ hasProduct, config, hasShippingMethod, taxRate }] = await withStore(storeId, async (tx) => {
    const [row] = await tx.select({ config: s.store.config, taxRate: s.store.taxRate }).from(s.store).where(eq(s.store.id, storeId)).limit(1);
    const [prod] = await tx.select({ id: s.product.id }).from(s.product).where(and(eq(s.product.storeId, storeId), eq(s.product.status, 'active'))).limit(1);
    const [ship] = await tx.select({ id: s.shippingMethod.id }).from(s.shippingMethod).where(eq(s.shippingMethod.storeId, storeId)).limit(1);
    return [{ hasProduct: !!prod, config: (row?.config as Record<string, unknown>) ?? {}, hasShippingMethod: !!ship, taxRate: row?.taxRate ?? 0 }];
  });

  const emailOk = isEnvManaged(env.SMTP_HOST) || !!(config.email as { verifiedAt?: string } | undefined)?.verifiedAt;
  const hostnames = (config as { hostnames?: unknown }).hostnames;
  const domainConfigured = Array.isArray(hostnames) && hostnames.length > 0;
  const checklist = (config.checklist as { offsiteBackupConfirmed?: boolean } | undefined) ?? {};

  const recoveryKitOk = installationAdminId ? !!(await getRecoveryKitDownloadedAt(installationAdminId)) : false;

  return {
    products: { ok: hasProduct, detail: hasProduct ? 'At least one active product' : 'No active products yet' },
    // No domain/TLS automation has shipped yet (plan §1.8/WS-D — pending the
    // Caddy IP-certificate spike), so this is deliberately never a publish
    // blocker: a configured hostname is nice-to-know, everything else is
    // "manual" — the owner is trusted to have DNS/TLS sorted outside SellRight.
    domain: domainConfigured
      ? { ok: true, detail: 'Hostname configured' }
      : { ok: true, detail: 'Manual — no domain automation yet; configure DNS/TLS yourself' },
    payments: paymentsLiveVerified(storeId, config)
      ? { ok: true, detail: 'A live payment method is verified' }
      : { ok: false, detail: 'No live payment method has passed Test connection yet' },
    email: { ok: emailOk, detail: emailOk ? 'Email delivery verified' : 'Send a test email to verify' },
    shippingAndTax: hasShippingMethod || taxRate > 0
      ? { ok: true, detail: 'Shipping or tax is configured' }
      : { ok: false, detail: 'No shipping method or tax rate configured yet' },
    recoveryKit: { ok: recoveryKitOk, detail: recoveryKitOk ? 'Downloaded' : 'Not downloaded yet' },
    // Off-site backup is entirely host-side (deploy/.env's SELLRIGHT_S3_*/
    // rclone remote, consumed by `sellright backup --offsite` — see
    // deploy/sellright.sh); the API has no way to observe it. Self-reported,
    // toggled via PATCH .../checklist/offsite-backup-confirmed below.
    offSiteBackup: checklist.offsiteBackupConfirmed
      ? { ok: true, detail: 'Confirmed by owner' }
      : { ok: false, detail: 'Not yet confirmed — see: sellright backup --offsite' },
  };
}

adminSystem.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/system/checklist', summary: 'Setup checklist status (plan §1.5)',
    responses: { 200: { description: 'OK', content: J(z.record(z.string(), z.object({ ok: z.boolean(), detail: z.string() }))) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const readiness = await computeReadiness(st.storeId, admin.isInstallationAdmin ? admin.id : null);
    return c.json(readiness, 200);
  }),
);

adminSystem.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/system/checklist/offsite-backup-confirmed', summary: 'Self-report that off-site backup is configured (host-side, not API-observable)',
    request: { body: { content: J(z.object({ confirmed: z.boolean() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { confirmed } = c.req.valid('json');
    await mutateStoreConfig(st.storeId, (config) => ({
      ...config,
      checklist: { ...(config.checklist as Record<string, unknown> | undefined), offsiteBackupConfirmed: confirmed },
    }), { actor: admin.email, action: 'checklist-offsite-backup-confirmed' });
    return c.json({ ok: true }, 200);
  }),
);

const RecoveryKitResponse = z.object({
  kitId: z.string().nullable(),
  generatedAt: z.string(),
  masterKeyPresent: z.boolean(),
  masterKey: z.string().nullable(),
  note: z.string(),
});

adminSystem.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/system/recovery-kit', summary: 'Download the recovery kit (installation administrators only)',
    responses: {
      200: { description: 'OK', content: J(RecoveryKitResponse) },
      401: { description: 'Unauthorized', ...errBody },
      403: { description: 'Forbidden — installation administrator required', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    requireInstallationAdmin(admin);
    const masterKey = process.env.SELLRIGHT_MASTER_KEY;
    if (!masterKey) throw new HttpError(503, 'SELLRIGHT_MASTER_KEY is not configured on this server');

    await markRecoveryKitDownloaded(admin.id);

    return c.json({
      kitId: process.env.RECOVERY_KIT_ID ?? null,
      generatedAt: new Date().toISOString(),
      masterKeyPresent: true,
      masterKey,
      note: 'Store this offline, away from this server. It is required to restore this install and is never re-derivable. Off-site backups are encrypted with a key derived from it.',
    }, 200);
  }),
);

