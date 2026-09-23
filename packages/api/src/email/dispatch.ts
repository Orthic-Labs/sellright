/**
 * Event → email dispatch (WP2 wiring). Two flavors:
 *
 * - `enqueue*` (SR-12): render + enqueue into the transactional email outbox
 *   inside the caller's transaction — the required durable path for
 *   transactional mail (order confirmation, shipping, password reset, email
 *   verification, refund confirmation, email-address change). A rollback drops
 *   the email; the scheduler retries delivery with backoff + dead-letter.
 * - `send*` (legacy inline): best-effort direct send, used only where a durable
 *   retry is not required (staff invite) and kept for back-compat.
 *
 * Sender/URL identity (SR-05) resolves PER STORE, most specific wins:
 *   per-app env map (shared stores sell multiple brands under one tenant;
 *   EMAIL_FROM_BY_APP / EMAIL_NAME_BY_APP / STOREFRONT_URL_BY_APP keyed by product appKey)
 *   → store.config (storefrontUrl / emailFrom, set by the importer or admin)
 *   → global env (STOREFRONT_URL / SMTP_FROM).
 * A tenant store's mail must never link to another tenant's storefront just
 * because the deployment-wide env points elsewhere.
 */
import { sendEmail } from './mailer.js';
import {
  orderConfirmation,
  shippingNotification,
  staffInvite,
  passwordReset,
  emailVerify,
  emailAddressChange,
  orderRefundConfirmation,
  magicLinkAccess,
  trialLicenseKey,
} from './templates.js';
import { enqueueEmail } from './outbox.js';
import { env } from '../env.js';
import type { Tx } from '../db/client.js';

/** Email outbox `kind` values. 'order-refund-confirmation' is the cross-lane
 *  PAR-03 contract key — the payments lane enqueues under exactly this key at
 *  definitive settlement, so the string is frozen even though the older kinds
 *  are snake_case. */
export const EMAIL_KIND = {
  ORDER_CONFIRMATION: 'order_confirmation',
  SHIPPING_NOTIFICATION: 'shipping_notification',
  PASSWORD_RESET: 'password_reset',
  EMAIL_VERIFY: 'email_verify',
  EMAIL_CHANGE: 'email_change',
  MAGIC_LINK: 'magic_link',
  ORDER_REFUND_CONFIRMATION: 'order-refund-confirmation',
} as const;

export interface StoreEmailCtx {
  name: string;
  currency: string;
  appKey?: string | null;
  /** store.config JSONB — carries storefrontUrl / emailFrom when set (SR-05). */
  config?: unknown;
}

function parseAppMap(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw?.trim()) return out;
  for (const entry of raw.split(/[,\n;]/)) {
    const idx = entry.indexOf('=');
    if (idx <= 0) continue;
    const key = entry.slice(0, idx).trim().toLowerCase();
    const value = entry.slice(idx + 1).trim();
    if (key && value) out.set(key, value);
  }
  return out;
}

export function appValue(raw: string | undefined, appKey: string | null | undefined): string | undefined {
  const key = appKey?.trim().toLowerCase();
  if (!key) return undefined;
  return parseAppMap(raw).get(key);
}

export function pickEmailAppKey(appKeys: Array<string | null | undefined>): string | null {
  const unique = [...new Set(appKeys.map((key) => key?.trim().toLowerCase()).filter(Boolean))] as string[];
  return unique.length === 1 ? unique[0]! : null;
}

const configStr = (config: unknown, key: string): string | undefined => {
  if (!config || typeof config !== 'object') return undefined;
  const v = (config as Record<string, unknown>)[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
};

/** Canonical storefront base URL for a store's emails (no trailing slash, so
 *  callers can append `/path` uniformly). Falls back to the global env only
 *  when neither an app override nor the store's own config supplies one; a
 *  malformed config value is ignored rather than shipped into a customer link. */
export function resolveStorefrontUrl(store: StoreEmailCtx): string {
  const candidate =
    appValue(env.STOREFRONT_URL_BY_APP, store.appKey)
    ?? configStr(store.config, 'storefrontUrl')
    ?? env.STOREFRONT_URL;
  const url = candidate.trim().replace(/\/+$/, '');
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return env.STOREFRONT_URL;
  } catch {
    return env.STOREFRONT_URL;
  }
  return url;
}

