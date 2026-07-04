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
import { eq, sql } from 'drizzle-orm';
import { pool, withStore, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { sendEmail, type SendEmailInput } from './mailer.js';

/** Per-attempt backoff in seconds: 1m, 5m, 30m, 2h, 12h. */
const BACKOFF_S = [60, 300, 1800, 7200, 43200];
const MAX_ATTEMPTS = 5;
const DEFAULT_BATCH_LIMIT = 50;
const MAX_BATCH_LIMIT = 500;

export function normalizeEmailBatchLimit(limit?: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_BATCH_LIMIT;
  return Math.min(MAX_BATCH_LIMIT, Math.max(1, Math.floor(limit!)));
}

/**
 * Enqueue an email delivery in the caller's transaction. Same shape as
 * webhooks/emit.ts emitEvent — the row is part of the same txn as the Paid
 * transition, so a rollback also drops the email. No SMTP at the call site.
 */
export async function enqueueEmail(tx: Tx, storeId: string, args: {
  kind: 'order_confirmation' | (string & {}); // string-narrow for forward-compat kinds
  recipient: string;
  payload: SendEmailInput;
}): Promise<void> {
  await tx.insert(s.emailOutbox).values({
    storeId,
    kind: args.kind,
    recipient: args.recipient,
    payload: args.payload as object,
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
    await withStore(st.id, async (tx) => {
      // Mirror the webhook claim: flip pending→processing + bump attempts in one
      // statement, claim under FOR UPDATE SKIP LOCKED so a concurrent scheduler
      // pass (multi-instance deploy) doesn't double-deliver the same row. The
      // claim is held for this txn; a crash leaves a recoverable 'processing'
      // row (the email reaper — see below — resets them).
      const claim = await tx.execute(
        sql`UPDATE email_outbox eo
            SET status = 'processing', attempts = eo.attempts + 1, updated_at = now()
            WHERE eo.id IN (
              SELECT id FROM email_outbox
              WHERE status = 'pending' AND next_attempt_at <= now()
              ORDER BY next_attempt_at
              LIMIT ${limit}
              FOR UPDATE SKIP LOCKED
            )
            RETURNING eo.id, eo.kind, eo.recipient, eo.payload, eo.attempts`,
      );
      const due = (claim as unknown as { rows: Array<{ id: string; kind: string; recipient: string; payload: SendEmailInput; attempts: number }> }).rows;

      for (const d of due) {
        try {
          const res = await sendEmail(d.payload);
          if (!res.delivered) throw new Error(res.reason ?? 'send failed');
          await tx.update(s.emailOutbox).set({ status: 'sent', sentAt: new Date(), updatedAt: new Date(), lastError: null }).where(eq(s.emailOutbox.id, d.id));
          sent++;
        } catch (e) {
          // `d.attempts` is the post-claim value (incremented at claim time);
          // use it directly for the give-up decision so BACKOFF progresses.
          const giveUp = d.attempts >= MAX_ATTEMPTS;
          const backoff = BACKOFF_S[Math.min(d.attempts - 1, BACKOFF_S.length - 1)]!;
          await tx.update(s.emailOutbox).set({
            lastError: String(e instanceof Error ? e.message : e),
            status: giveUp ? 'dead' : 'pending',
            nextAttemptAt: new Date(Date.now() + backoff * 1000),
            updatedAt: new Date(),
          }).where(eq(s.emailOutbox.id, d.id));
          if (giveUp) failed++;
        }
      }
      if (due.length) log(`[emails] ${st.id}: ${due.length} attempted`);
    });
  }
  return { sent, failed };
}