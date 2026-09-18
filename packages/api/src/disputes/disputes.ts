/**
 * PAR-07: canonical dispute/chargeback record + operator notification.
 *
 * One entry point — recordDispute() — used by every provider's ingestion path:
 *   - Stripe: payments/webhook-reconcile.ts recordStripeDispute (call-site is
 *     owned by the payments lane; integration note in the lane report).
 *   - NMI:    routes/disputes.ts chargeback webhook (this lane).
 *
 * The dispute table's (store_id, provider, provider_ref) unique index makes
 * provider retries a no-op: the operator email is enqueued exactly once, in
 * the same transaction as the record (transactional outbox — a rollback drops
 * the email too).
 *
 * Operator recipients resolve in order:
 *   1. store.config.notifications.disputeEmail / operatorEmail (string | list)
 *   2. the store's owner + manager admin emails (admin_user_store)
 * No recipients → the dispute row + audit trail still persist; the email is
 * just skipped (never blocks ingestion).
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { dispute } from '../db/schema-ops.js';
import { emitEvent } from '../webhooks/emit.js';
import { enqueueEmail } from '../email/outbox.js';
import { disputeAlert } from '../email/templates-ops.js';
import { env } from '../env.js';

export interface DisputeInput {
  provider: 'stripe' | 'nmi' | (string & {});
  providerRef: string;
  paymentId?: string | null;
  orderId?: string | null;
  orderCode?: string | null;
  amountCents?: number | null;
  currency?: string | null;
  reason?: string | null;
  status?: string;
  details?: Record<string, unknown>;
  actor?: string;
}

export interface DisputeResult {
  created: boolean;
  disputeId?: string;
  orderId?: string | null;
  notified: number; // operator emails enqueued
}

/** Resolve operator recipients for dispute alerts. Config first, then the
 *  store's owner/manager admin users. */
export async function operatorRecipients(tx: Tx, storeId: string): Promise<string[]> {
  const [row] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, storeId)).limit(1);
  const notif = ((row?.config as { notifications?: Record<string, unknown> } | null)?.notifications) ?? {};
  const raw = notif.disputeEmail ?? notif.operatorEmail;
  const fromConfig = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [])
    .map((x) => String(x).trim()).filter((x) => x.includes('@'));
  if (fromConfig.length) return [...new Set(fromConfig)].slice(0, 10);

  // admin_user / admin_user_store are RLS-exempt registry tables — safe to
  // join inside the store-scoped tx.
  const r = await tx.execute(sql`
    SELECT au.email FROM admin_user au
    JOIN admin_user_store aus ON aus.admin_user_id = au.id
    WHERE aus.store_id = ${storeId} AND aus.role IN ('owner','manager')
    ORDER BY aus.role = 'owner' DESC, au.email
    LIMIT 10`);
  return [...new Set((r.rows as Array<{ email: string }>).map((x) => x.email).filter(Boolean))];
}

/**
 * Record a dispute and, on FIRST insert only, enqueue the operator alert.
 * Returns { created:false } for a provider retry — callers can rely on it for
 * idempotency instead of maintaining their own dedupe.
 */
