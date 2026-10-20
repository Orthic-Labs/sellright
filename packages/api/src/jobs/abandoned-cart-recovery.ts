/** Abandoned-cart recovery email: at most ONE reminder per abandoned cart.
 *
 *  cart-maintenance flags idle carts 'abandoned' (CART_ABANDON_HOURS) and bumps
 *  updated_at at that moment. This pass finds carts abandoned for at least
 *  CART_RECOVERY_DELAY_HOURS that have a captured email, are not converted, were
 *  never reminded, and whose address has not unsubscribed, then enqueues a
 *  `cart_recovery` email through email_outbox and stamps recovery_emailed_at in
 *  the SAME transaction (transactional outbox — no stamp without a row, no row
 *  without a stamp). Rows are claimed FOR UPDATE SKIP LOCKED and the outbox
 *  dedupe key `cart-recovery:<cartId>` backs the "once" guarantee.
 *
 *  Opt-out: store.config.marketing.cartRecovery === false. Default enabled.
 *  Carts abandoned longer ago than the link lifetime (7 days) are never mailed,
 *  so enabling the feature cannot blast a stale backlog. An email captured on a
 *  cart is unverified — the reminder reveals nothing but the item names.
 *
 *  Single idempotent pass; caller owns the pool lifecycle; never run from tests
 *  except through the exported function against a disposable DB. */
import { and, eq, inArray, isNotNull, isNull, gt, lt, sql } from 'drizzle-orm';
import { pool, withStore, type Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { enqueueCartRecovery, resolveStorefrontUrl } from '../email/dispatch.js';
import { buildRecoveryUrl, RECOVERY_LINK_TTL_MS } from '../cart/recovery-link.js';

const RECOVERY_BATCH = 100;

/** Default enabled; only an explicit `marketing.cartRecovery: false` opts a store out. */
export function cartRecoveryEnabled(config: unknown): boolean {
  const marketing = (config as { marketing?: { cartRecovery?: unknown } } | null | undefined)?.marketing;
  return marketing?.cartRecovery !== false;
}

/** Scan-and-lock the carts due a reminder for one store. */
export async function selectRecoveryCandidates(tx: Tx, storeId: string, delayHours: number, now = new Date()) {
  const dueBefore = new Date(now.getTime() - delayHours * 60 * 60 * 1000);
  const notOlderThan = new Date(now.getTime() - RECOVERY_LINK_TTL_MS);
  return tx
    .select({ id: s.cart.id, email: s.cart.email })
    .from(s.cart)
    .where(and(
      eq(s.cart.storeId, storeId), eq(s.cart.status, 'abandoned'),
      isNotNull(s.cart.email), sql`btrim(${s.cart.email}) <> ''`,
      isNull(s.cart.convertedOrderId), isNull(s.cart.recoveryEmailedAt),
      lt(s.cart.updatedAt, dueBefore), gt(s.cart.updatedAt, notOlderThan),
      sql`exists (select 1 from cart_line cl where cl.cart_id = ${s.cart.id})`,
      sql`not exists (select 1 from subscriber sb where sb.store_id = ${s.cart.storeId}
            and lower(sb.email) = lower(btrim(${s.cart.email})) and sb.status = 'unsubscribed')`,
    ))
    .limit(RECOVERY_BATCH)
    .for('update', { skipLocked: true });
}

async function lineSummary(tx: Tx, cartId: string): Promise<Array<{ name: string; quantity: number }>> {
  const rows = await tx
    .select({ sku: s.cartLine.sku, quantity: s.cartLine.quantity, product: s.product.name, variant: s.productVariant.name })
    .from(s.cartLine)
    .leftJoin(s.productVariant, eq(s.productVariant.id, s.cartLine.variantId))
    .leftJoin(s.product, eq(s.product.id, s.productVariant.productId))
    .where(eq(s.cartLine.cartId, cartId));
  return rows.map((r) => ({
    name: r.product ? (r.variant && r.variant !== r.product ? `${r.product} — ${r.variant}` : r.product) : r.sku,
    quantity: r.quantity,
  }));
}

export async function sendCartRecoveryEmails(opts: { delayHours: number; now?: Date }): Promise<{ enqueued: number }> {
  if (!(opts.delayHours > 0)) return { enqueued: 0 };
  const { rows: stores } = await pool.query<{ id: string; name: string; currency: string; config: unknown }>(
    'select id, name, currency, config from store');
  let enqueued = 0;
  for (const st of stores) {
    if (!cartRecoveryEnabled(st.config)) continue;
    enqueued += await withStore(st.id, async (tx) => {
      const due = await selectRecoveryCandidates(tx, st.id, opts.delayHours, opts.now);
      let n = 0;
      for (const c of due) {
        // Stamp first, guarded: only the pass that flips NULL -> now may enqueue.
        const [stamped] = await tx.update(s.cart).set({ recoveryEmailedAt: new Date() })
          .where(and(eq(s.cart.id, c.id), isNull(s.cart.recoveryEmailedAt), isNull(s.cart.convertedOrderId), inArray(s.cart.status, ['abandoned'])))
          .returning({ id: s.cart.id });
        if (!stamped) continue;
        const lines = await lineSummary(tx, c.id);
        const base = { name: st.name, currency: st.currency, config: st.config, storeId: st.id };
        const url = buildRecoveryUrl(resolveStorefrontUrl(base), st.id, c.id);
        if (await enqueueCartRecovery(tx, st.id, base, c.email!.trim(), { url, lines, dedupeKey: `cart-recovery:${c.id}` })) n += 1;
      }
      return n;
    });
  }
  return { enqueued };
}
