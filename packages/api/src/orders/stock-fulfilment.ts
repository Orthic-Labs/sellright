/**
 * #446 backorder: shipping consumes stock (on_hand -= n, allocated -= n). Because `allocated` may exceed `on_hand` (the
 * excess is backordered units that have not arrived), shipping more units of a variant than `on_hand` holds is refused
 * with a 409 naming the SKU, instead of clamping on_hand at zero (which would let a backordered line ship, and drift the
 * ledger, before the stock is received).
 *
 * Refused only when the variant is physical, not pre-order, on_hand < quantity AND stock.incoming > 0. Everything else (pre-order,
 * non-physical, incoming = 0 drift) keeps the legacy clamped decrement; a variant with no stock row is a no-op, as before.
 *
 * Callers run inside their own transaction (the throw rolls the whole shipment back) and keep their existing lock order
 * and post-commit onStockChanged call; this only replaces the clamped UPDATE.
 */
import { sql } from 'drizzle-orm';
import { HttpError } from '../routes/admin-helpers.js';

type ExecTx = { execute: (query: any) => PromiseLike<{ rowCount?: number | null; rows?: unknown[] }> };

export async function consumeStockForShipment(tx: ExecTx, storeId: string, line: { variantId: string; sku: string; quantity: number }): Promise<void> {
  const q = line.quantity;
  if (q <= 0) return;
  const ok = await tx.execute(sql`UPDATE "stock" SET on_hand = on_hand - ${q}, allocated = greatest(allocated - ${q}, 0)
    WHERE variant_id = ${line.variantId} AND store_id = ${storeId} AND on_hand >= ${q}`);
  if (ok.rowCount === 1) return;
  const probe = await tx.execute(sql`SELECT stk.on_hand, stk.incoming, pv.is_pre_order, pv.fulfillment_type
    FROM "stock" stk JOIN product_variant pv ON pv.id = stk.variant_id
    WHERE stk.variant_id = ${line.variantId} AND stk.store_id = ${storeId}`);
  const row = probe.rows?.[0] as { on_hand: number; incoming: number; is_pre_order: boolean; fulfillment_type: string } | undefined;
  if (!row) return; // no stock row: nothing to consume (unchanged)
  if (row.fulfillment_type === 'physical' && !row.is_pre_order && Number(row.incoming) > 0) {
    throw new HttpError(409, `cannot ship ${q} x ${line.sku}: only ${Number(row.on_hand)} on hand (the rest is still incoming; receive it first)`, 'INSUFFICIENT_ON_HAND', undefined, { skus: [line.sku], onHand: Number(row.on_hand), requested: q });
  }
  // Legacy clamped decrement: pre-order / non-physical variants, and variants with no incoming stock (allocated > on_hand
  // there is count drift, not backorder; refusing would block real shipments).
  await tx.execute(sql`UPDATE "stock" SET on_hand = greatest(on_hand - ${q}, 0), allocated = greatest(allocated - ${q}, 0)
    WHERE variant_id = ${line.variantId} AND store_id = ${storeId}`);
}
