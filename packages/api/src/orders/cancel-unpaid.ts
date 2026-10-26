/**
 * Cancel one unpaid (`PendingPayment`) order and give back what it held: allocated stock, reserved loyalty points and
 * the payment reservation. Shared by the stale-order job (an order left unpaid past the TTL) and the shopper's cart
 * reopen (#370: the shopper chose to change the cart behind the order). Both run it under the order's lock set.
 */
import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import type { HeldLocks } from '../db/locks.js';
import * as s from '../db/schema.js';
import { releaseOrderLoyalty } from '../loyalty/ledger.js';
import { release } from '../payments/reservation.js';
import { importedFinancialReconciliationPath } from '../import/source-compatibility.js';

/**
 * An order that may be cancelled as unpaid: `PendingPayment`, created before `cutoff`, not imported history, and with
 * no payment that is in flight, unresolved at Stripe or already authorised. `requireDiscovery` (a Stripe-enabled
 * store): the order's Stripe side must be known — it has tracked intents, or discovery searched Stripe clean.
 */
export function unpaidCancellablePredicate(storeId: string, cutoff: Date, requireDiscovery: boolean) {
  return sql`state = 'PendingPayment' AND created_at < ${cutoff} AND store_id = ${storeId}
    -- A present marker (including JSON null) holds imported history outside expiry batches.
    AND (metadata #> ARRAY[${importedFinancialReconciliationPath[0]}, ${importedFinancialReconciliationPath[1]}]::text[]) IS NULL
    AND NOT EXISTS (SELECT 1 FROM payment_attempt pa
      WHERE pa.order_id = "order".id AND pa.store_id = "order".store_id
        AND (pa.status IN ('processing', 'unknown', 'pending')
          -- D5: a tracked Stripe intent not yet resolved at Stripe
          OR (pa.operation = 'intent' AND pa.status IN ('open', 'failed', 'action_required'))))
    -- untracked-intent discovery failed: hold, never cancel blindly
    AND coalesce((metadata->'stripeDiscovery'->>'hold')::boolean, false) = false
    AND (${!requireDiscovery}
      OR EXISTS (SELECT 1 FROM payment_attempt pi WHERE pi.order_id = "order".id AND pi.store_id = "order".store_id AND pi.operation = 'intent')
      OR (metadata->'stripeDiscovery'->>'checkedAt') IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM payment p
      WHERE p.order_id = "order".id AND p.store_id = "order".store_id
        AND p.state IN ('Pending', 'Authorized'))`;
}

/** Units the order's lines still hold, per variant (quantity less fulfilled and cancelled). */
async function heldUnits(tx: Tx, orderId: string): Promise<Map<string, number>> {
  const lines = await tx
    .select({ variantId: s.orderLine.variantId, quantity: s.orderLine.quantity, fulfilledQty: s.orderLine.fulfilledQty, cancelledQty: s.orderLine.cancelledQty })
    .from(s.orderLine)
    .where(eq(s.orderLine.orderId, orderId));
  const byVariant = new Map<string, number>();
  for (const l of lines) {
    const rel = l.quantity - l.fulfilledQty - l.cancelledQty;
    if (rel > 0 && l.variantId) byVariant.set(l.variantId, (byVariant.get(l.variantId) ?? 0) + rel);
  }
  return byVariant;
}

export interface CancelUnpaidInput {
  storeId: string;
  orderId: string;
  actor: string;
  /** Stored on the audit row (`data`). */
  reason: Record<string, unknown>;
  stripeDiscoverable: boolean;
  /** false = count what would be released and write nothing (the job's dry run). */
  apply: boolean;
}

/**
 * Cancel the order inside the caller's lock set. The caller has already re-checked `unpaidCancellablePredicate` under
 * that set. Returns the units released (or that would be). The caller regenerates the catalog manifest after commit
 * when units were released — never on a dry run or a rolled-back transaction.
 */
export async function cancelUnpaidOrderInSet(tx: Tx, held: HeldLocks, input: CancelUnpaidInput): Promise<number> {
  const { storeId, orderId } = input;
  const byVariant = await heldUnits(tx, orderId);
  const released = [...byVariant.values()].reduce((a, b) => a + b, 0);
  if (!input.apply) return released;
  if (byVariant.size) {
    const variantIds = [...byVariant.keys()];
    const amounts = variantIds.map((id) => byVariant.get(id)!);
    // sql.param() is required (drizzle would otherwise expand the array into a
    // row expression): one array-valued parameter per column for unnest().
    await tx.execute(
      sql`UPDATE stock
          SET allocated = greatest(allocated - v.amount, 0)
          FROM (SELECT * FROM unnest(${sql.param(variantIds)}::uuid[], ${sql.param(amounts)}::int[]) AS t(variant_id, amount)) AS v
          WHERE stock.variant_id = v.variant_id AND stock.store_id = ${storeId}`,
    );
  }
  // D6: record the released units as cancelled on the line, so a later refund
  // of a paid-after-cancel order (MONEY-4) computes unfulfilled = 0.
  await tx.execute(
    sql`UPDATE order_line SET cancelled_qty = quantity - fulfilled_qty
        WHERE order_id = ${orderId} AND quantity - fulfilled_qty - cancelled_qty > 0`,
  );
  await tx.execute(sql`UPDATE "order" SET state = 'Cancelled', updated_at = now() WHERE id = ${orderId}`);
  // LOYALTY-1: a cancelled unpaid order gives its reserved points back.
  await releaseOrderLoyalty(tx, storeId, orderId, input.actor);
  // PAYMENT-TIMING §5.2 (R3/R4): the predicate already excludes unresolved provider work; the call records the proof.
  await release(tx, held, { storeId, orderId, reason: 'order_cancelled', stripeDiscoverable: input.stripeDiscoverable });
  await tx.insert(s.auditLog).values({
    storeId, actor: input.actor, entity: 'order', entityId: orderId,
    action: 'cancel', fromState: 'PendingPayment', toState: 'Cancelled', data: input.reason,
  });
  return released;
}
