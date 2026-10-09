/**
 * WS-A (one-click install plan §1.6/§1.7): admin Payments settings — owner
 * enters per-provider, per-mode credentials; secrets are encrypted before
 * they ever reach the database (packages/api/src/security/secret-crypto.ts)
 * and env-configured deployments keep working unmodified (env always wins —
 * a field backed by an env var is reported "managed by server configuration"
 * and rejects a write). Every secret write/verify/webhook-provision writes
 * audit_log in the SAME transaction — never the plaintext, only provider/
 * mode/field/outcome.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, and, inArray } from 'drizzle-orm';
import Stripe from 'stripe';
import { withStore, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import { HttpError, J, errBody, guard, requireAdmin, requireManage, requireStore, requireWrite } from './admin-helpers.js';
import { encryptSecret, decryptSecret, last4 as computeLast4, type EncryptedSecret } from '../security/secret-crypto.js';
import { resolveField, isEnvManaged, type FieldScope } from '../security/settings-resolver.js';
import { stripeCreds } from '../payments/stripe.js';
import { configuredGatewayAccount, resolveSezzleField, sezzleSecretModes } from '../payments/gateway-account.js';
import { verifyNmiKey, verifySezzleKeys, verifyStripeKey } from '../payments/settings-verify.js';
import { ensureStripeWebhook, type StripeWebhookClient } from '../payments/stripe-webhook-provision.js';
import { mutateStoreConfig } from './admin-settings.js';

/** `payments.<provider>` may still be a legacy boolean toggle. Spreading
 *  `true` yields `{}` — which silently DISABLED an enabled provider the
 *  first time an operator ran test-connection. Preserve it as `enabled`. */
function asProviderObject(v: unknown): Record<string, unknown> {
  if (v === true) return { enabled: true };
  if (v === false) return { enabled: false };
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
}

export const adminPaymentSettings = new OpenAPIHono();

type Provider = 'stripe' | 'nmi' | 'sezzle';
const PROVIDER_FIELDS: Record<Provider, { modes: readonly [string, string]; fields: readonly string[] }> = {
  stripe: { modes: ['test', 'live'], fields: ['publishableKey', 'secretKey', 'webhookSecret'] },
  // privateKey: the chargeback webhook signing secret (routes/disputes.ts
  // verifies `webhook-signature` against it — gateway-account.ts's
  // dbGatewayAccount() already resolves this field; it was just missing from
  // the admin-settable field list). Optional — absence just means NMI
  // chargeback webhooks aren't wired for this store/mode.
  nmi: { modes: ['test', 'live'], fields: ['securityKey', 'tokenizationKey', 'privateKey'] },
  sezzle: { modes: ['sandbox', 'production'], fields: ['publicKey', 'privateKey'] },
};

function assertProviderMode(provider: string, mode: string): asserts provider is Provider {
  const def = PROVIDER_FIELDS[provider as Provider];
  if (!def) throw new HttpError(400, `unknown payment provider: ${provider}`);
  if (!def.modes.includes(mode)) throw new HttpError(400, `invalid mode '${mode}' for ${provider}`);
}

function scopeFor(storeId: string, provider: FieldScope['provider'], mode: string, field: string): FieldScope {
  return { storeId, provider, mode, field };
}

const FieldStatus = z.object({ envManaged: z.boolean(), configured: z.boolean(), last4: z.string().nullable() });
const ProviderStatus = z.record(z.string(), z.record(z.string(), FieldStatus));

