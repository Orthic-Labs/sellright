/**
 * Outbox retention (DB-M2). email_outbox keeps the full email payload and recipient address, push_outbox a device
 * token and payload, webhook_delivery the event payload; none of them was ever deleted outside account erasure.
 *
 *   email_outbox / push_outbox   status 'sent'  older than 30 days   status 'dead'   older than 90 days
 *   webhook_delivery             'delivered'    older than 30 days   'failed' (dead) older than 90 days
 *
 * Rows still pending/processing are never touched. Age is measured from the terminal timestamp (sent_at /
 * delivered_at, falling back to updated_at for rows written before those were set). Per store through its own
 * withStore transaction (FORCE RLS; every statement also carries an explicit store_id), batched oldest-first with
 * SKIP LOCKED and a per-run batch cap so a backlog spreads over hourly runs. Documented in
 * docs/PRIVACY-DATA-RETENTION.md.
 */
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';

export const OUTBOX_SENT_RETENTION_DAYS = 30;
export const OUTBOX_DEAD_RETENTION_DAYS = 90;

export type OutboxRetentionOpts = {
  apply: boolean;
  sentDays?: number;
  deadDays?: number;
  log?: (m: string) => void;
  batchLimit?: number;
};


// Each rule carries its own fully static statements (table and column names are literals in the SQL text), so the
// settlement-chokepoint check can read every write target; only values are bound.
type Sql = ReturnType<typeof sql>;
interface RuleSql { key: string; kind: 'sent' | 'dead'; count: (storeId: string, cutoff: Date) => Sql; del: (storeId: string, cutoff: Date, limit: number) => Sql }
export const OUTBOX_RULES: readonly RuleSql[] = [
  { key: 'email_outbox.sent', kind: 'sent',
    count: (s, c) => sql`SELECT count(*)::int AS n FROM email_outbox WHERE store_id = ${s} AND status = 'sent' AND coalesce(sent_at, updated_at) < ${c}`,
    del: (s, c, l) => sql`DELETE FROM email_outbox WHERE id IN (SELECT id FROM email_outbox WHERE store_id = ${s} AND status = 'sent' AND coalesce(sent_at, updated_at) < ${c} ORDER BY coalesce(sent_at, updated_at), id LIMIT ${l} FOR UPDATE SKIP LOCKED) RETURNING id` },
  { key: 'email_outbox.dead', kind: 'dead',
    count: (s, c) => sql`SELECT count(*)::int AS n FROM email_outbox WHERE store_id = ${s} AND status = 'dead' AND updated_at < ${c}`,
    del: (s, c, l) => sql`DELETE FROM email_outbox WHERE id IN (SELECT id FROM email_outbox WHERE store_id = ${s} AND status = 'dead' AND updated_at < ${c} ORDER BY updated_at, id LIMIT ${l} FOR UPDATE SKIP LOCKED) RETURNING id` },
  { key: 'push_outbox.sent', kind: 'sent',
    count: (s, c) => sql`SELECT count(*)::int AS n FROM push_outbox WHERE store_id = ${s} AND status = 'sent' AND coalesce(sent_at, updated_at) < ${c}`,
    del: (s, c, l) => sql`DELETE FROM push_outbox WHERE id IN (SELECT id FROM push_outbox WHERE store_id = ${s} AND status = 'sent' AND coalesce(sent_at, updated_at) < ${c} ORDER BY coalesce(sent_at, updated_at), id LIMIT ${l} FOR UPDATE SKIP LOCKED) RETURNING id` },
  { key: 'push_outbox.dead', kind: 'dead',
    count: (s, c) => sql`SELECT count(*)::int AS n FROM push_outbox WHERE store_id = ${s} AND status = 'dead' AND updated_at < ${c}`,
    del: (s, c, l) => sql`DELETE FROM push_outbox WHERE id IN (SELECT id FROM push_outbox WHERE store_id = ${s} AND status = 'dead' AND updated_at < ${c} ORDER BY updated_at, id LIMIT ${l} FOR UPDATE SKIP LOCKED) RETURNING id` },
  { key: 'webhook_delivery.delivered', kind: 'sent',
    count: (s, c) => sql`SELECT count(*)::int AS n FROM webhook_delivery WHERE store_id = ${s} AND status = 'delivered' AND coalesce(delivered_at, updated_at) < ${c}`,
    del: (s, c, l) => sql`DELETE FROM webhook_delivery WHERE id IN (SELECT id FROM webhook_delivery WHERE store_id = ${s} AND status = 'delivered' AND coalesce(delivered_at, updated_at) < ${c} ORDER BY coalesce(delivered_at, updated_at), id LIMIT ${l} FOR UPDATE SKIP LOCKED) RETURNING id` },
  { key: 'webhook_delivery.failed', kind: 'dead',
    count: (s, c) => sql`SELECT count(*)::int AS n FROM webhook_delivery WHERE store_id = ${s} AND status = 'failed' AND updated_at < ${c}`,
    del: (s, c, l) => sql`DELETE FROM webhook_delivery WHERE id IN (SELECT id FROM webhook_delivery WHERE store_id = ${s} AND status = 'failed' AND updated_at < ${c} ORDER BY updated_at, id LIMIT ${l} FOR UPDATE SKIP LOCKED) RETURNING id` },
];

const DEFAULT_BATCH_LIMIT = 500;
const MAX_BATCHES_PER_RULE = 20;

export async function reapOutboxes(opts: OutboxRetentionOpts): Promise<{ deleted: Record<string, number> }> {
  const { apply } = opts;
  const sentDays = opts.sentDays ?? OUTBOX_SENT_RETENTION_DAYS;
  const deadDays = opts.deadDays ?? OUTBOX_DEAD_RETENTION_DAYS;
  const log = opts.log ?? (() => {});
  const batchLimit = opts.batchLimit && opts.batchLimit > 0 ? Math.floor(opts.batchLimit) : DEFAULT_BATCH_LIMIT;
  if (!Number.isFinite(sentDays) || sentDays <= 0 || !Number.isFinite(deadDays) || deadDays <= 0) throw new Error('retention days must be positive numbers');
  const cutoffs = { sent: new Date(Date.now() - sentDays * 24 * 3_600_000), dead: new Date(Date.now() - deadDays * 24 * 3_600_000) };
  log(`[outbox-retention] mode=${apply ? 'APPLY' : 'DRY-RUN'} sent=${sentDays}d dead=${deadDays}d`);

  const deleted: Record<string, number> = {};
  const stores = await pool.query<{ id: string }>('SELECT id FROM store ORDER BY id');
  for (const st of stores.rows) {
    for (const rule of OUTBOX_RULES) {
      const cutoff = cutoffs[rule.kind];
      const key = rule.key;
      for (let batches = 0; batches < MAX_BATCHES_PER_RULE; batches++) {
        if (!apply) {
          const n = await withStore(st.id, async (tx) => {
            const r = await tx.execute(rule.count(st.id, cutoff));
            return (r.rows[0] as { n: number } | undefined)?.n ?? 0;
          });
          deleted[key] = (deleted[key] ?? 0) + n;
          break; // dry-run never loops
        }
        const n = await withStore(st.id, async (tx) => (await tx.execute(rule.del(st.id, cutoff, batchLimit))).rows.length);
        deleted[key] = (deleted[key] ?? 0) + n;
        if (n < batchLimit) break;
      }
    }
  }
  const total = Object.values(deleted).reduce((a, b) => a + b, 0);
  log(`[outbox-retention] done: ${total}${apply ? '' : ' (DRY RUN)'} ${JSON.stringify(deleted)}`);
  return { deleted };
}