/** Canonical sender for a store's emails. `emailFrom` may be a bare address or
 *  a "Name <addr>" display form — nodemailer accepts both. */
export function resolveFromEmail(store: StoreEmailCtx): string {
  return appValue(env.EMAIL_FROM_BY_APP, store.appKey)
    ?? configStr(store.config, 'emailFrom')
    ?? configStr(store.config, 'fromEmail')
    ?? env.SMTP_FROM;
}

function emailCtx(store: StoreEmailCtx) {
  return {
    name: appValue(env.EMAIL_NAME_BY_APP, store.appKey) ?? store.name,
    currency: store.currency,
    storefrontUrl: resolveStorefrontUrl(store),
    fromEmail: resolveFromEmail(store),
  };
}

// ── Durable path (SR-12): render + enqueue inside the caller's txn ──────────
// Each returns whether a new outbox row was inserted (dedupeKey suppression can
// make it a no-op) so callers can log/branch without a second query.

export async function enqueueOrderConfirmation(tx: Tx, storeId: string, store: StoreEmailCtx, to: string, data: {
  code: string; grandTotal: number; currency: string;
  lines: Array<{ name: string; quantity: number; lineTotal: number }>;
  dedupeKey?: string;
}): Promise<boolean> {
  const ctx = emailCtx(store);
  const rendered = orderConfirmation(ctx, data);
  return enqueueEmail(tx, storeId, {
    kind: EMAIL_KIND.ORDER_CONFIRMATION,
    dedupeKey: data.dedupeKey,
    recipient: to,
    payload: { to, from: ctx.fromEmail, subject: rendered.subject, html: rendered.html, text: rendered.text },
  });
}

export async function enqueueShippingNotification(tx: Tx, storeId: string, store: StoreEmailCtx, to: string, data: {
  code: string; trackingCode: string | null; carrier: string | null;
  dedupeKey?: string;
}): Promise<boolean> {
  const ctx = emailCtx(store);
  const rendered = shippingNotification(ctx, data);
  return enqueueEmail(tx, storeId, {
    kind: EMAIL_KIND.SHIPPING_NOTIFICATION,
    dedupeKey: data.dedupeKey,
    recipient: to,
    payload: { to, from: ctx.fromEmail, subject: rendered.subject, html: rendered.html, text: rendered.text },
  });
}

export async function enqueuePasswordReset(tx: Tx, storeId: string, store: StoreEmailCtx, to: string, data: {
  url: string; ttlHours: number; dedupeKey?: string;
}): Promise<boolean> {
  const ctx = emailCtx(store);
  const rendered = passwordReset(ctx, data);
  return enqueueEmail(tx, storeId, {
    kind: EMAIL_KIND.PASSWORD_RESET,
    dedupeKey: data.dedupeKey,
    recipient: to,
    payload: { to, from: ctx.fromEmail, subject: rendered.subject, html: rendered.html, text: rendered.text },
  });
}

export async function enqueueEmailVerify(tx: Tx, storeId: string, store: StoreEmailCtx, to: string, data: {
  url: string; dedupeKey?: string;
}): Promise<boolean> {
  const ctx = emailCtx(store);
  const rendered = emailVerify(ctx, data);
  return enqueueEmail(tx, storeId, {
    kind: EMAIL_KIND.EMAIL_VERIFY,
    dedupeKey: data.dedupeKey,
    recipient: to,
    payload: { to, from: ctx.fromEmail, subject: rendered.subject, html: rendered.html, text: rendered.text },
  });
}

