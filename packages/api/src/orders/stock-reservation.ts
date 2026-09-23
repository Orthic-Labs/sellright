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

export function validateReservableItems(items: ReservableItem[], bySku: Map<string, ReservableVariant>): string[] {
  return items.flatMap((i) => {
    const v = bySku.get(i.sku);
    return v && v.enabled ? [] : [i.sku];
  });
}

/**
 * Atomically allocates stock for every physical, non-pre-order item, or
 * throws (rolling back any allocation already applied within the SAME
 * transaction) if any item can't be fully reserved.
 *
 * Returns `true` when at least one `stock.allocated` row was actually
 * updated. Zero-cache stock rule: reservation changes what the catalog
 * manifest must report as available, so every caller MUST, after its OWN
 * surrounding transaction commits (never before — a reservation that gets
 * rolled back never happened), call
 * `onStockChanged(storeSlug)` from `../manifest/stock-hook.js`
 * when this returns `true`. This function itself must not call it: it runs
 * inside an open transaction that may still fail later in the same request
 * (checkout, admin order ops), and the manifest must never publish a stock
 * state that wasn't durably committed.
 */
export async function reserveStockOrThrow(
  tx: { execute: (query: any) => PromiseLike<{ rowCount?: number | null }> },
  storeId: string,
  items: ReservableItem[],
  bySku: Map<string, ReservableVariant>,
): Promise<boolean> {
  const failed: string[] = [];
  let changed = false;
  for (const i of items) {
    const v = bySku.get(i.sku);
    if (!v || !v.enabled || v.isPreOrder || (v.fulfillmentType ?? 'physical') !== 'physical') continue;
    changed = true;
    const res = await tx.execute(sql`
      UPDATE "stock" SET allocated = allocated + ${i.quantity}
      WHERE variant_id = ${v.id} AND store_id = ${storeId} AND (on_hand - allocated) >= ${i.quantity}`);
    if (res.rowCount !== 1) failed.push(i.sku);
  }
  if (failed.length) throw new StockReservationError(failed);
  return changed;
}
