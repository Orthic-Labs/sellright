import { describe, expect, it } from 'vitest';
import { refundAvailableUnits, refundCashForQuantity, refundCashForRemainingLines } from './api';

const legacy = { quantity: 4, refundedQty: 1, refundUnitPrice: 25 };
const exact = { ...legacy, refundAvailableQuantity: 3, refundCashAmounts: [0, 24, 49], refundUnitPrice: null };

describe('refund cash proof', () => {
  it('uses cumulative available-unit amounts, including proven zero', () => {
    expect(refundCashForQuantity(exact, 1)).toBe(0);
    expect(refundCashForQuantity(exact, 2)).toBe(24);
    expect(refundCashForQuantity(exact, 3)).toBe(49);
    expect(refundAvailableUnits(exact)).toBe(3);
  });

  it.each([null, undefined, [], [0, 24], [0, 24, 49, 74], [0, 24, 23], [-1, 24, 49], [0, 24.5, 49], [0, NaN, 49], [0, Infinity, 49], [0, , 49]].map(amounts => ({ amounts })))('refuses malformed explicit vectors without scalar fallback: $amounts', ({ amounts }) => {
    expect(refundCashForQuantity({ ...exact, refundUnitPrice: 25, refundCashAmounts: amounts as number[] | null }, 1)).toBeNull();
  });

  it.each([0, -1, 1.5, 4, NaN, Infinity])('refuses invalid quantity %s', (quantity) => {
    expect(refundCashForQuantity(exact, quantity)).toBeNull();
  });

  it('retains valid legacy scalars without inferring missing prices', () => {
    expect(refundCashForQuantity(legacy, 2)).toBe(50);
    expect(refundCashForQuantity({ ...legacy, refundUnitPrice: 0 }, 2)).toBe(0);
    expect(refundCashForQuantity({ ...legacy, refundUnitPrice: null }, 2)).toBeNull();
    expect(refundCashForQuantity({ quantity: 4, refundedQty: 1 }, 2)).toBeNull();
    expect(refundCashForQuantity({ ...legacy, refundUnitPrice: Number.MAX_SAFE_INTEGER }, 2)).toBeNull();
  });

  it('trusts explicit availability once & rejects malformed availability', () => {
    expect(refundAvailableUnits(legacy)).toBe(3);
    expect(refundAvailableUnits({ ...exact, refundedQty: 3 })).toBe(3);
    expect(refundCashForQuantity({ ...exact, refundAvailableQuantity: 0, refundCashAmounts: [] }, 1)).toBeNull();
    expect(refundAvailableUnits({ ...exact, refundAvailableQuantity: 1.5 })).toBeNull();
    expect(refundCashForQuantity({ ...exact, refundAvailableQuantity: -1 }, 1)).toBeNull();
  });

  it('proves legitimate blank full-remaining refunds across every available line', () => {
    expect(refundCashForRemainingLines([exact, legacy])).toBe(124);
    expect(refundCashForRemainingLines([{ ...exact, refundAvailableQuantity: 0, refundCashAmounts: [] }])).toBe(0);
    expect(refundCashForRemainingLines([{ quantity: 1, refundedQty: 1 }])).toBe(0);
  });

  it.each([null, undefined, [], [0, 24], [0, 24, 23], [0, NaN, 49], [0, , 49]].map(amounts => ({ amounts })))('blocks blank full-remaining refunds when any line has malformed proof: $amounts', ({ amounts }) => {
    expect(refundCashForRemainingLines([legacy, { ...exact, refundCashAmounts: amounts as number[] | null }])).toBeNull();
  });

  it('blocks blank full-remaining refunds when failed proof hides a line with zero availability', () => {
    expect(refundCashForRemainingLines([legacy, { ...exact, refundAvailableQuantity: 0, refundCashAmounts: null }])).toBeNull();
    expect(refundCashForRemainingLines([{ ...exact, refundAvailableQuantity: 0, refundCashAmounts: [0] }])).toBeNull();
    expect(refundCashForRemainingLines([{ ...legacy, refundUnitPrice: null }])).toBeNull();
  });
});
