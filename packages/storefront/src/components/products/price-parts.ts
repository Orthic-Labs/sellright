// Pure price selection for Price.tsx (unit-tested without rendering).
/**
 * The price to show (cents): the pre-order price when it applies, else the sale price, else the regular one; the struck-through
 * regular price when an override differs from it; and the range maximum, only for the plain price (no applicable pre-order or sale
 * price, even one equal to the minimum) when `maxPrice` exceeds it.
 */
export function priceParts(input: { regularCents: number | null; salePrice?: number | null; preOrderPrice?: number | null; isPreOrder?: boolean; maxPrice?: number | null }): { liveCents: number | null; strikeCents: number | null; rangeMaxCents: number | null } {
  const { regularCents, isPreOrder } = input;
  const sale = typeof input.salePrice === 'number' && input.salePrice > 0 ? input.salePrice : null;
  const pre = typeof input.preOrderPrice === 'number' && input.preOrderPrice > 0 ? input.preOrderPrice : null;
  let liveCents: number | null = regularCents;
  let strikeCents: number | null = null;
  const overrideApplies = (isPreOrder && pre !== null) || (!isPreOrder && sale !== null);
  if (isPreOrder && pre) {
    liveCents = pre;
    if (regularCents !== null && regularCents !== pre) strikeCents = regularCents;
  } else if (!isPreOrder && sale) {
    liveCents = sale;
    if (regularCents !== null && regularCents !== sale) strikeCents = regularCents;
  }
  const rangeMaxCents = !overrideApplies && liveCents !== null && typeof input.maxPrice === 'number' && input.maxPrice > liveCents ? input.maxPrice : null;
  return { liveCents, strikeCents, rangeMaxCents };
}
