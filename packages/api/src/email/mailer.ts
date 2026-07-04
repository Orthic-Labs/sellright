/**
 * Email service (WP2). SMTP via nodemailer; in dev/test without SMTP configured
 * it logs and returns (the storefront still works, ops just doesn't get notified).
 * The interface hides the provider so Resend/Postmark/etc. can drop in later.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../env.js';
import { log, err as logErr } from '../lib/logger.js';

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

let cached: Transporter | null = null;
function transport(): Transporter | null {
  if (!smtpEnabled()) return null;
  if (cached) return cached;
  cached = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return cached;
}

/** Send an email. No-op (with a log line) when SMTP is not configured. */
export async function sendEmail(input: SendEmailInput): Promise<{ delivered: boolean; reason?: string }> {
  const tx = transport();
  if (!tx) {
    log.info('email skipped', { reason: 'smtp_not_configured', to: input.to, subject: input.subject });
    return { delivered: false, reason: 'smtp_not_configured' };
  }
  try {
    await tx.sendMail({ from: input.from ?? env.SMTP_FROM, ...input });
    return { delivered: true };
  } catch (e) {
    logErr.error('email error', e, { to: input.to, subject: input.subject });
    return { delivered: false, reason: String(e instanceof Error ? e.message : e) };
  }
}
