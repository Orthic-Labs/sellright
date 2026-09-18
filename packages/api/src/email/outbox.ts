/**
 * Email outbox (REL-4 / DISPATCH.md). Mirrors the webhook outbox pattern in
 * ../webhooks/emit.ts: enqueue a row inside the same transaction that produced
 * the event (transactional outbox — no email is lost or sent for a rolled-back
 * order), then deliverEmails() is the scheduler pass that pushes due rows
 * with exponential backoff + dead-letter after MAX_ATTEMPTS.
 *
 * Why a separate outbox (and not just inline sendEmail): the previous inline
 * path silently dropped confirmations during SMTP outages — a paid customer
 * got nothing and ops had no record. The outbox gives us a durable retry
 * queue and a 'dead' state for ops to investigate.
 *
 * The payload column carries the FULL serialized sendEmail input (to, subject,
 * html, text, from?) so the scheduler never has to re-derive any rendering —
 * re-rendering on retry would risk drift between the order-snapshot the
 * customer paid for and the email they finally receive.
 */
import { and, eq, sql } from 'drizzle-orm';
import { pool, withStore, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { sendEmail, type SendEmailInput } from './mailer.js';
import { emitEvent } from '../webhooks/emit.js';

/** Per-attempt backoff in seconds: 1m, 5m, 30m, 2h, 12h. */
const BACKOFF_S = [60, 300, 1800, 7200, 43200];
const MAX_ATTEMPTS = 5;
const DEFAULT_BATCH_LIMIT = 50;
const MAX_BATCH_LIMIT = 500;

type ClaimedEmail = {
  id: string;
  kind: string;
  recipient: string;
  payload: SendEmailInput;
  attempts: number;
};

export function normalizeEmailBatchLimit(limit?: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_BATCH_LIMIT;
  return Math.min(MAX_BATCH_LIMIT, Math.max(1, Math.floor(limit!)));
}

/**
 * Enqueue an email delivery in the caller's transaction. Same shape as
 * webhooks/emit.ts emitEvent — the row is part of the same txn as the Paid
 * transition, so a rollback also drops the email. No SMTP at the call site.
 *
 * `dedupeKey` (migration 0057) gives event-driven sends exactly-once enqueue
 * semantics: a second enqueue carrying a key already present for this store is
 * a silent no-op (ON CONFLICT DO NOTHING on the partial unique index), so a
 * replayed settlement/fulfillment event can never double-email the customer.
 * Returns true when a new outbox row was actually inserted.
 */
export async function enqueueEmail(tx: Tx, storeId: string, args: {
  kind: 'order_confirmation' | (string & {}); // string-narrow for forward-compat kinds
  recipient: string;
  payload: SendEmailInput;
  dedupeKey?: string;
}): Promise<boolean> {
  if (args.dedupeKey) {
    // Raw SQL: dedupe_key is added by hand-written migration 0057 and is not on
    // the drizzle schema (schema-orders.ts is owned by another lane).
    const r = await tx.execute(
      sql`INSERT INTO email_outbox (store_id, kind, recipient, payload, dedupe_key)
          VALUES (${storeId}, ${args.kind}, ${args.recipient}, ${JSON.stringify(args.payload)}::jsonb, ${args.dedupeKey})
          ON CONFLICT DO NOTHING
          RETURNING id`,
    );
    return r.rows.length > 0;
  }
  await tx.insert(s.emailOutbox).values({
    storeId,
    kind: args.kind,
    recipient: args.recipient,
    payload: args.payload as object,
  });
  return true;
}

async function claimDueEmails(storeId: string, limit: number): Promise<ClaimedEmail[]> {
  return withStore(storeId, async (tx) => {
    const claim = await tx.execute(
      sql`UPDATE email_outbox eo
          SET status = 'processing', attempts = eo.attempts + 1, updated_at = now()
          WHERE eo.id IN (
            SELECT id FROM email_outbox
            WHERE (status = 'pending' AND next_attempt_at <= now())
               OR (status = 'processing' AND updated_at < now() - interval '10 minutes')
            ORDER BY next_attempt_at
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
          )
          RETURNING eo.id, eo.kind, eo.recipient, eo.payload, eo.attempts`,
    );
    return (claim as unknown as { rows: ClaimedEmail[] }).rows;
  });
}

async function finalizeEmail(
  storeId: string,
  delivery: ClaimedEmail,
  outcome: { ok: true } | { ok: false; error: unknown },
): Promise<'sent' | 'retry' | 'dead' | 'stale'> {
  return withStore(storeId, async (tx) => {
    if (outcome.ok) {
      const rows = await tx
        .update(s.emailOutbox)
        .set({ status: 'sent', sentAt: new Date(), updatedAt: new Date(), lastError: null })
        .where(and(
          eq(s.emailOutbox.id, delivery.id),
          eq(s.emailOutbox.status, 'processing'),
          eq(s.emailOutbox.attempts, delivery.attempts),
        ))
        .returning({ id: s.emailOutbox.id });
      return rows.length ? 'sent' : 'stale';
    }

    const giveUp = delivery.attempts >= MAX_ATTEMPTS;
    const backoff = BACKOFF_S[Math.min(delivery.attempts - 1, BACKOFF_S.length - 1)]!;
    const lastError = String(outcome.error instanceof Error ? outcome.error.message : outcome.error);
    const rows = await tx
      .update(s.emailOutbox)
      .set({
        lastError,
        status: giveUp ? 'dead' : 'pending',
        nextAttemptAt: new Date(Date.now() + backoff * 1000),
        updatedAt: new Date(),
      })
      .where(and(
        eq(s.emailOutbox.id, delivery.id),
        eq(s.emailOutbox.status, 'processing'),
        eq(s.emailOutbox.attempts, delivery.attempts),
      ))
      .returning({ id: s.emailOutbox.id });
    if (!rows.length) return 'stale';
    if (!giveUp) return 'retry';
    // SR-12: an exhausted delivery must not be silent. Two operator-visible
    // signals, committed atomically with the dead transition:
    //   1. audit_log row (the existing admin-visible audit mechanism);
    //   2. an 'email.dead' event through the webhook outbox, so any subscribed
    //      endpoint (ops alerting) gets the failure as a first-class event.
    await tx.insert(s.auditLog).values({
      storeId,
      actor: 'system:email-outbox',
      entity: 'email_outbox',
      entityId: delivery.id,
      action: 'delivery_dead',
      data: { kind: delivery.kind, recipient: delivery.recipient, attempts: delivery.attempts, lastError },
    });
    await emitEvent(tx, storeId, 'email.dead', {
      id: delivery.id,
      kind: delivery.kind,
      recipient: delivery.recipient,
      attempts: delivery.attempts,
      lastError,
    });
    return 'dead';
  });
}

/** Deliver due pending emails across all stores (scheduler-driven). */
export async function deliverEmails(opts: { limit?: number; log?: (m: string) => void } = {}): Promise<{ sent: number; failed: number }> {
  const log = opts.log ?? (() => {});
  const limit = normalizeEmailBatchLimit(opts.limit);
  const stores = await pool.query<{ id: string }>('SELECT id FROM store');
  let sent = 0;
  let failed = 0;

  for (const st of stores.rows) {
    const due = await claimDueEmails(st.id, limit);
    for (const d of due) {
      let outcome: { ok: true } | { ok: false; error: unknown };
      try {
        const res = await sendEmail(d.payload);
        if (!res.delivered) throw new Error(res.reason ?? 'send failed');
        outcome = { ok: true };
      } catch (error) {
        outcome = { ok: false, error };
      }
      const result = await finalizeEmail(st.id, d, outcome);
      if (result === 'sent') sent++;
      else if (result === 'dead') failed++;
    }
    if (due.length) log(`[emails] ${st.id}: ${due.length} attempted`);
  }
  return { sent, failed };
}
