/**
 * WS-A (one-click install plan §1.7): SMTP settings presets + "send a test
 * email" for the admin Email settings page. Separate from mailer.ts's
 * env-only, cached transporter — this builds an ephemeral transporter from
 * CANDIDATE settings (not yet saved) so "Test connection" can verify before
 * the owner commits to them. `createTransport` is injected so unit tests
 * never open a real SMTP connection.
 */
import nodemailer, { type Transporter } from 'nodemailer';

export type SmtpPresetId = 'custom' | 'gmail' | 'ses' | 'postmark' | 'resend';

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
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: settings.user ? { user: settings.user, pass: settings.pass } : undefined,
    connectionTimeout: 10_000,
  });

export async function sendTestEmail(
  settings: CandidateSmtpSettings,
  to: string,
  makeTransport: TransportFactory = defaultTransportFactory,
): Promise<SendTestEmailResult> {
  if (!settings.host || !settings.port) return { delivered: false, error: 'Host and port are required' };
  try {
    const tx = makeTransport(settings);
    await tx.sendMail({
      from: settings.user || 'test@sellright.local',
      to,
      subject: 'SellRight test email',
      text: 'This is a test email from your SellRight store settings. If you received this, your SMTP settings work.',
      html: '<p>This is a test email from your SellRight store settings. If you received this, your SMTP settings work.</p>',
    });
    return { delivered: true };
  } catch (err) {
    return { delivered: false, error: err instanceof Error ? err.message : 'SMTP send failed' };
  }
}
