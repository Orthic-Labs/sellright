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

function linePrices(input: VendureLineSnapshotInput) {
  const quantity = Math.max(0, Math.trunc(input.quantity));
  const placedQuantity = Math.max(quantity, Math.trunc(input.orderPlacedQuantity || 0));
  const taxRate = input.taxLines.reduce((sum, line) => sum + num(line.taxRate), 0);

  let adjustmentPerUnit = 0;
  if (quantity > 0) {
    for (const adjustment of input.adjustments) {
      // Vendure 3.7.3 OrderLine.getUnitAdjustmentsTotal applies this same
      // divisor to every adjustment type, including item-level PROMOTION.
      adjustmentPerUnit += num(adjustment.amount) / placedQuantity;
    }
  }

  const adjustedListPrice = input.listPrice + adjustmentPerUnit;
  const unitNet = input.listPriceIncludesTax ? netPriceOf(input.listPrice, taxRate) : input.listPrice;
  const proratedUnitNet = input.listPriceIncludesTax ? netPriceOf(adjustedListPrice, taxRate) : adjustedListPrice;
  const proratedUnitGross = input.listPriceIncludesTax ? adjustedListPrice : grossPriceOf(adjustedListPrice, taxRate);

  return { quantity, unitNet, proratedUnitNet, proratedUnitGross };
}

/**
 * Reproduce Vendure's DefaultMoneyStrategy line projections from persisted
 * `order_line` fields. Line totals round the unrounded prorated unit × current
 * quantity. Cash refunds instead multiply the independently rounded
 * proratedUnitPriceWithTax by refunded quantity; see the separate helper below.
 */
export function vendureLineMoney(input: VendureLineSnapshotInput): ImportedLineMoney {
  const { quantity, unitNet, proratedUnitNet, proratedUnitGross } = linePrices(input);

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

/**
 * Vendure OrderLine.proratedUnitPriceWithTax, rounded before refund quantity
 * multiplication. PaymentService.getRefundAmount includes this basis only for
 * lines with positive orderPlacedQuantity; the caller owns that eligibility test.
 * This is cash-refund math, separate from exact account-credit unit allocations.
 */
export function vendureProratedUnitPriceWithTax(input: VendureLineSnapshotInput): number {
  return Math.round(linePrices(input).proratedUnitGross);
}
