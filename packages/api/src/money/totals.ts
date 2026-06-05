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

export function calculateOrderTotals(input: TotalsInput): OrderTotals {
  const promo = input.promotion ?? null;
  const pct = promo?.type === 'percentage' ? promo.value : 0;

  const lines: LineTotals[] = input.lines.map((l) => {
    const lineSubtotal = l.unitPrice * l.quantity;
    // Line-level rounding for percentage discounts (locked rulebook §6).
    const lineDiscount = pct > 0 ? roundHalfUp((lineSubtotal * pct) / 100) : 0;
    return { unitPrice: l.unitPrice, quantity: l.quantity, lineSubtotal, lineDiscount, lineTotal: lineSubtotal - lineDiscount };
  });

  const subtotal = lines.reduce((a, l) => a + l.lineSubtotal, 0);
  let discountTotal = lines.reduce((a, l) => a + l.lineDiscount, 0);
  if (promo?.type === 'fixed') discountTotal = Math.min(promo.value, subtotal); // capped at subtotal

  const discountedSubtotal = subtotal - discountTotal;
  const shippingTotal = promo?.type === 'free_shipping' ? 0 : input.shipping;
  const taxTotal = input.taxRate > 0 ? roundHalfUp((discountedSubtotal * input.taxRate) / 10000) : 0;
  const grandTotal = discountedSubtotal + shippingTotal + taxTotal;

  return { lines, subtotal, discountTotal, shippingTotal, taxTotal, grandTotal };
}
