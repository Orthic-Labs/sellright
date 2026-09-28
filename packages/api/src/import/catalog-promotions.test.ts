import { describe, expect, it } from 'vitest';
import { actionToTypeValue, classifyPromotionActions } from './catalog.js';

describe('R24 — combined discount + free-shipping promotion import', () => {
  it('classifies a single discount action as single', () => {
    expect(classifyPromotionActions([{ code: 'order_percentage_discount', args: [] }])).toBe('single');
  });

  it('classifies discount + free_shipping as multi_action', () => {
    expect(classifyPromotionActions([
      { code: 'order_percentage_discount', args: [] },
      { code: 'free_shipping', args: [] },
    ])).toBe('multi_action');
  });

  it('classifies account_credit_discount as account_credit regardless of other actions', () => {
    expect(classifyPromotionActions([{ code: 'account_credit_discount', args: [] }])).toBe('account_credit');
  });

  it('classifies anything else with >1 action as unsupported', () => {
    expect(classifyPromotionActions([
      { code: 'order_percentage_discount', args: [] },
      { code: 'order_fixed_discount', args: [] },
    ])).toBe('unsupported');
  });

  it('actionToTypeValue picks the discount action + sets freeShipping when combined', () => {
    const tv = actionToTypeValue([
      { code: 'order_percentage_discount', args: [{ name: 'discount', value: '15' }] },
      { code: 'free_shipping', args: [] },
    ]);
    expect(tv).toEqual({ type: 'percentage', value: 15, freeShipping: true });
  });

  it('actionToTypeValue leaves freeShipping false for a plain fixed discount', () => {
    const tv = actionToTypeValue([{ code: 'order_fixed_discount', args: [{ name: 'amount', value: '500' }] }]);
    expect(tv).toEqual({ type: 'fixed', value: 500, freeShipping: false });
  });

  it('actionToTypeValue on a bare free_shipping action: type free_shipping, freeShipping false (redundant field, type already covers it)', () => {
    const tv = actionToTypeValue([{ code: 'free_shipping', args: [] }]);
    expect(tv).toEqual({ type: 'free_shipping', value: 0, freeShipping: false });
  });

  it('actionToTypeValue returns null for an empty action list', () => {
    expect(actionToTypeValue([])).toBeNull();
  });
});
