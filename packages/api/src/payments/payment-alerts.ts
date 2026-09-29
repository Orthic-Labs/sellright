/**
 * Operator-visible payment alerts (payments audit D3/D4/D9/D14). Captured or
 * in-flight money that could not be applied automatically must never be a
 * silent drop: it lands in audit_log (surfaced by GET
 * /v1/admin/payment-reconciliation as `alerts`) and, where the store has
 * operator recipients, an outbox email deduped per alert+reference+recipient.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import { enqueueEmail } from '../email/outbox.js';
import { paymentAlert } from '../email/templates-ops.js';
import { operatorRecipients } from '../disputes/disputes.js';

/** audit_log actions the reconciliation list surfaces as alerts. */
export const PAYMENT_ALERT_ACTIONS = [
  'payment_after_cancel', // settle.ts MONEY-4 (any gateway)
  'stripe_verify_failed', // D3
  'duplicate_payment', // D4
  'stripe_mode_mismatch', // D9
] as const;
export type PaymentAlertKind = (typeof PAYMENT_ALERT_ACTIONS)[number];

const TITLES: Record<PaymentAlertKind, string> = {
  payment_after_cancel: 'Payment received for a cancelled order',
  stripe_verify_failed: 'Stripe payment could not be verified',
  duplicate_payment: 'Duplicate payment captured',
  stripe_mode_mismatch: 'Stripe event for a different mode',
};

export interface PaymentAlertInput {
  kind: PaymentAlertKind;
  orderId: string | null;
  orderCode: string | null;
  providerRef: string | null;
  amount: number | null;
  currency: string | null;
  detail: string;
  data?: Record<string, unknown>;
  /** false when the caller (e.g. settle.ts) already wrote the audit row. */
  audit?: boolean;
  /** false to skip the operator email (audit-only alerts, e.g. D9). */
  email?: boolean;
  actor?: string;
}

export async function recordPaymentAlert(tx: Tx, storeId: string, a: PaymentAlertInput): Promise<void> {
  if (a.audit !== false) {
    await tx.insert(s.auditLog).values({
      storeId, actor: a.actor ?? 'system:stripe', entity: 'order', entityId: a.orderId ?? a.providerRef ?? null,
      action: a.kind,
      data: { needsReconciliation: true, orderCode: a.orderCode, providerRef: a.providerRef, amount: a.amount, currency: a.currency, reason: a.detail, ...(a.data ?? {}) },
    });
  }
  if (a.email === false) return;
  const recipients = await operatorRecipients(tx, storeId);
  if (!recipients.length) return;
  const [store] = await tx.select({ name: s.store.name, currency: s.store.currency, config: s.store.config })
    .from(s.store).where(eq(s.store.id, storeId)).limit(1);
  const storefrontUrl = ((store?.config as { storefrontUrl?: string } | null)?.storefrontUrl) ?? env.STOREFRONT_URL;
  const rendered = paymentAlert(
    { name: store?.name ?? 'Store', currency: store?.currency ?? 'USD', storefrontUrl, fromEmail: env.SMTP_FROM ?? '' },
    { kind: a.kind, title: TITLES[a.kind], provider: 'stripe', providerRef: a.providerRef, orderCode: a.orderCode,
      amountCents: a.amount, currency: a.currency ?? store?.currency ?? null, detail: a.detail },
  );
  for (const recipient of recipients) {
    await enqueueEmail(tx, storeId, {
      kind: 'payment_alert', recipient,
      payload: { to: recipient, from: env.SMTP_FROM, subject: rendered.subject, html: rendered.html, text: rendered.text },
      dedupeKey: `payment_alert:${a.kind}:${a.providerRef ?? a.orderId ?? 'none'}:${recipient}`,
    });
  }
}

/** Recent alerts for the admin reconciliation list. */
export async function listPaymentAlerts(tx: Tx, limit = 100) {
  return tx.select().from(s.auditLog)
    .where(and(eq(s.auditLog.entity, 'order'), inArray(s.auditLog.action, [...PAYMENT_ALERT_ACTIONS])))
    .orderBy(desc(s.auditLog.at)).limit(limit);
}
