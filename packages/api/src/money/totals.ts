/**
 * The money core (rulebook §1–9): one canonical, PURE totals function. No I/O.
 * All amounts are integer cents. Rounding is LINE-LEVEL (locked decision).
 *   subtotal − discount + tax + shipping = grand total.
 */
export interface CartLineInput {
  unitPrice: number; // cents (already price-selected: sale/preorder/base)
  quantity: number;
}

export interface Promotion {
  type: 'percentage' | 'fixed' | 'free_shipping';
  value: number; // percentage: 0–100; fixed: cents; free_shipping: ignored
}

export interface TotalsInput {
  lines: CartLineInput[];
  shipping: number; // cents
  taxRate: number; // basis points (875 = 8.75%); 0 = no tax
  shippingTaxable?: boolean;
  taxInclusive?: boolean; // true = line/shipping prices already include tax (extract, don't add)
  promotion?: Promotion | null;
}

export interface LineTotals {
  unitPrice: number;
  quantity: number;
  lineSubtotal: number;
  lineDiscount: number;
  lineTotal: number;
}

export interface OrderTotals {
  lines: LineTotals[];
  subtotal: number;
  discountTotal: number;
  shippingTotal: number;
  taxTotal: number;
  grandTotal: number;
}

const roundHalfUp = (n: number): number => Math.round(n);

/** Distribute `target` cents across `weights` using the largest-remainder method
 *  so the sum is exactly `target` and each share is proportional. Used for
 *  fixed-amount discounts across lines (WP9.1). Empty weights -> all zeros. */
function distributeLargestRemainder(target: number, weights: number[]): number[] {
  if (target <= 0 || weights.length === 0) return weights.map(() => 0);
  const total = weights.reduce((a, w) => a + w, 0);
  if (total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (w / total) * target);
  const floored = raw.map((x) => Math.floor(x));
  let remainder = target - floored.reduce((a, x) => a + x, 0);
  // Assign leftover cents to the lines with the largest fractional parts first
  // (deterministic tie-break by original index). Capped at floor + 1 per line.
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < order.length && remainder > 0; k++) {
    floored[order[k]!.i]! += 1;
    remainder--;
  }
  return floored;
}

export function calculateOrderTotals(input: TotalsInput): OrderTotals {
  const promo = input.promotion ?? null;
  // Defensive clamp: percentage should already be validated 0–100 at the admin
  // API boundary (admin-marketing.ts), but a pre-existing bad DB row must never
  // be able to drive a negative order total here.
  const pct = promo?.type === 'percentage' ? Math.min(100, Math.max(0, promo.value)) : 0;

  // Compute line subtotals first (needed for both pct and fixed-distribution math).
  const lineSubtotals = input.lines.map((l) => l.unitPrice * l.quantity);
  const subtotalBefore = lineSubtotals.reduce((a, x) => a + x, 0);

  let perLineDiscount: number[] = input.lines.map(() => 0);
  if (promo?.type === 'percentage' && pct > 0) {
    // Line-level rounding for percentage discounts (locked rulebook §6).
    perLineDiscount = lineSubtotals.map((s) => roundHalfUp((s * pct) / 100));
  } else if (promo?.type === 'fixed') {
    const target = Math.min(promo.value, subtotalBefore); // capped at subtotal
    perLineDiscount = distributeLargestRemainder(target, lineSubtotals);
  }

  const lines: LineTotals[] = input.lines.map((l, i) => {
    const lineSubtotal = lineSubtotals[i]!;
    const lineDiscount = perLineDiscount[i]!;
    return { unitPrice: l.unitPrice, quantity: l.quantity, lineSubtotal, lineDiscount, lineTotal: lineSubtotal - lineDiscount };
  });

  const subtotal = subtotalBefore;
  const discountTotal = lines.reduce((a, l) => a + l.lineDiscount, 0);

  const discountedSubtotal = subtotal - discountTotal;
  const shippingTotal = promo?.type === 'free_shipping' ? 0 : input.shipping;
  const taxableShipping = input.shippingTaxable ? shippingTotal : 0;
  const taxableBase = discountedSubtotal + taxableShipping;
  // Inclusive: the tax is already inside taxableBase — extract it (don't add).
  // Exclusive (default): tax is added on top.
  let taxTotal = 0;
  if (input.taxRate > 0) {
    taxTotal = input.taxInclusive
      ? taxableBase - roundHalfUp((taxableBase * 10000) / (10000 + input.taxRate))
      : roundHalfUp((taxableBase * input.taxRate) / 10000);
  }
  const grandTotalRaw = input.taxInclusive ? discountedSubtotal + shippingTotal : discountedSubtotal + shippingTotal + taxTotal;
  // Final floor: grandTotal must never be negative, no matter what upstream
  // discount/tax inputs produced it.
  const grandTotal = Math.max(0, grandTotalRaw);

  return { lines, subtotal, discountTotal, shippingTotal, taxTotal, grandTotal };
}
