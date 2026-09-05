import { describe, expect, it } from 'vitest';
import { selectSingleSettledPayment } from './refund-payment-selection.js';

describe('selectSingleSettledPayment', () => {
  it('returns none when there is no settled payment', () => {
    expect(selectSingleSettledPayment([])).toEqual({ kind: 'none' });
  });

  it('returns the only settled payment', () => {
    const payment = { id: 'p1', amount: 1000 };
    expect(selectSingleSettledPayment([payment])).toEqual({ kind: 'single', payment });
  });

  it('fails closed when allocation would be ambiguous', () => {
    expect(selectSingleSettledPayment([{ id: 'p1' }, { id: 'p2' }])).toEqual({ kind: 'multiple' });
  });
});
