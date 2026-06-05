/**
 * Auto-Delivered cron (DD order-tools parity): mark Shipped fulfillments older
 * than N days as Delivered. Single idempotent pass; schedule via cron/BullMQ.
 * Usage: tsx src/jobs/auto-deliver.ts            # DRY RUN
 *        DAYS=10 tsx src/jobs/auto-deliver.ts --apply
 */
import { and, eq, lt } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';

async function main() {
  const apply = process.argv.includes('--apply');
  const days = Number(process.env.DAYS ?? 10);
  const cutoff = new Date(Date.now() - days * 86_400_000);
  console.log(`[auto-deliver] mode=${apply ? 'APPLY' : 'DRY-RUN'} days=${days} cutoff=${cutoff.toISOString()}`);

  const stores = await pool.query<{ id: string; slug: string }>('SELECT id, slug FROM store');
  let total = 0;
  for (const st of stores.rows) {
    const n = await withStore(st.id, async (tx) => {
      const due = await tx.select({ id: s.fulfillment.id, orderId: s.fulfillment.orderId })
        .from(s.fulfillment).where(and(eq(s.fulfillment.state, 'Shipped'), lt(s.fulfillment.updatedAt, cutoff)));
      if (apply) {
        for (const f of due) {
          await tx.update(s.fulfillment).set({ state: 'Delivered', updatedAt: new Date() }).where(eq(s.fulfillment.id, f.id));
          await tx.insert(s.auditLog).values({ storeId: st.id, actor: 'system:auto-deliver', entity: 'order', entityId: f.orderId, action: 'auto_delivered', toState: 'Delivered', data: { days } });
        }
      }
      return due.length;
    });
    total += n;
    if (n) console.log(`[auto-deliver] ${st.slug}: ${apply ? 'delivered' : 'would deliver'} ${n}`);
  }
  console.log(`[auto-deliver] done: ${total}${apply ? '' : ' (DRY RUN — --apply to act)'}`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
