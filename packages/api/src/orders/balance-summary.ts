/**
 * Customer-safe summary of the latest order edit, for the balance pay page
 * (GET /v1/shop/orders/{code} -> balanceDue). Built only from the edit's
 * before/after snapshots: line quantity/price changes and total movement.
 * Never includes the operator's reason, actor or settlement record.
 */
type SnapLine = { sku?: string; name?: string; quantity?: number; lineTotal?: number };
type Snap = { totals?: { grandTotal?: number }; lines?: SnapLine[] };

export interface BalanceSummary {
  previousGrandTotal: number | null;
  changes: string[];
  editedAt: string | null;
}

export function summarizeEdit(before: unknown, after: unknown, editedAt: Date | null): BalanceSummary {
  const b = (before ?? {}) as Snap, a = (after ?? {}) as Snap;
  const bl = new Map((b.lines ?? []).map((l) => [l.sku ?? '', l]));
  const al = new Map((a.lines ?? []).map((l) => [l.sku ?? '', l]));
  const changes: string[] = [];
  for (const [sku, l] of al) {
    const prev = bl.get(sku);
    if (!l.quantity) continue;
    if (!prev || !prev.quantity) changes.push(`Added ${l.quantity} × ${l.name ?? sku}`);
    else if (prev.quantity !== l.quantity) changes.push(`${l.name ?? sku}: quantity ${prev.quantity} → ${l.quantity}`);
  }
  for (const [sku, l] of bl) {
    if (!l.quantity) continue;
    const next = al.get(sku);
    if (!next || !next.quantity) changes.push(`Removed ${l.name ?? sku}`);
  }
  return { previousGrandTotal: b.totals?.grandTotal ?? null, changes, editedAt: editedAt ? editedAt.toISOString() : null };
}