adminPaymentSettings.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/payments/settings', summary: 'Payment provider credential status (never returns secret values)',
    responses: { 200: { description: 'OK', content: J(ProviderStatus) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const [row] = await withStore(st.storeId, (tx) => tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1));
    const config = row?.config ?? {};

    const nmiEnvManaged = (mode: string) => {
      try { configuredGatewayAccount(st.storeId, 'nmi', config); return true; } catch { return false; }
    };
    const sezzleEnvManaged = () => {
      try { configuredGatewayAccount(st.storeId, 'sezzle', config); return true; } catch { return false; }
    };

    const out: Record<string, Record<string, { envManaged: boolean; configured: boolean; last4: string | null }>> = {};
    for (const [provider, def] of Object.entries(PROVIDER_FIELDS) as Array<[Provider, typeof PROVIDER_FIELDS[Provider]]>) {
      out[provider] = {};
      for (const mode of def.modes) {
        for (const field of def.fields) {
          const envManaged = provider === 'stripe'
            ? isEnvManaged(envValueForStripe(mode as 'test' | 'live', field))
            : provider === 'nmi' ? nmiEnvManaged(mode) : sezzleEnvManaged();
          let configured = envManaged;
          let last4Val: string | null = null;
          if (!envManaged) {
            const rows = await withStore(st.storeId, (tx) => tx.select({ last4: s.storeSecret.last4 })
              .from(s.storeSecret)
              .where(and(eq(s.storeSecret.storeId, st.storeId), eq(s.storeSecret.provider, provider), inArray(s.storeSecret.mode, provider === 'sezzle' ? sezzleSecretModes(mode) : [mode]), eq(s.storeSecret.field, field)))
              .limit(1));
            configured = rows.length > 0;
            last4Val = rows[0]?.last4 ?? null;
          }
          out[provider]![`${mode}:${field}`] = { envManaged, configured, last4: last4Val };
        }
      }
    }
    return c.json(out, 200);
  }),
);

function envValueForStripe(mode: 'test' | 'live', field: string): string | undefined {
  return (stripeCreds(mode) as Record<string, string | undefined>)[field];
}

const UpdateBody = z.object({ fields: z.record(z.string(), z.string().min(1)) });

adminPaymentSettings.openapi(
  createRoute({
    method: 'put', path: '/v1/admin/payments/settings/{provider}/{mode}', summary: 'Set payment provider credential fields',
    request: { params: z.object({ provider: z.string(), mode: z.string() }), body: { content: J(UpdateBody) } },
    responses: {
      200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) },
      400: { description: 'Bad request', ...errBody },
      401: { description: 'Unauthorized', ...errBody },
      403: { description: 'Forbidden', ...errBody },
      409: { description: 'Field is managed by server configuration', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st); requireManage(st);
    const { provider, mode } = c.req.param();
    assertProviderMode(provider, mode);
    const def = PROVIDER_FIELDS[provider];
    const body = c.req.valid('json');

    for (const field of Object.keys(body.fields)) {
      if (!def.fields.includes(field)) throw new HttpError(400, `unknown field '${field}' for ${provider}`);
    }

    await withStore(st.storeId, async (tx) => {
      const [row] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1);
      const config = row?.config ?? {};
      for (const [field, plaintext] of Object.entries(body.fields)) {
        const envManaged = provider === 'stripe'
          ? isEnvManaged(envValueForStripe(mode as 'test' | 'live', field))
          : (() => { try { configuredGatewayAccount(st.storeId, provider, config); return true; } catch { return false; } })();
        if (envManaged) throw new HttpError(409, `${provider}.${mode}.${field} is managed by server configuration`);

        const scope = scopeFor(st.storeId, provider, mode, field);
        const sealed = encryptSecret(plaintext, { purpose: purposeKey(scope) });
        await tx.insert(s.storeSecret).values({
          storeId: st.storeId, provider, mode, field,
          keyVersion: sealed.v, iv: sealed.iv, ciphertext: sealed.ct, authTag: sealed.tag,
          last4: computeLast4(plaintext), updatedBy: admin.email,
        }).onConflictDoUpdate({
          target: [s.storeSecret.storeId, s.storeSecret.provider, s.storeSecret.mode, s.storeSecret.field],
          set: { keyVersion: sealed.v, iv: sealed.iv, ciphertext: sealed.ct, authTag: sealed.tag, last4: computeLast4(plaintext), updatedBy: admin.email, updatedAt: new Date() },
        });
        await tx.insert(s.auditLog).values({
          storeId: st.storeId, actor: admin.email, entity: 'store_secret', entityId: `${provider}:${mode}:${field}`,
          action: 'secret_update', data: { provider, mode, field, last4: computeLast4(plaintext) },
        });
      }
    });
    return c.json({ ok: true }, 200);
  }),
);

