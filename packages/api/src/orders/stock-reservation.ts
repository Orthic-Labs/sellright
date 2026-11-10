import { sql } from 'drizzle-orm';

export interface ReservableItem {
  sku: string;
  quantity: number;
}

export interface ReservableVariant {
  id: string;
  sku: string;
  enabled: boolean;
  isPreOrder: boolean;
  fulfillmentType?: string;
}

export class StockReservationError extends Error {
  constructor(public skus: string[]) {
    super(`unavailable or out of stock: ${skus.join(', ')}`);
  }
}

/** True when a variant takes part in stock allocation: enabled, not a pre-order, and physical. */
export function isStockReservable(v: Pick<ReservableVariant, 'enabled' | 'isPreOrder' | 'fulfillmentType'> | null | undefined): boolean {
  return !!v && v.enabled && !v.isPreOrder && (v.fulfillmentType ?? 'physical') === 'physical';
}

export function validateReservableItems(items: ReservableItem[], bySku: Map<string, ReservableVariant>): string[] {
  return items.flatMap((i) => {
    const v = bySku.get(i.sku);
    return v && v.enabled ? [] : [i.sku];
  });
}

export interface StockReservationResult {
  /** True when at least one `stock.allocated` row was updated (caller must call onStockChanged after commit). */
  changed: boolean;
  /**
   * #446: per input item (same index as `items`), true when the item is a backorder line: its quantity exceeded the
   * units that ship now (greatest(on_hand - allocated, 0)) read BEFORE this reservation, under the same row lock and
   * statement that allocated it (UPDATE ... RETURNING). false for non-reservable items (pre-order, digital).
   */
  backorder: boolean[];
}

type ReserveTx = { execute: (query: any) => PromiseLike<{ rowCount?: number | null; rows?: unknown[] }> };

/**
 * Atomically allocates stock for every physical, non-pre-order item, or
 * throws (rolling back any allocation already applied within the SAME
 * transaction) if any item can't be fully reserved.
 *
 * #446: the condition is the SELLABLE quantity, on_hand + incoming - allocated >= q (orders/availability.ts). `allocated`
 * may therefore exceed `on_hand`; the excess is the backordered quantity. Every release path only decrements `allocated`.
 *
 * `changed` is true when at least one `stock.allocated` row was actually
 * updated. Zero-cache stock rule: reservation changes what the catalog
 * manifest must report as available, so every caller MUST, after its OWN
 * surrounding transaction commits (never before — a reservation that gets
 * rolled back never happened), call
 * `onStockChanged(storeSlug)` from `../manifest/stock-hook.js`
 * when `changed` is `true`. This function itself must not call it: it runs
 * inside an open transaction that may still fail later in the same request
 * (checkout, admin order ops), and the manifest must never publish a stock
 * state that wasn't durably committed.
 */
export async function reserveStock(
  tx: ReserveTx,
  storeId: string,
  items: ReservableItem[],
  bySku: Map<string, ReservableVariant>,
): Promise<StockReservationResult> {
  const failed: string[] = [];
  let changed = false;
  const backorder: boolean[] = items.map(() => false);
  // B3/N12: one conditional UPDATE per row, issued in canonical variant order (lowercase uuid text = Postgres uuid
  // order; stable sort keeps caller order for duplicate SKUs), so concurrent reservations and every other stock
  // writer (db/locks.ts lockStockRowsInOrder) acquire stock row locks in the same order and cannot deadlock.
  const physical = items.flatMap((i, index) => {
    const v = bySku.get(i.sku);
    return v && isStockReservable(v) ? [{ i, v, index, key: v.id.toLowerCase() }] : [];
  }).sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const failedAt: number[] = [];
  for (const { i, v, index } of physical) {
    changed = true;
    // RETURNING sees the post-update row, so the pre-update allocated is `allocated - q`: backorder when q exceeds
    // greatest(on_hand - old_allocated, 0). Same statement, same row lock: no read-then-write gap.
    const res = await tx.execute(sql`
      UPDATE "stock" SET allocated = allocated + ${i.quantity}
      WHERE variant_id = ${v.id} AND store_id = ${storeId} AND (on_hand + incoming - allocated) >= ${i.quantity}
      RETURNING (${i.quantity}::int > greatest(on_hand - (allocated - ${i.quantity}::int), 0)) AS backorder`);
    if (res.rowCount !== 1) failedAt.push(index);
    else backorder[index] = (res.rows?.[0] as { backorder?: boolean } | undefined)?.backorder === true;
  }
  // Report in caller order, as before.
  for (const index of failedAt.sort((x, y) => x - y)) failed.push(items[index]!.sku);
  if (failed.length) throw new StockReservationError(failed);
  return { changed, backorder };
}

/** Boolean-returning form kept for callers that only need the `changed` flag (see reserveStock). */
export async function reserveStockOrThrow(tx: ReserveTx, storeId: string, items: ReservableItem[], bySku: Map<string, ReservableVariant>): Promise<boolean> {
  return (await reserveStock(tx, storeId, items, bySku)).changed;
}
