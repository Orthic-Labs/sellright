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

/**
 * A2 (perf plan P6): explicit SMTP workflow deadlines. nodemailer's defaults are
 * 2 min to connect, 30 s for the greeting and 10 min of socket inactivity, so one
 * stalled relay could hold an email-outbox pass (and its job slot) for minutes.
 * These bound every phase; SMTP_SEND_DEADLINE_MS bounds the whole send (DNS +
 * connect + TLS + AUTH + DATA) even if a phase timer never fires. A deadline hit
 * is an UNKNOWN outcome (the relay may have accepted the DATA): it is reported as
 * a failed delivery so the outbox's own backoff/dead-letter applies. SMTP cannot be
 * made exactly-once by a timeout; a rare duplicate is preferred to a pinned worker.
 */
export const SMTP_TIMEOUTS = {
  dnsTimeout: 10_000,
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
} as const;
export const SMTP_SEND_DEADLINE_MS = 45_000;

/** Resolve `send` or fail after `ms`; the late promise is observed so it can't surface as an unhandled rejection. */
async function withSendDeadline<T>(send: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`smtp_deadline_exceeded after ${ms}ms`)), ms);
    timer.unref?.();
  });
  send.catch(() => undefined);
  try {
    return await Promise.race([send, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

let cachedGlobal: Transporter | null = null;
function globalTransport(): Transporter | null {
  if (!smtpEnabled()) return null;
  if (cachedGlobal) return cachedGlobal;
  cachedGlobal = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    ...SMTP_TIMEOUTS,
  });
  return cachedGlobal;
}

// WS-A: per-store transporter cache, only ever populated when SMTP_HOST is
// NOT set (env always wins globally — see resolveTransport). Keyed by
// storeId. Only BUILT transporters are cached, for at most STORE_TRANSPORT_TTL_MS,
// and a settings save drops the entry (invalidateStoreTransport) — "not
// configured" is never cached, so configuring e-mail after a failed staff
// invite (which is e-mail-only) works on the next try, in every API process.
const STORE_TRANSPORT_TTL_MS = 60_000;
const cachedByStore = new Map<string, { tx: Transporter; from?: string; at: number }>();

/** Drop a store's cached transporter (after its SMTP settings or credential change). */
export function invalidateStoreTransport(storeId: string): void {
  cachedByStore.delete(storeId);
}

/** WS-A env>db resolution for the SMTP transporter. `env.SMTP_HOST` set →
 *  the existing global transporter, unchanged from before WS-A (an existing
 *  deployment is completely unaffected). Otherwise, when a storeId is given,
 *  build (and cache) a transporter from that store's saved config +
 *  encrypted credential. No storeId and no env → no-op, exactly like before. */
async function resolveTransport(storeId?: string): Promise<{ tx: Transporter; from?: string } | null> {
  // Explicit disable applies to every delivery path, including cached store transports.
  if (env.SMTP_ENABLED === 'false') return null;
  const globalTx = globalTransport();
  if (globalTx) return { tx: globalTx };
  if (!storeId) return null;
  const hit = cachedByStore.get(storeId);
  if (hit && Date.now() - hit.at < STORE_TRANSPORT_TTL_MS) return hit;
  const built = await withStore(storeId, async (tx) => {
    const [row] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, storeId)).limit(1);
    const cfg = smtpConfigFromStoreConfig(row?.config);
    if (!cfg) return null;
    const credential = await resolveField(tx, { storeId, provider: 'smtp', mode: 'default', field: 'authCredential' }, undefined);
    return {
      tx: nodemailer.createTransport({
        host: cfg.host, port: cfg.port, secure: cfg.secure,
        auth: cfg.user ? { user: cfg.user, pass: credential.value } : undefined,
        ...SMTP_TIMEOUTS,
      }),
      from: cfg.from,
    };
  });
  if (built) cachedByStore.set(storeId, { ...built, at: Date.now() });
  else cachedByStore.delete(storeId);
  return built;
}

/** Send an email. No-op (with a log line) when SMTP is not configured (env,
 *  or — when `storeId` is given — that store's own saved settings). */
export async function sendEmail(input: SendEmailInput, storeId?: string): Promise<{ delivered: boolean; reason?: string }> {
  const transport = await resolveTransport(storeId);
  // A store's own SMTP account (Settings > Email) sends as its saved sender (the address that account is
  // authorized for) whenever the caller asked for no specific sender or only the install-wide default.
  // Env-managed SMTP (SMTP_HOST) is unchanged: it never carries a per-store sender.
  const requested = input.from ?? env.SMTP_FROM;
  const from = transport?.from && (input.from === undefined || input.from === env.SMTP_FROM) ? transport.from : requested;
  if (isForbiddenSenderDomain(from, forbiddenSenderDomains())) {
    logErr.error('email blocked: forbidden sender domain', undefined, { from, to: input.to, subject: input.subject });
    return { delivered: false, reason: 'forbidden_sender_domain' };
  }
  const tx = transport?.tx;
  if (!tx) {
    log.info('email skipped', { reason: 'smtp_not_configured', to: input.to, subject: input.subject });
    return { delivered: false, reason: 'smtp_not_configured' };
  }
  try {
    // `from` last: a caller passing `from: undefined` (key present) must not
    // blank the resolved sender — the spread order here previously let it win.
    await withSendDeadline(tx.sendMail({ ...input, from }), SMTP_SEND_DEADLINE_MS);
    return { delivered: true };
  } catch (e) {
    logErr.error('email error', e, { to: input.to, subject: input.subject });
    return { delivered: false, reason: String(e instanceof Error ? e.message : e) };
  }
}
