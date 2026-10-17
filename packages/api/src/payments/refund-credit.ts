import { readOrderPricingSnapshot } from '../money/pricing-snapshot.js';
import { vendureProratedUnitPriceWithTax } from '../import/vendure-money.js';
import { restorationAmount, MAX_CREDIT_CENTS } from '../account-credit/math.js';

export type RefundMoneyLine = { id: string; quantity: number; unitPrice: number; lineTotal: number; metadata?: unknown };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const cents = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_CREDIT_CENTS;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A validated current snapshot governs every line, including imported lines.
 * Only legacy orders without snapshots use retained source unit authority.
 * Null is the existing legacy generic refund basis, never a credit unit proof. */
export function refundUnitBases(order: { currency: string; pricingSnapshot: unknown }, lines: RefundMoneyLine[]): Map<string, number | null> {
  const snapshot = readOrderPricingSnapshot(order.pricingSnapshot, { currency: order.currency, orderLines: lines, mode: 'refund' });
  if (snapshot) return new Map(snapshot.lines.map(line => [line.orderLineId, line.proratedUnitPriceWithTax]));
  return new Map(lines.map(line => {
    const raw = object(line.metadata) ? line.metadata.vendure : undefined;
    if (raw !== undefined) {
      if (!object(raw) || !cents(raw.quantity) || !cents(raw.placedQuantity) || !cents(raw.listPrice) ||
          typeof raw.listPriceIncludesTax !== 'boolean' || !Array.isArray(raw.adjustments) || !Array.isArray(raw.taxLines) ||
          !raw.adjustments.every(a => object(a) && finite(a.amount)) || !raw.taxLines.every(t => object(t) && finite(t.taxRate) && t.taxRate >= 0)) {
        throw new Error('Imported refund unit requires complete source money facts');
      }
      const unit = raw.placedQuantity > 0 ? vendureProratedUnitPriceWithTax({ quantity: raw.quantity,
        orderPlacedQuantity: raw.placedQuantity, listPrice: raw.listPrice, listPriceIncludesTax: raw.listPriceIncludesTax,
        adjustments: raw.adjustments, taxLines: raw.taxLines }) : 0;
      if (!cents(unit)) throw new Error('Imported refund unit is outside integer cents');
      return [line.id, unit] as const;
    }
    return [line.id, null] as const;
  }));
}

export function refundLineCashAmount(line: RefundMoneyLine, quantity: number, unit: number | null, creditBearing: boolean): number {
  if (unit === null && creditBearing) throw new Error('Credit merchandise requires a proven refund unit');
  // Preserve legacy non-credit orders; new native & imported orders never use this fallback.
  const amount = unit === null ? Math.round((line.quantity ? line.lineTotal / line.quantity : line.unitPrice) * quantity) : unit * quantity;
  if (!cents(amount)) throw new Error('Refund line amount is outside integer cents');
  return amount;
}

type Redemption = { id: string; accountCreditId: string; amount: number; delta: number; operationalAllocation: Record<string, number[]> | null };
type Restoration = { accountCreditId: string; relatedTransactionId: string | null; orderLineId: string | null; quantity: number | null; amount: number; delta: number };
/** Zero cash is merchandise accounting authority only after every selected link
 * & the already-consumed prefix of the immutable REDEEM vector are proven. */
export function proveCreditMerchandiseReturn(redeem: Redemption | undefined, restored: Restoration[], selected: Array<{ orderLineId: string; quantity: number }>): { redemptionId: string; accountId: string } {
  if (!redeem || !cents(redeem.amount) || redeem.amount < 1 || redeem.delta !== -redeem.amount ||
      !object(redeem.operationalAllocation) || selected.length === 0 || new Set(selected.map(l => l.orderLineId)).size !== selected.length) {
    throw new Error('Posted credit redemption with selected merchandise links required');
  }
  const quantities = new Map<string, number>(), amounts = new Map<string, number>();
  let restoredTotal = 0;
  for (const row of restored) {
    if (row.accountCreditId !== redeem.accountCreditId || row.relatedTransactionId !== redeem.id || !row.orderLineId ||
        !Number.isSafeInteger(row.quantity) || row.quantity! < 1 || !cents(row.amount) || row.delta !== row.amount) {
      throw new Error('Historical restoration requires proven unit linkage');
    }
    quantities.set(row.orderLineId, (quantities.get(row.orderLineId) ?? 0) + row.quantity!);
    amounts.set(row.orderLineId, (amounts.get(row.orderLineId) ?? 0) + row.amount);
    restoredTotal += row.amount;
  }
  for (const [id, quantity] of quantities) {
    const units = Object.hasOwn(redeem.operationalAllocation, id) ? redeem.operationalAllocation[id] : undefined;
    if (!units || restorationAmount(units, 0, quantity) !== amounts.get(id)) throw new Error('Restored credit differs from frozen unit prefix');
  }
  let next = 0;
  for (const line of selected) {
    const units = Object.hasOwn(redeem.operationalAllocation, line.orderLineId) ? redeem.operationalAllocation[line.orderLineId] : undefined;
    if (!units) throw new Error('Selected merchandise lacks proven credit allocation');
    next += restorationAmount(units, quantities.get(line.orderLineId) ?? 0, line.quantity);
  }
  if (!cents(restoredTotal) || !cents(next) || restoredTotal + next > redeem.amount) throw new Error('Restoration exceeds posted credit');
  return { redemptionId: redeem.id, accountId: redeem.accountCreditId };
}

export type RefundCreditRestoration = { state: 'posted' | 'not_applicable' | 'reconciliation_required'; amount: number; errorCode?: string };
export function refundCreditProjection(metadata: unknown): RefundCreditRestoration | null {
  const value = object(metadata) ? metadata.creditRestoration : undefined;
  if (!object(value) || !['posted', 'not_applicable', 'reconciliation_required'].includes(String(value.state)) || !cents(value.amount)) return null;
  return { state: value.state as RefundCreditRestoration['state'], amount: value.amount,
    ...(typeof value.errorCode === 'string' && /^[a-z_]{1,64}$/.test(value.errorCode) ? { errorCode: value.errorCode } : {}) };
}
