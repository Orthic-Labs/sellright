/**
 * Event → email dispatch (WP2 wiring). Called by route handlers AFTER the
 * transaction commits — no point sending a confirmation for an order that
 * rolled back. Each function is best-effort: a send failure logs but does not
 * fail the parent operation (email is not in the critical path of checkout /
 * fulfillment). Use a separate retry job if delivery guarantees are needed.
 */
import { sendEmail } from './mailer.js';
import { orderConfirmation, shippingNotification, staffInvite } from './templates.js';
import { env } from '../env.js';

export interface StoreEmailCtx { name: string; currency: string; appKey?: string | null; }

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

function emailCtx(store: StoreEmailCtx) {
  const fromEmail = appValue(env.EMAIL_FROM_BY_APP, store.appKey) ?? env.SMTP_FROM;
  const storefrontUrl = appValue(env.STOREFRONT_URL_BY_APP, store.appKey) ?? env.STOREFRONT_URL;
  return { name: store.name, currency: store.currency, storefrontUrl, fromEmail };
}

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
