import { describe, expect, it } from 'vitest';
import { classifyPromotionActions } from './catalog.js';
import { mapCreditsToPoints } from './loyalty.js';

describe('importer: promotion action classification', () => {
  const a = (code: string) => ({ code, args: [] });
  it('keeps single-action promotions', () => {
    expect(classifyPromotionActions([a('order_percentage_discount')])).toBe('single');
    expect(classifyPromotionActions([a('free_shipping')])).toBe('single');
  });
  it('flags the legacy store-credit action for exclusion', () => {
    expect(classifyPromotionActions([a('account_credit_discount')])).toBe('account_credit');
    expect(classifyPromotionActions([a('order_fixed_discount'), a('account_credit_discount')])).toBe('account_credit');
  });
  it('flags discount + free shipping as multi-action', () => {
    expect(classifyPromotionActions([a('order_percentage_discount'), a('free_shipping')])).toBe('multi_action');
    expect(classifyPromotionActions([a('free_shipping'), a('order_fixed_discount')])).toBe('multi_action');
  });
  it('leaves anything else unsupported (still a hard failure upstream)', () => {
    expect(classifyPromotionActions([a('order_percentage_discount'), a('order_fixed_discount')])).toBe('unsupported');
    expect(classifyPromotionActions([])).toBe('unsupported');
  });
});

describe('importer: store credit → points', () => {
  const customers = new Map([['a@example.com', 'cust-a'], ['b@example.com', 'cust-b']]);
  it('converts remaining cents at the target rate, rounding up', () => {
    const { entries, skipped } = mapCreditsToPoints([
      { id: 1, email: 'A@Example.com', currency: 'USD', balance: 2500, disabled: false },
      { id: 2, email: 'b@example.com', currency: 'USD', balance: '101', disabled: false },
    ], { currency: 'USD', pointsPerDollarOff: 50, customerByEmail: customers });
    expect(entries).toEqual([
      { sourceId: '1', customerId: 'cust-a', points: 1250, cents: 2500 },
      { sourceId: '2', customerId: 'cust-b', points: 51, cents: 101 },
    ]);
    expect(skipped).toEqual({ disabled: 0, zero: 0, currency: 0, noCustomer: 0 });
  });
  it('counts every skipped row by reason', () => {
    const { entries, skipped } = mapCreditsToPoints([
      { id: 1, email: 'a@example.com', currency: 'USD', balance: 100, disabled: true },
      { id: 2, email: 'a@example.com', currency: 'USD', balance: 0, disabled: false },
      { id: 3, email: 'a@example.com', currency: 'EUR', balance: 100, disabled: false },
      { id: 4, email: 'nobody@example.com', currency: 'USD', balance: 100, disabled: false },
    ], { currency: 'USD', pointsPerDollarOff: 100, customerByEmail: customers });
    expect(entries).toEqual([]);
    expect(skipped).toEqual({ disabled: 1, zero: 1, currency: 1, noCustomer: 1 });
  });
});
