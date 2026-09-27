/**
 * WS-A (one-click install plan §1.6/§1.7): admin Email settings. SMTP_HOST
 * (env) always wins — when set, the whole SMTP config is "managed by server
 * configuration" and this route only supports Test send (against the LIVE
 * env-based mailer), never editing. Only when SMTP_HOST is unset does the
 * per-store DB config (non-secret host/port/secure/preset in store.config,
 * credential encrypted in store_secret) become editable.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import { HttpError, J, errBody, guard, requireAdmin, requireManage, requireStore, requireWrite } from './admin-helpers.js';
import { mutateStoreConfig } from './admin-settings.js';
import { encryptSecret, last4 as computeLast4 } from '../security/secret-crypto.js';
import { isEnvManaged } from '../security/settings-resolver.js';
import { readSecret, purposeKey, scopeFor } from './admin-payment-settings.js';
import { SMTP_PRESETS, resolveSmtpPreset, sendTestEmail, type SmtpPresetId } from '../email/smtp-settings.js';
import { sendEmail } from '../email/mailer.js';

export const adminEmailSettings = new OpenAPIHono();

const SmtpConfig = z.object({
  preset: z.enum(['custom', 'gmail', 'ses', 'postmark', 'resend']),
  host: z.string(), port: z.number().int().positive(), secure: z.boolean(),
  user: z.string().optional(), from: z.string().email().optional(),
});
const Status = z.object({ envManaged: z.boolean(), config: SmtpConfig.partial().nullable(), credentialConfigured: z.boolean() });

function smtpConfigFromStore(config: unknown): z.infer<typeof SmtpConfig> | null {
  const smtp = (config as { email?: { smtp?: unknown } } | null)?.email?.smtp;
  const parsed = SmtpConfig.safeParse(smtp);
  return parsed.success ? parsed.data : null;
}

adminEmailSettings.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/email/settings', summary: 'Email (SMTP) settings status',
    responses: { 200: { description: 'OK', content: J(Status) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const envManaged = isEnvManaged(env.SMTP_HOST);
    if (envManaged) return c.json({ envManaged: true, config: null, credentialConfigured: true }, 200);

    const [row] = await withStore(st.storeId, (tx) => tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1));
    const cfg = smtpConfigFromStore(row?.config);
    const credentialRows = await withStore(st.storeId, (tx) => tx.select({ last4: s.storeSecret.last4 }).from(s.storeSecret)
      .where(eq(s.storeSecret.storeId, st.storeId)).limit(1));
    return c.json({ envManaged: false, config: cfg, credentialConfigured: credentialRows.some((r) => r.last4) }, 200);
  }),
);

const UpdateBody = z.object({
  preset: z.enum(['custom', 'gmail', 'ses', 'postmark', 'resend']),
  host: z.string().optional(), port: z.number().int().positive().optional(), secure: z.boolean().optional(),
  user: z.string().optional(), from: z.string().email().optional(), credential: z.string().optional(),
});

adminEmailSettings.openapi(
  createRoute({
    method: 'put', path: '/v1/admin/email/settings', summary: 'Update email (SMTP) settings',
    request: { body: { content: J(UpdateBody) } },
    responses: {
      200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) },
      401: { description: 'Unauthorized', ...errBody }, 403: { description: 'Forbidden', ...errBody },
      409: { description: 'Managed by server configuration', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st); requireManage(st);
    if (isEnvManaged(env.SMTP_HOST)) throw new HttpError(409, 'Email is managed by server configuration (SMTP_HOST is set)');
    const b = c.req.valid('json');
    const resolved = resolveSmtpPreset(b.preset as SmtpPresetId, { host: b.host, port: b.port, secure: b.secure });

    await mutateStoreConfig(st.storeId, (config) => ({
      ...config,
      email: { ...(config.email as object ?? {}), smtp: { preset: b.preset, ...resolved, user: b.user, from: b.from } },
    }), {
      actor: admin.email, action: 'settings_update',
      detail: () => ({ section: 'email_smtp', preset: b.preset, host: resolved.host, port: resolved.port }),
    });

    if (b.credential) {
      await withStore(st.storeId, async (tx) => {
        const scope = scopeFor(st.storeId, 'smtp', 'default', 'authCredential');
        const sealed = encryptSecret(b.credential!, { purpose: purposeKey(scope) });
        await tx.insert(s.storeSecret).values({
          storeId: st.storeId, provider: 'smtp', mode: 'default', field: 'authCredential',
          keyVersion: sealed.v, iv: sealed.iv, ciphertext: sealed.ct, authTag: sealed.tag,
          last4: computeLast4(b.credential!), updatedBy: admin.email,
        }).onConflictDoUpdate({
          target: [s.storeSecret.storeId, s.storeSecret.provider, s.storeSecret.mode, s.storeSecret.field],
          set: { keyVersion: sealed.v, iv: sealed.iv, ciphertext: sealed.ct, authTag: sealed.tag, last4: computeLast4(b.credential!), updatedBy: admin.email, updatedAt: new Date() },
        });
        await tx.insert(s.auditLog).values({
          storeId: st.storeId, actor: admin.email, entity: 'store_secret', entityId: 'smtp:default:authCredential',
          action: 'secret_update', data: { provider: 'smtp', mode: 'default', field: 'authCredential', last4: computeLast4(b.credential!) },
        });
      });
    }
    return c.json({ ok: true }, 200);
  }),
);

const TestSendBody = z.object({ to: z.string().email() });

adminEmailSettings.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/email/settings/test-send', summary: 'Send a test email using the current (saved or candidate) settings',
    request: { body: { content: J(TestSendBody) } },
    responses: { 200: { description: 'OK', content: J(z.object({ delivered: z.boolean(), error: z.string().optional() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { to } = c.req.valid('json');

    if (isEnvManaged(env.SMTP_HOST)) {
      // Env-managed: exercise the real, already-configured mailer.
      const result = await sendEmail({ to, subject: 'SellRight test email', text: 'Test email from SellRight.', html: '<p>Test email from SellRight.</p>' });
      return c.json({ delivered: result.delivered, error: result.reason }, 200);
    }

    const [row] = await withStore(st.storeId, (tx) => tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1));
    const cfg = smtpConfigFromStore(row?.config);
    if (!cfg) return c.json({ delivered: false, error: 'No SMTP settings saved yet' }, 200);
    const credential = await withStore(st.storeId, (tx) => readSecret(tx, scopeFor(st.storeId, 'smtp', 'default', 'authCredential')));

    const result = await sendTestEmail({ preset: cfg.preset, host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user, pass: credential }, to);
    return c.json(result, 200);
  }),
);

export { SMTP_PRESETS };