export async function recordDispute(tx: Tx, storeId: string, d: DisputeInput): Promise<DisputeResult> {
  const [inserted] = await tx.insert(dispute).values({
    storeId,
    provider: d.provider,
    providerRef: d.providerRef,
    paymentId: d.paymentId ?? null,
    orderId: d.orderId ?? null,
    amount: d.amountCents ?? null,
    currency: d.currency ?? null,
    reason: d.reason ?? null,
    status: d.status ?? 'open',
    details: (d.details ?? null) as object | null,
    notifiedAt: null,
  }).onConflictDoNothing().returning({ id: dispute.id });

  if (!inserted) {
    const [existing] = await tx.select({ id: dispute.id, orderId: dispute.orderId })
      .from(dispute)
      .where(and(eq(dispute.provider, d.provider), eq(dispute.providerRef, d.providerRef)))
      .limit(1);
    return { created: false, disputeId: existing?.id, orderId: existing?.orderId ?? null, notified: 0 };
  }

  await tx.insert(s.auditLog).values({
    storeId,
    actor: d.actor ?? `${d.provider}:webhook`,
    entity: 'order',
    entityId: d.orderId ?? d.providerRef,
    action: 'dispute_opened',
    data: { provider: d.provider, providerRef: d.providerRef, amount: d.amountCents ?? null, reason: d.reason ?? null, orderCode: d.orderCode ?? null },
  });
  await emitEvent(tx, storeId, 'order.dispute_opened', {
    code: d.orderCode ?? null, provider: d.provider, disputeId: d.providerRef,
    amount: d.amountCents ?? null, reason: d.reason ?? null,
  });

  const [store] = await tx.select({ name: s.store.name, currency: s.store.currency, config: s.store.config })
    .from(s.store).where(eq(s.store.id, storeId)).limit(1);
  const recipients = await operatorRecipients(tx, storeId);
  const storefrontUrl = ((store?.config as { storefrontUrl?: string } | null)?.storefrontUrl) ?? env.STOREFRONT_URL;
  const rendered = disputeAlert(
    { name: store?.name ?? 'Store', currency: store?.currency ?? 'USD', storefrontUrl, fromEmail: env.SMTP_FROM ?? '' },
    {
      provider: d.provider, providerRef: d.providerRef, orderCode: d.orderCode ?? null,
      amountCents: d.amountCents ?? null, currency: d.currency ?? store?.currency ?? null,
      reason: d.reason ?? null, status: d.status ?? 'open',
    },
  );
  for (const recipient of recipients) {
    await enqueueEmail(tx, storeId, {
      kind: 'dispute_alert',
      recipient,
      payload: { to: recipient, from: env.SMTP_FROM, subject: rendered.subject, html: rendered.html, text: rendered.text },
      // Second layer of dedupe (migration 0057): even if a caller re-runs
      // outside the dispute-table guard, the outbox can never double-send.
      dedupeKey: `dispute_alert:${d.provider}:${d.providerRef}:${recipient}`,
    });
  }
  if (recipients.length) {
    await tx.update(dispute).set({ notifiedAt: new Date() }).where(eq(dispute.id, inserted.id));
  }
  return { created: true, disputeId: inserted.id, orderId: d.orderId ?? null, notified: recipients.length };
}

/**
 * Stripe adapter — matches payments/webhook-reconcile.ts's DisputeDescriptor.
 * The payments lane owns that file; integration is ONE line inside
 * recordStripeDispute():
 *
 *   await recordStripeDisputeAlert(tx, storeId, d);
 *
 * Idempotent on d.disputeId via the (store,provider,provider_ref) unique
 * index, so it can be added beside the existing audit/emitEvent calls without
 * any other dedupe work.
 */
export async function recordStripeDisputeAlert(tx: Tx, storeId: string, d: {
  disputeId: string; amount: number; reason: string; status: string; piId: string | null;
}): Promise<DisputeResult> {
  let paymentId: string | null = null;
  let orderId: string | null = null;
  let orderCode: string | null = null;
  if (d.piId) {
    const [pay] = await tx.select({ id: s.payment.id, orderId: s.payment.orderId })
      .from(s.payment).where(eq(s.payment.providerRef, d.piId)).limit(1);
    paymentId = pay?.id ?? null;
    orderId = pay?.orderId ?? null;
    if (orderId) {
      const [o] = await tx.select({ code: s.order.code }).from(s.order).where(eq(s.order.id, orderId)).limit(1);
      orderCode = o?.code ?? null;
    }
  }
  return recordDispute(tx, storeId, {
    provider: 'stripe',
    providerRef: d.disputeId,
    paymentId, orderId, orderCode,
    amountCents: d.amount,
    reason: d.reason,
    status: d.status,
    actor: 'stripe:webhook',
  });
}