/** Passwordless sign-in link. Enqueued inside the request txn so the email
 *  and the minted token commit together — a rolled-back request can't mail a
 *  dead link, and delivery retries through the outbox instead of dropping. */
export async function enqueueMagicLink(tx: Tx, storeId: string, store: StoreEmailCtx, to: string, data: {
  url: string; ttlMinutes: number; isNewAccount?: boolean; dedupeKey?: string;
}): Promise<boolean> {
  const ctx = emailCtx(store);
  const rendered = magicLinkAccess(ctx, { url: data.url, ttlMinutes: data.ttlMinutes, isNewAccount: data.isNewAccount ?? false });
  return enqueueEmail(tx, storeId, {
    kind: EMAIL_KIND.MAGIC_LINK,
    dedupeKey: data.dedupeKey,
    recipient: to,
    payload: { to, from: ctx.fromEmail, subject: rendered.subject, html: rendered.html, text: rendered.text },
  });
}

export async function enqueueEmailAddressChange(tx: Tx, storeId: string, store: StoreEmailCtx, to: string, data: {
  url: string; newEmail: string; ttlHours: number; dedupeKey?: string;
}): Promise<boolean> {
  const ctx = emailCtx(store);
  const rendered = emailAddressChange(ctx, data);
  return enqueueEmail(tx, storeId, {
    kind: EMAIL_KIND.EMAIL_CHANGE,
    dedupeKey: data.dedupeKey,
    recipient: to,
    payload: { to, from: ctx.fromEmail, subject: rendered.subject, html: rendered.html, text: rendered.text },
  });
}

/** PAR-03 template side. Call ONLY at definitive settlement (refund.state ===
 *  'Settled' — never Pending/unknown). Pass a dedupeKey derived from the refund
 *  id so a replayed settlement event can't send the customer a second mail. */
export async function enqueueRefundConfirmation(tx: Tx, storeId: string, store: StoreEmailCtx, to: string, data: {
  code: string; amount: number; currency: string; refundedTotal: number; grandTotal: number;
  dedupeKey?: string;
}): Promise<boolean> {
  const ctx = emailCtx(store);
  const rendered = orderRefundConfirmation(ctx, data);
  return enqueueEmail(tx, storeId, {
    kind: EMAIL_KIND.ORDER_REFUND_CONFIRMATION,
    dedupeKey: data.dedupeKey,
    recipient: to,
    payload: { to, from: ctx.fromEmail, subject: rendered.subject, html: rendered.html, text: rendered.text },
  });
}

// ── Inline path (legacy; non-durable) ────────────────────────────────────────

export async function sendOrderConfirmation(store: StoreEmailCtx, to: string, data: {
  code: string; grandTotal: number; currency: string;
  lines: Array<{ name: string; quantity: number; lineTotal: number }>;
}): Promise<void> {
  const ctx = emailCtx(store);
  await sendEmail({ to, from: ctx.fromEmail, ...orderConfirmation(ctx, data) });
}

export async function sendShippingNotification(store: StoreEmailCtx, to: string, data: {
  code: string; trackingCode: string | null; carrier: string | null;
}): Promise<void> {
  const ctx = emailCtx(store);
  await sendEmail({ to, from: ctx.fromEmail, ...shippingNotification(ctx, data) });
}

export async function sendStaffInvite(store: StoreEmailCtx, to: string, data: {
  acceptUrl: string; role: string; inviterEmail: string;
}): Promise<void> {
  const ctx = emailCtx(store);
  await sendEmail({ to, from: ctx.fromEmail, ...staffInvite(ctx, data) });
}

export async function sendTrialKey(store: StoreEmailCtx, to: string, data: {
  key: string; days: number; pricingUrl?: string;
}): Promise<void> {
  const ctx = emailCtx(store);
  await sendEmail({ to, from: ctx.fromEmail, ...trialLicenseKey(ctx, {
    ...data,
    pricingUrl: data.pricingUrl ?? `${ctx.storefrontUrl}/pricing`,
  }) });
}
