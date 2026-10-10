/**
 * Email service (WP2). SMTP via nodemailer; in dev/test without SMTP configured
 * it logs and returns (the storefront still works, ops just doesn't get notified).
 * The interface hides the provider so Resend/Postmark/etc. can drop in later.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../env.js';
import { log, err as logErr } from '../lib/logger.js';
import { isForbiddenSenderDomain, parseSenderDomainList } from './sender-policy.js';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { resolveField } from '../security/settings-resolver.js';
import { smtpConfigFromStoreConfig } from './smtp-settings.js';

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  from?: string;
}

// WP2: SMTP_ENABLED lets ops force the no-op path even when SMTP_HOST is set
// (e.g. for a load test that should never actually send mail). Default: ON when
// SMTP_HOST is set, OFF otherwise — matches the legacy "no SMTP = log only" UX.
const smtpEnabled = (): boolean => {
  if (env.SMTP_ENABLED === 'true') return true;
  if (env.SMTP_ENABLED === 'false') return false;
  return Boolean(env.SMTP_HOST);
};

// Same policy env.ts checked at boot (email/sender-policy.ts) — empty when
// FORBIDDEN_SENDER_DOMAINS is unset, so this is a no-op by default.
let forbiddenSenderDomainsCache: ReturnType<typeof parseSenderDomainList> | undefined;
const forbiddenSenderDomains = (): ReturnType<typeof parseSenderDomainList> =>
  (forbiddenSenderDomainsCache ??= parseSenderDomainList(env.FORBIDDEN_SENDER_DOMAINS));

let cachedGlobal: Transporter | null = null;
function globalTransport(): Transporter | null {
  if (!smtpEnabled()) return null;
  if (cachedGlobal) return cachedGlobal;
  cachedGlobal = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return cachedGlobal;
}

// WS-A: per-store transporter cache, only ever populated when SMTP_HOST is
// NOT set (env always wins globally — see resolveTransport). Keyed by
// storeId; cleared implicitly on process restart (a settings save takes
// effect on the next delivery cycle, which is acceptable for transactional
// mail — not a hot per-request path).
const cachedByStore = new Map<string, Transporter | null>();

/** WS-A env>db resolution for the SMTP transporter. `env.SMTP_HOST` set →
 *  the existing global transporter, unchanged from before WS-A (an existing
 *  deployment is completely unaffected). Otherwise, when a storeId is given,
 *  build (and cache) a transporter from that store's saved config +
 *  encrypted credential. No storeId and no env → no-op, exactly like before. */
async function resolveTransport(storeId?: string): Promise<Transporter | null> {
  const globalTx = globalTransport();
  if (globalTx) return globalTx;
  if (!storeId) return null;
  if (cachedByStore.has(storeId)) return cachedByStore.get(storeId)!;
  const built = await withStore(storeId, async (tx) => {
    const [row] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, storeId)).limit(1);
    const cfg = smtpConfigFromStoreConfig(row?.config);
    if (!cfg) return null;
    const credential = await resolveField(tx, { storeId, provider: 'smtp', mode: 'default', field: 'authCredential' }, undefined);
    return nodemailer.createTransport({
      host: cfg.host, port: cfg.port, secure: cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: credential.value } : undefined,
    });
  });
  cachedByStore.set(storeId, built);
  return built;
}

/** Send an email. No-op (with a log line) when SMTP is not configured (env,
 *  or — when `storeId` is given — that store's own saved settings). */
export async function sendEmail(input: SendEmailInput, storeId?: string): Promise<{ delivered: boolean; reason?: string }> {
  const from = input.from ?? env.SMTP_FROM;
  if (isForbiddenSenderDomain(from, forbiddenSenderDomains())) {
    logErr.error('email blocked: forbidden sender domain', undefined, { from, to: input.to, subject: input.subject });
    return { delivered: false, reason: 'forbidden_sender_domain' };
  }
  const tx = await resolveTransport(storeId);
  if (!tx) {
    log.info('email skipped', { reason: 'smtp_not_configured', to: input.to, subject: input.subject });
    return { delivered: false, reason: 'smtp_not_configured' };
  }
  try {
    // `from` last: a caller passing `from: undefined` (key present) must not
    // blank the resolved sender — the spread order here previously let it win.
    await tx.sendMail({ ...input, from });
    return { delivered: true };
  } catch (e) {
    logErr.error('email error', e, { to: input.to, subject: input.subject });
    return { delivered: false, reason: String(e instanceof Error ? e.message : e) };
  }
}
