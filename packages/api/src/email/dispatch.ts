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

export interface StoreEmailCtx { name: string; currency: string; }

export async function sendOrderConfirmation(store: StoreEmailCtx, to: string, data: {
  code: string; grandTotal: number; currency: string;
  lines: Array<{ name: string; quantity: number; lineTotal: number }>;
}): Promise<void> {
  await sendEmail({ to, ...orderConfirmation(
    { name: store.name, currency: store.currency, storefrontUrl: env.STOREFRONT_URL, fromEmail: env.SMTP_FROM },
    data,
  ) });
}

export async function sendShippingNotification(store: StoreEmailCtx, to: string, data: {
  code: string; trackingCode: string | null; carrier: string | null;
}): Promise<void> {
  await sendEmail({ to, ...shippingNotification(
    { name: store.name, currency: store.currency, storefrontUrl: env.STOREFRONT_URL, fromEmail: env.SMTP_FROM },
    data,
  ) });
}

export async function sendStaffInvite(store: StoreEmailCtx, to: string, data: {
  acceptUrl: string; role: string; inviterEmail: string;
}): Promise<void> {
  await sendEmail({ to, ...staffInvite(
    { name: store.name, currency: store.currency, storefrontUrl: env.STOREFRONT_URL, fromEmail: env.SMTP_FROM },
    data,
  ) });
}