function purposeKey(scope: FieldScope): string {
  return `store:${scope.storeId}:${scope.provider}:${scope.mode}:${scope.field}`;
}

async function readSecret(tx: Tx, scope: FieldScope): Promise<string | undefined> {
  const rows = await tx.select().from(s.storeSecret).where(and(
    eq(s.storeSecret.storeId, scope.storeId), eq(s.storeSecret.provider, scope.provider),
    eq(s.storeSecret.mode, scope.mode), eq(s.storeSecret.field, scope.field),
  )).limit(1);
  const row = rows[0];
  if (!row) return undefined;
  const sealed: EncryptedSecret = { v: row.keyVersion, iv: row.iv, ct: row.ciphertext, tag: row.authTag };
  return decryptSecret(sealed, purposeKey(scope));
}

const VerifyResponse = z.object({ ok: z.boolean(), error: z.string().optional() });

adminPaymentSettings.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/payments/settings/{provider}/{mode}/verify', summary: 'Test connection for a provider credential set',
    request: { params: z.object({ provider: z.string(), mode: z.string() }) },
    responses: { 200: { description: 'OK', content: J(VerifyResponse) }, 401: { description: 'Unauthorized', ...errBody }, 403: { description: 'Forbidden', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st); requireManage(st);
    const { provider, mode } = c.req.param();
    assertProviderMode(provider, mode);

    const result = await withStore(st.storeId, async (tx): Promise<{ ok: boolean; error?: string }> => {
      if (provider === 'stripe') {
        const secretKey = await resolveField(tx, scopeFor(st.storeId, 'stripe', mode, 'secretKey'), envValueForStripe(mode as 'test' | 'live', 'secretKey'));
        if (!secretKey.value) return { ok: false, error: 'No secret key configured' };
        const client = new Stripe(secretKey.value);
        return verifyStripeKey(secretKey.value, mode as 'test' | 'live', client);
      }
      if (provider === 'nmi') {
        const securityKey = await resolveField(tx, scopeFor(st.storeId, 'nmi', mode, 'securityKey'), undefined);
        if (!securityKey.value) return { ok: false, error: 'No security key configured' };
        return verifyNmiKey(securityKey.value, mode === 'test' ? 'sandbox' : 'production');
      }
      // sezzle
      const pub = await resolveSezzleField(tx, st.storeId, mode, 'publicKey');
      const priv = await resolveSezzleField(tx, st.storeId, mode, 'privateKey');
      if (!pub.value || !priv.value) return { ok: false, error: 'Public/private key not fully configured' };
      return verifySezzleKeys(pub.value, priv.value, mode as 'sandbox' | 'production');
    });

    await withStore(st.storeId, (tx) => tx.insert(s.auditLog).values({
      storeId: st.storeId, actor: admin.email, entity: 'store_secret', entityId: `${provider}:${mode}`,
      action: 'secret_verify', data: { provider, mode, ok: result.ok },
    }));
    if (result.ok) {
      // Publish readiness (plan §1.5) reads config.payments[provider][mode].
      // verifiedAt — "a provider verified" means a PASSED test-connection
      // call, not merely "a secret is saved". A later credential edit doesn't
      // clear this; a subsequent FAILED verify does (below), so readiness
      // can't go stale-green after rotating to a bad key.
      await mutateStoreConfig(st.storeId, (config) => {
        const payments = { ...(config.payments as Record<string, unknown> | undefined) };
        const forProvider = asProviderObject(payments[provider]);
        forProvider[mode] = { ...(forProvider[mode] as Record<string, unknown> | undefined), verifiedAt: new Date().toISOString() };
        payments[provider] = forProvider;
        return { ...config, payments };
      });
    } else {
      await mutateStoreConfig(st.storeId, (config) => {
        const payments = { ...(config.payments as Record<string, unknown> | undefined) };
        const forProvider = asProviderObject(payments[provider]);
        const { [mode]: _dropped, ...restModes } = forProvider;
        payments[provider] = restModes;
        return { ...config, payments };
      });
    }
    return c.json(result, 200);
  }),
);

