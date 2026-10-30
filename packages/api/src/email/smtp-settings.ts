/**
 * WS-A (one-click install plan §1.7): SMTP settings presets + "send a test
 * email" for the admin Email settings page. Separate from mailer.ts's
 * env-only, cached transporter — this builds an ephemeral transporter from
 * CANDIDATE settings (not yet saved) so "Test connection" can verify before
 * the owner commits to them. `createTransport` is injected so unit tests
 * never open a real SMTP connection.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from '@hono/zod-openapi';
import { assertSafeOutboundUrl, isPrivateOrSpecialAddress } from '../security/outbound-url.js';

export type SmtpPresetId = 'custom' | 'gmail' | 'ses' | 'postmark' | 'resend';

// Shared shape for the non-secret half of a store's SMTP config (store.config.
// email.smtp) — used by both the admin route (admin-email-settings.ts) and the
// real mailer (mailer.ts) so the two never drift on what a "valid saved
// config" looks like.
export const SmtpConfig = z.object({
  preset: z.enum(['custom', 'gmail', 'ses', 'postmark', 'resend']),
  host: z.string(), port: z.number().int().positive(), secure: z.boolean(),
  user: z.string().optional(), from: z.string().email().optional(),
});
export type SmtpConfigValue = z.infer<typeof SmtpConfig>;

export function smtpConfigFromStoreConfig(config: unknown): SmtpConfigValue | null {
  const smtp = (config as { email?: { smtp?: unknown } } | null)?.email?.smtp;
  const parsed = SmtpConfig.safeParse(smtp);
  return parsed.success ? parsed.data : null;
}

export interface SmtpPresetDefaults {
  host: string | null; // null = owner must supply (SES varies by region)
  port: number;
  secure: boolean;
  /** Human hint shown in the admin UI, e.g. "Use a 16-character app password, not your login password." */
  hint: string;
}

// Ports/hosts per each provider's published SMTP docs. `secure` follows each
// provider's documented default: STARTTLS on 587 (secure:false, upgraded via
// STARTTLS) except where a provider recommends implicit TLS.
export const SMTP_PRESETS: Record<SmtpPresetId, SmtpPresetDefaults> = {
  custom: { host: null, port: 587, secure: false, hint: 'Enter your provider\'s SMTP host, port and credentials.' },
  gmail: {
    host: 'smtp.gmail.com', port: 587, secure: false,
    hint: 'Gmail / Google Workspace requires a 16-character App Password (Google Account → Security → App passwords) — your normal login password will not work.',
  },
  ses: {
    host: null, port: 587, secure: false,
    hint: 'Amazon SES: host is region-specific (e.g. email-smtp.us-east-1.amazonaws.com). Use SMTP credentials generated in the SES console, not your AWS IAM keys.',
  },
  postmark: {
    host: 'smtp.postmarkapp.com', port: 587, secure: false,
    hint: 'Postmark: username and password are both your Server API Token.',
  },
  resend: {
    host: 'smtp.resend.com', port: 465, secure: true,
    hint: 'Resend: username is "resend", password is your API key.',
  },
};

export interface CandidateSmtpSettings {
  preset: SmtpPresetId;
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  /** G10: the vetted address to connect to (DNS-pinned by resolveSmtpDestination); `host` stays the TLS name. */
  connectAddress?: string;
}

// ── outbound policy (P8 / G10) ───────────────────────────────────────────────
// The owner-only settings route accepted any host:port and the test-send echoed the transport's error text, which made
// it a port scanner for the API's private network (connection refused vs timeout vs banner text). Store-configured SMTP
// now has to name a public host on a mail-submission port; the name is resolved once, every resolved address must be
// public and not this host, and the connection is pinned to the vetted address (TLS still verifies the configured
// name). Env-managed SMTP (SMTP_HOST) is operator configuration and is not subject to this policy.

/** Mail submission / relay ports SMTP providers publish (25 relay, 465 implicit TLS, 587 submission, 2525/2465/2587
 *  provider alternates). Anything else is not SMTP a store owner needs. */
export const SMTP_ALLOWED_PORTS: readonly number[] = [25, 465, 587, 2465, 2525, 2587];

const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export type SmtpPolicyFailure = 'invalid_host' | 'port_not_allowed' | 'host_unresolvable' | 'destination_not_allowed';
export class SmtpDestinationError extends Error {
  constructor(readonly reason: SmtpPolicyFailure) { super(SMTP_POLICY_MESSAGES[reason]); }
}
export const SMTP_POLICY_MESSAGES: Record<SmtpPolicyFailure, string> = {
  invalid_host: 'SMTP host must be a public DNS name',
  port_not_allowed: `SMTP port must be one of ${SMTP_ALLOWED_PORTS.join(', ')}`,
  host_unresolvable: 'SMTP host could not be resolved',
  destination_not_allowed: 'SMTP host must not point to a private, local or internal address',
};

type SmtpLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
const defaultSmtpLookup: SmtpLookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** Syntax-only part of the policy (no DNS): usable at save time for a fast 400. */
export function checkSmtpDestinationShape(host: string, port: number): SmtpPolicyFailure | null {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (isIP(h) || !HOSTNAME_RE.test(h) || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return 'invalid_host';
  if (!SMTP_ALLOWED_PORTS.includes(port)) return 'port_not_allowed';
  return null;
}

/** Full policy: shape + DNS. Returns the address to pin the connection to; throws SmtpDestinationError otherwise. */
export async function resolveSmtpDestination(host: string, port: number, lookup: SmtpLookup = defaultSmtpLookup): Promise<{ host: string; address: string }> {
  const shape = checkSmtpDestinationShape(host, port);
  if (shape) throw new SmtpDestinationError(shape);
  const name = host.trim().toLowerCase().replace(/\.$/, '');
  let records: Array<{ address: string; family: number }>;
  try { records = await lookup(name); } catch { throw new SmtpDestinationError('host_unresolvable'); }
  if (!records.length) throw new SmtpDestinationError('host_unresolvable');
  if (records.some((r) => isPrivateOrSpecialAddress(r.address))) throw new SmtpDestinationError('destination_not_allowed');
  // Reuse the shared outbound policy for the "this host" (OUTBOUND_SELF_IPS / interface) check, fed the SAME records.
  try {
    await assertSafeOutboundUrl(`https://${name}/`, { lookup: async () => records });
  } catch {
    throw new SmtpDestinationError('destination_not_allowed');
  }
  return { host: name, address: records[0]!.address };
}

/** Fixed, non-reflective categories for a failed test send — never the transport's own error text. */
export function smtpFailureMessage(err: unknown): string {
  if (err instanceof SmtpDestinationError) return err.message;
  const code = (err as { code?: unknown } | null)?.code;
  switch (code) {
    case 'EAUTH': return 'The SMTP server rejected the username or password';
    case 'ETLS': return 'Could not establish a secure (TLS) connection to the SMTP server';
    case 'EENVELOPE': return 'The SMTP server refused the sender or recipient address';
    case 'EMESSAGE': return 'The SMTP server refused the message';
    case 'ETIMEDOUT': return 'The SMTP server did not respond in time';
    default: return 'Could not connect to the SMTP server — check the host, port and security settings';
  }
}

/** Merge a preset's defaults with any explicit overrides the owner already typed. */
export function resolveSmtpPreset(preset: SmtpPresetId, overrides: Partial<Pick<CandidateSmtpSettings, 'host' | 'port' | 'secure'>> = {}): Pick<CandidateSmtpSettings, 'host' | 'port' | 'secure'> {
  const defaults = SMTP_PRESETS[preset];
  return {
    host: overrides.host ?? defaults.host ?? '',
    port: overrides.port ?? defaults.port,
    secure: overrides.secure ?? defaults.secure,
  };
}

export interface SendTestEmailResult {
  delivered: boolean;
  error?: string;
}

export type TransportFactory = (settings: CandidateSmtpSettings) => Transporter;

const defaultTransportFactory: TransportFactory = (settings) =>
  nodemailer.createTransport({
    // G10: connect to the vetted, pinned address; TLS (implicit or STARTTLS) still verifies the configured name.
    host: settings.connectAddress ?? settings.host,
    port: settings.port,
    secure: settings.secure,
    tls: { servername: settings.host },
    auth: settings.user ? { user: settings.user, pass: settings.pass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

export async function sendTestEmail(
  settings: CandidateSmtpSettings,
  to: string,
  makeTransport: TransportFactory = defaultTransportFactory,
  opts: { lookup?: SmtpLookup } = {},
): Promise<SendTestEmailResult> {
  if (!settings.host || !settings.port) return { delivered: false, error: 'Host and port are required' };
  try {
    const dest = await resolveSmtpDestination(settings.host, settings.port, opts.lookup);
    const tx = makeTransport({ ...settings, host: dest.host, connectAddress: dest.address });
    await tx.sendMail({
      from: settings.user || 'test@sellright.local',
      to,
      subject: 'SellRight test email',
      text: 'This is a test email from your SellRight store settings. If you received this, your SMTP settings work.',
      html: '<p>This is a test email from your SellRight store settings. If you received this, your SMTP settings work.</p>',
    });
    return { delivered: true };
  } catch (err) {
    // G10: a fixed category only — the transport's text (banner, "ECONNREFUSED 10.0.0.5:5432", …) is never reflected.
    return { delivered: false, error: smtpFailureMessage(err) };
  }
}
