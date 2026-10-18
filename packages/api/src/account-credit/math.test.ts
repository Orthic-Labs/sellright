import { describe, expect, it } from 'vitest';
import { availableCredit, equalAllocation, MAX_CREDIT_CENTS, normalizeCreditEmail, restorationAmount, validateAllocation } from './math.js';

describe('account credit exact monetary math', () => {
  it('quotes balance less other holds without mutating inputs, including unmapped historical holds', () => {
    const holds = [{ orderId: 'own', amount: 400 }, { orderId: 'other', amount: 300 }, { orderId: null, amount: 100 }];
    const original = structuredClone(holds);
    expect(availableCredit(1000, holds)).toBe(200);
    expect(availableCredit(1000, holds, 'own')).toBe(600);
    expect(holds).toEqual(original);
  });
  it('rejects unsafe cents and already-overcommitted balances', () => {
    expect(() => availableCredit(10, [{ orderId: 'other', amount: 11 }])).toThrow('Pending holds exceed balance');
    expect(() => availableCredit(MAX_CREDIT_CENTS + 1, [])).toThrow();
    expect(() => availableCredit(10, [{ orderId: null, amount: 0.5 }])).toThrow();
  });
  it('preserves uneven per-unit allocations over successive partial restores', () => {
    const allocation = { line: [34, 34, 33], zero: [0] };
    validateAllocation(allocation, [{ id: 'line', quantity: 3 }, { id: 'zero', quantity: 1 }], 101);
    expect(restorationAmount(allocation.line, 0, 1, 34)).toBe(34);
    expect(restorationAmount(allocation.line, 1, 1, 34)).toBe(34);
    expect(restorationAmount(allocation.line, 2, 1, 33)).toBe(33);
    expect(() => restorationAmount(allocation.line, 3, 1)).toThrow();
    expect(() => restorationAmount(allocation.line, 2, 1, 34)).toThrow('approved allocation');
  });
  it('requires exact line coverage, quantities, sum and nonnegative unit cents', () => {
    const lines = [{ id: 'line', quantity: 2 }];
    expect(() => validateAllocation({ line: [1] }, lines, 1)).toThrow();
    expect(() => validateAllocation({ line: [1, 1], extra: [] }, lines, 2)).toThrow();
    expect(() => validateAllocation({ line: [-1, 3] }, lines, 2)).toThrow();
    expect(() => validateAllocation({ line: [1, 1] }, lines, 3)).toThrow();
    expect(equalAllocation({ a: [1], b: [2] }, { b: [2], a: [1] })).toBe(true);
    expect(equalAllocation({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });
  it('normalizes issuance metadata without using it to authorize a code', () => {
    expect(normalizeCreditEmail('  Recipient@Example.com ')).toBe('recipient@example.com');
    expect(() => normalizeCreditEmail('missing-address')).toThrow();
  });
});
