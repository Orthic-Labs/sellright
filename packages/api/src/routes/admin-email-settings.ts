/**
 * WS-A (one-click install plan §1.6/§1.7): admin Email settings. SMTP_HOST
 * (env) always wins — when set, the whole SMTP config is "managed by server
 * configuration" and this route only supports Test send (against the LIVE
 * env-based mailer), never editing. Only when SMTP_HOST is unset does the
 * per-store DB config (non-secret host/port/secure/preset in store.config,
 * credential encrypted in store_secret) become editable.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import { HttpError, J, errBody, guard, requireAdmin, requireManage, requireOwner, requireStore, requireWrite } from './admin-helpers.js';
import { mutateStoreConfig } from './admin-settings.js';
import { lockMembershipAsCaller } from './admin-settings-advanced.js';
import { encryptSecret, last4 as computeLast4 } from '../security/secret-crypto.js';
import { isEnvManaged } from '../security/settings-resolver.js';
import { readSecret, purposeKey, scopeFor } from './admin-payment-settings.js';
import { SMTP_PRESETS, SMTP_POLICY_MESSAGES, SmtpConfig, SmtpDestinationError, checkSmtpDestinationShape, resolveSmtpDestination, smtpConfigFromStoreConfig, resolveSmtpPreset, sendTestEmail, type SmtpPresetId } from '../email/smtp-settings.js';
import { invalidateStoreTransport, sendEmail } from '../email/mailer.js';

export const adminEmailSettings = new OpenAPIHono();

const Status = z.object({ envManaged: z.boolean(), config: SmtpConfig.partial().nullable(), credentialConfigured: z.boolean() });

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
    const cfg = smtpConfigFromStoreConfig(row?.config);
    const credentialRows = await withStore(st.storeId, (tx) => tx.select({ last4: s.storeSecret.last4 }).from(s.storeSecret)
      .where(and(
        eq(s.storeSecret.storeId, st.storeId), eq(s.storeSecret.provider, 'smtp'),
        eq(s.storeSecret.mode, 'default'), eq(s.storeSecret.field, 'authCredential'),
      )).limit(1));
    return c.json({ envManaged: false, config: cfg, credentialConfigured: credentialRows.some((r) => r.last4) }, 200);
  }),
);

// G12e: every field is bounded (a hostname is <=253 octets, an address <=254).
const UpdateBody = z.object({
  preset: z.enum(['custom', 'gmail', 'ses', 'postmark', 'resend']),
  host: z.string().max(253).optional(), port: z.number().int().positive().max(65535).optional(), secure: z.boolean().optional(),
  user: z.string().max(320).optional(), from: z.string().max(254).email().optional(), credential: z.string().max(4096).optional(),
});

adminEmailSettings.openapi(
  createRoute({
    method: 'put', path: '/v1/admin/email/settings', summary: 'Update email (SMTP) settings',
    request: { body: { content: J(UpdateBody) } },
    responses: {
      200: { description: 'OK', content: J(z.object({ ok: z.boolean() })) },
      401: { description: 'Unauthorized', ...errBody }, 403: { description: 'Forbidden', ...errBody },
      400: { description: 'SMTP destination not allowed', ...errBody },
      409: { description: 'Managed by server configuration', ...errBody },
    },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    // Owner only (P0 review): the store's SMTP account carries staff-invite links (the token is e-mail-only), so a
    // manager must not be able to point it at a server they control and harvest invites issued by an owner.
    const st = requireStore(admin, c); requireWrite(st); requireManage(st); requireOwner(st);
    if (isEnvManaged(env.SMTP_HOST)) throw new HttpError(409, 'Email is managed by server configuration (SMTP_HOST is set)');
    const b = c.req.valid('json');
    const resolved = resolveSmtpPreset(b.preset as SmtpPresetId, { host: b.host, port: b.port, secure: b.secure });
    // G10: a store's SMTP destination must be a public mail host on a mail port. Checked (shape + DNS) before saving;
    // the test send and the mailer re-check at connect time, since DNS can change after the save.
    const shape = checkSmtpDestinationShape(resolved.host, resolved.port);
    if (shape) throw new HttpError(400, SMTP_POLICY_MESSAGES[shape]);
    try { await resolveSmtpDestination(resolved.host, resolved.port); } catch (e) {
      throw new HttpError(400, e instanceof SmtpDestinationError ? e.message : SMTP_POLICY_MESSAGES.host_unresolvable);
    }

    // ONE transaction: re-authorize the caller as an owner under the store's membership lock (a caller demoted or
    // removed while this request waited is refused), then write the SMTP config and its credential atomically.
    await mutateStoreConfig(st.storeId, (config) => ({
      ...config,
      email: { ...(config.email as object ?? {}), smtp: { preset: b.preset, ...resolved, user: b.user, from: b.from } },
    }), {
      actor: admin.email, action: 'settings_update',
      detail: () => ({ section: 'email_smtp', preset: b.preset, host: resolved.host, port: resolved.port }),
    }, {
      before: async (tx) => { requireOwner(await lockMembershipAsCaller(tx, st, admin.id)); },
      after: async (tx) => {
        if (!b.credential) return;
        const scope = scopeFor(st.storeId, 'smtp', 'default', 'authCredential');
        const sealed = encryptSecret(b.credential, { purpose: purposeKey(scope) });
        await tx.insert(s.storeSecret).values({
          storeId: st.storeId, provider: 'smtp', mode: 'default', field: 'authCredential',
          keyVersion: sealed.v, iv: sealed.iv, ciphertext: sealed.ct, authTag: sealed.tag,
          last4: computeLast4(b.credential), updatedBy: admin.email,
        }).onConflictDoUpdate({
          target: [s.storeSecret.storeId, s.storeSecret.provider, s.storeSecret.mode, s.storeSecret.field],
          set: { keyVersion: sealed.v, iv: sealed.iv, ciphertext: sealed.ct, authTag: sealed.tag, last4: computeLast4(b.credential), updatedBy: admin.email, updatedAt: new Date() },
        });
        await tx.insert(s.auditLog).values({
          storeId: st.storeId, actor: admin.email, entity: 'store_secret', entityId: 'smtp:default:authCredential',
          action: 'secret_update', data: { provider: 'smtp', mode: 'default', field: 'authCredential', last4: computeLast4(b.credential) },
        });
      },
    });
    invalidateStoreTransport(st.storeId); // the next send (e.g. a retried staff invite) uses the new settings
    return c.json({ ok: true }, 200);
  }),
);

const TestSendBody = z.object({ to: z.string().max(254).email() });

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
      if (result.delivered) await markEmailVerified(st.storeId);
      // G10: only the mailer's fixed reason codes are reflected, never transport error text.
      const reason = result.reason === undefined || result.reason === 'smtp_not_configured' || result.reason === 'forbidden_sender_domain'
        ? result.reason : 'Could not deliver through the server-configured SMTP account';
      return c.json({ delivered: result.delivered, error: reason }, 200);
    }

    const [row] = await withStore(st.storeId, (tx) => tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, st.storeId)).limit(1));
    const cfg = smtpConfigFromStoreConfig(row?.config);
    if (!cfg) return c.json({ delivered: false, error: 'No SMTP settings saved yet' }, 200);
    const credential = await withStore(st.storeId, (tx) => readSecret(tx, scopeFor(st.storeId, 'smtp', 'default', 'authCredential')));

    const result = await sendTestEmail({ preset: cfg.preset, host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user, pass: credential }, to);
    // Publish readiness (plan §1.5) reads config.email.verifiedAt — "verified"
    // means a passed test-send, mirroring the payments provider gate.
    if (result.delivered) await markEmailVerified(st.storeId);
    return c.json(result, 200);
  }),
);

async function markEmailVerified(storeId: string): Promise<void> {
  await mutateStoreConfig(storeId, (config) => ({
    ...config,
    email: { ...(config.email as Record<string, unknown> | undefined), verifiedAt: new Date().toISOString() },
  }));
}

export { SMTP_PRESETS };
