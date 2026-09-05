type VendureAdjustment = { amount?: unknown; type?: unknown };
type VendureTaxLine = { taxRate?: unknown };

export type VendureLineSnapshotInput = {
  quantity: number;
  orderPlacedQuantity: number;
  listPrice: number;
  listPriceIncludesTax: boolean;
  adjustments: VendureAdjustment[];
  taxLines: VendureTaxLine[];
};

export type ImportedLineMoney = {
  unitPrice: number;
  lineSubtotal: number;
  lineDiscount: number;
  lineTax: number;
  lineTotal: number;
};

const num = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const netPriceOf = (gross: number, taxRate: number): number => gross / ((100 + taxRate) / 100);
const grossPriceOf = (net: number, taxRate: number): number => net * ((100 + taxRate) / 100);

/**
 * Reproduce Vendure's DefaultMoneyStrategy order-line economics from the fields
 * persisted on `order_line`. In Vendure, proratedLinePriceWithTax is the true
 * economic line value used for refunds: item promotions and distributed order
 * promotions are both represented in `adjustments` and tax in `taxLines`.
 *
 * This intentionally mirrors Vendure's Math.round(value * quantity) behavior.
 */
export function vendureLineMoney(input: VendureLineSnapshotInput): ImportedLineMoney {
  const quantity = Math.max(0, Math.trunc(input.quantity));
  const placedQuantity = Math.max(quantity, Math.trunc(input.orderPlacedQuantity || quantity));
  const taxRate = input.taxLines.reduce((sum, line) => sum + num(line.taxRate), 0);

  let adjustmentPerUnit = 0;
  if (quantity > 0) {
    for (const adjustment of input.adjustments) {
      const type = String(adjustment.type ?? '');
      const basis = type === 'PROMOTION' ? quantity : Math.max(1, placedQuantity);
      adjustmentPerUnit += num(adjustment.amount) / basis;
    }
  }

  const adjustedListPrice = input.listPrice + adjustmentPerUnit;
  const unitNet = input.listPriceIncludesTax ? netPriceOf(input.listPrice, taxRate) : input.listPrice;
  const proratedUnitNet = input.listPriceIncludesTax ? netPriceOf(adjustedListPrice, taxRate) : adjustedListPrice;
  const proratedUnitGross = input.listPriceIncludesTax ? adjustedListPrice : grossPriceOf(adjustedListPrice, taxRate);

  const unitPrice = Math.round(unitNet);
  const lineSubtotal = Math.round(unitNet * quantity);
  const proratedLineNet = Math.round(proratedUnitNet * quantity);
  const lineTotal = Math.round(proratedUnitGross * quantity);
  const lineTax = lineTotal - proratedLineNet;
  // Keep the exact accounting identity even for unusual positive adjustments:
  // subtotal - discount + tax === lineTotal. A positive surcharge therefore
  // appears as a negative discount rather than silently losing money.
  const lineDiscount = lineSubtotal - proratedLineNet;

  return { unitPrice, lineSubtotal, lineDiscount, lineTax, lineTotal };
}
