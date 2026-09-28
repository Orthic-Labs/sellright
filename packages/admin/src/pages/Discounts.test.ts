// Pure-function coverage for the discount-scope condition builder (admin-
// essentials). These mirror the exact condition shape money/coupon.ts's
// evaluateCoupon() already reads on the API side — no new vocabulary is
// invented in the admin UI, only surfaced (see Discounts.tsx's header
// comment). Round-tripping buildConditions() -> readCondition() is the
// contract that makes the edit form pre-fill correctly from a saved
// promotion.
import { describe, expect, it } from 'vitest';
import { buildConditions, buildPayload, readCondition, toLocalInput, fromLocalInput, type FormState } from './Discounts.js';

function baseForm(overrides: Partial<FormState> = {}): FormState {
  return {
    id: null, code: 'SAVE10', type: 'percentage', value: '10',
    usageLimit: '', perCustomerUsageLimit: '', startsAt: '', endsAt: '',
    minOrderAmount: '', facetIds: '', facetMinimum: '1', enabled: true,
    ...overrides,
  };
}

describe('buildConditions', () => {
  it('emits no conditions for a plain discount with no minimum/scope', () => {
    expect(buildConditions(baseForm())).toBeNull();
  });

  it('emits a minimum_order_amount condition in cents', () => {
    const conds = buildConditions(baseForm({ minOrderAmount: '25.50' })) as Array<{ code: string; args: { name: string; value: string }[] }>;
    expect(conds).toHaveLength(1);
    expect(conds[0]).toMatchObject({ code: 'minimum_order_amount' });
    expect(conds[0]!.args).toEqual([{ name: 'amount', value: '2550' }]);
  });

  it('emits an at_least_n_with_facets condition from comma-separated facet ids', () => {
    const conds = buildConditions(baseForm({ facetIds: ' fa1 , fa2,fa3 ', facetMinimum: '2' })) as Array<{ code: string; args: { name: string; value: string }[] }>;
    expect(conds).toHaveLength(1);
    const c = conds[0]!;
    expect(c.code).toBe('at_least_n_with_facets');
    const facets = JSON.parse(c.args.find((a) => a.name === 'facets')!.value);
    expect(facets).toEqual(['fa1', 'fa2', 'fa3']);
    expect(c.args.find((a) => a.name === 'minimum')!.value).toBe('2');
  });

  it('combines a minimum-order condition AND a facet-scope condition', () => {
    const conds = buildConditions(baseForm({ minOrderAmount: '10', facetIds: 'fa1' })) as Array<{ code: string }>;
    expect(conds.map((c) => c.code)).toEqual(['minimum_order_amount', 'at_least_n_with_facets']);
  });

  it('ignores a zero or blank minimum order amount (no phantom condition)', () => {
    expect(buildConditions(baseForm({ minOrderAmount: '0' }))).toBeNull();
    expect(buildConditions(baseForm({ minOrderAmount: '   ' }))).toBeNull();
  });
});

describe('readCondition — round-trips buildConditions() output', () => {
  it('reads back the minimum_order_amount amount', () => {
    const conds = buildConditions(baseForm({ minOrderAmount: '25.50' }));
    expect(readCondition(conds, 'minimum_order_amount')).toEqual({ amount: '2550' });
  });

  it('reads back the facet scope + minimum', () => {
    const conds = buildConditions(baseForm({ facetIds: 'fa1,fa2', facetMinimum: '3' }));
    const read = readCondition(conds, 'at_least_n_with_facets');
    expect(JSON.parse(read.facets!)).toEqual(['fa1', 'fa2']);
    expect(read.minimum).toBe('3');
  });

  it('returns {} for a condition code that is not present', () => {
    expect(readCondition(null, 'minimum_order_amount')).toEqual({});
    expect(readCondition([{ code: 'other' }], 'minimum_order_amount')).toEqual({});
  });
});

describe('buildPayload', () => {
  it('converts a percentage value to a plain integer percent (not cents)', () => {
    expect(buildPayload(baseForm({ type: 'percentage', value: '15' })).value).toBe(15);
  });

  it('converts a fixed-amount value to cents', () => {
    expect(buildPayload(baseForm({ type: 'fixed', value: '9.99' })).value).toBe(999);
  });

  it('forces free_shipping value to 0 regardless of the value field', () => {
    expect(buildPayload(baseForm({ type: 'free_shipping', value: '999' })).value).toBe(0);
  });

  it('an empty code becomes null (automatic discount)', () => {
    expect(buildPayload(baseForm({ code: '' })).code).toBeNull();
  });

  it('blank usage limits become null (unlimited), not 0', () => {
    const p = buildPayload(baseForm({ usageLimit: '', perCustomerUsageLimit: '' }));
    expect(p.usageLimit).toBeNull();
    expect(p.perCustomerUsageLimit).toBeNull();
  });
});

describe('toLocalInput / fromLocalInput', () => {
  it('round-trips an ISO datetime through the datetime-local input format', () => {
    const iso = '2026-03-01T14:30:00.000Z';
    const local = toLocalInput(iso);
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(fromLocalInput(local)).not.toBeNull();
  });

  it('returns an empty string for null/undefined and null for an empty input', () => {
    expect(toLocalInput(null)).toBe('');
    expect(toLocalInput(undefined)).toBe('');
    expect(fromLocalInput('')).toBeNull();
  });
});
