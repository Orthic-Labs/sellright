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

export async function reserveStockOrThrow(
  tx: { execute: (query: any) => PromiseLike<{ rowCount?: number | null }> },
  storeId: string,
  items: ReservableItem[],
  bySku: Map<string, ReservableVariant>,
): Promise<void> {
  const failed: string[] = [];
  for (const i of items) {
    const v = bySku.get(i.sku);
    if (!v || !v.enabled || v.isPreOrder || (v.fulfillmentType ?? 'physical') !== 'physical') continue;
    const res = await tx.execute(sql`
      UPDATE "stock" SET allocated = allocated + ${i.quantity}
      WHERE variant_id = ${v.id} AND store_id = ${storeId} AND (on_hand - allocated) >= ${i.quantity}`);
    if (res.rowCount !== 1) failed.push(i.sku);
  }
  if (failed.length) throw new StockReservationError(failed);
}