const WebhookResponse = z.object({ endpointId: z.string(), created: z.boolean(), recreated: z.boolean() });

adminPaymentSettings.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/payments/settings/stripe/{mode}/webhook', summary: 'Idempotently (re)create the Stripe webhook endpoint for this store+mode',
    request: { params: z.object({ mode: z.enum(['test', 'live']) }) },
    responses: { 200: { description: 'OK', content: J(WebhookResponse) }, 400: { description: 'Bad request', ...errBody }, 401: { description: 'Unauthorized', ...errBody }, 403: { description: 'Forbidden', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st); requireManage(st);
    const mode = c.req.param('mode') as 'test' | 'live';

    const result = await withStore(st.storeId, async (tx) => {
      const secretKey = await resolveField(tx, scopeFor(st.storeId, 'stripe', mode, 'secretKey'), envValueForStripe(mode, 'secretKey'));
      if (!secretKey.value) throw new HttpError(400, 'No Stripe secret key configured for this mode yet');
      const stripe = new Stripe(secretKey.value);
      const client: StripeWebhookClient = {
        webhookEndpoints: {
          list: (p) => stripe.webhookEndpoints.list(p) as unknown as Promise<{ data: never[] }>,
          create: (p) => stripe.webhookEndpoints.create(p as never) as unknown as Promise<{ id: string; url: string; secret?: string }>,
          del: (id) => stripe.webhookEndpoints.del(id),
        },
      };
      const url = `${env.STOREFRONT_URL}/v1/webhooks/stripe`;
      const existingRow = await tx.select({ metadata: s.storeSecret.metadata }).from(s.storeSecret).where(and(
        eq(s.storeSecret.storeId, st.storeId), eq(s.storeSecret.provider, 'stripe'), eq(s.storeSecret.mode, mode), eq(s.storeSecret.field, 'webhookSecret'),
      )).limit(1);
      const storedEndpointId = (existingRow[0]?.metadata as { webhookEndpointId?: string } | null)?.webhookEndpointId;

      const outcome = await ensureStripeWebhook(client, {
        storeId: st.storeId, mode, url,
        hasStoredSecret: (id) => id === storedEndpointId && existingRow.length > 0,
      });

      if (outcome.newSecret) {
        const scope = scopeFor(st.storeId, 'stripe', mode, 'webhookSecret');
        const sealed = encryptSecret(outcome.newSecret, { purpose: purposeKey(scope) });
        await tx.insert(s.storeSecret).values({
          storeId: st.storeId, provider: 'stripe', mode, field: 'webhookSecret',
          keyVersion: sealed.v, iv: sealed.iv, ciphertext: sealed.ct, authTag: sealed.tag,
          last4: computeLast4(outcome.newSecret), updatedBy: admin.email,
          metadata: { webhookEndpointId: outcome.endpointId, url },
        }).onConflictDoUpdate({
          target: [s.storeSecret.storeId, s.storeSecret.provider, s.storeSecret.mode, s.storeSecret.field],
          set: { keyVersion: sealed.v, iv: sealed.iv, ciphertext: sealed.ct, authTag: sealed.tag, last4: computeLast4(outcome.newSecret), updatedBy: admin.email, updatedAt: new Date(), metadata: { webhookEndpointId: outcome.endpointId, url } },
        });
      }
      await tx.insert(s.auditLog).values({
        storeId: st.storeId, actor: admin.email, entity: 'store_secret', entityId: `stripe:${mode}:webhookSecret`,
        action: 'webhook_provision', data: { mode, endpointId: outcome.endpointId, created: outcome.created, recreated: outcome.recreated },
      });
      return { endpointId: outcome.endpointId, created: outcome.created, recreated: outcome.recreated };
    });
    return c.json(result, 200);
  }),
);

// Exposed for the email-settings route (shared secret read/write helpers).
export { readSecret, purposeKey, scopeFor };
