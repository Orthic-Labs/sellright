// Pure-function coverage for the discount-scope condition builder (admin-
// essentials). These mirror the exact condition shape money/coupon.ts's
// evaluateCoupon() reads on the API side — no new vocabulary is invented in
// the admin UI, only surfaced (see Discounts.tsx's header comment).
// Round-tripping buildConditions() -> readCondition() -> hydrateForm() is the
// contract that makes the edit form pre-fill correctly from a saved discount.
import { describe, expect, it } from 'vitest';
import { buildConditions, buildPayload, hydrateForm, readCondition, scopeError, toLocalInput, fromLocalInput, type FormState } from './Discounts.js';

function baseForm(overrides: Partial<FormState> = {}): FormState {
  return {
    id: null, code: 'SAVE10', type: 'percentage', value: '10',
    usageLimit: '', perCustomerUsageLimit: '', startsAt: '', endsAt: '',
    minOrderAmount: '', scope: '', scopeMinimum: '1',
    collectionIds: [], products: [], tags: [], legacyFacetCondition: false,
    enabled: true,
    ...overrides,
  };
}

function detail(conditions: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1', code: 'SAVE10', type: 'percentage', value: 10, enabled: true,
    usedCount: 0, usageLimit: null, perCustomerUsageLimit: null,
    startsAt: null, endsAt: null, conditions, usage: [],
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

  it('emits at_least_n_in_collections with a JSON string array of ids + minimum', () => {
    const conds = buildConditions(baseForm({ scope: 'collections', collectionIds: ['c1', 'c2'], scopeMinimum: '2' })) as Array<{ code: string; args: { name: string; value: string }[] }>;
    expect(conds).toHaveLength(1);
    const c = conds[0]!;
    expect(c.code).toBe('at_least_n_in_collections');
    expect(JSON.parse(c.args.find((a) => a.name === 'collectionIds')!.value)).toEqual(['c1', 'c2']);
    expect(c.args.find((a) => a.name === 'minimum')!.value).toBe('2');
  });

  it('emits at_least_n_products with product ids (never names) + minimum', () => {
    const conds = buildConditions(baseForm({ scope: 'products', products: [{ id: 'p1', name: 'Shirt' }, { id: 'p2', name: 'Hat' }], scopeMinimum: '3' })) as Array<{ code: string; args: { name: string; value: string }[] }>;
    const c = conds[0]!;
    expect(c.code).toBe('at_least_n_products');
    expect(JSON.parse(c.args.find((a) => a.name === 'productIds')!.value)).toEqual(['p1', 'p2']);
    expect(c.args.find((a) => a.name === 'minimum')!.value).toBe('3');
  });

  it('emits at_least_n_with_tags with tag names + minimum', () => {
    const conds = buildConditions(baseForm({ scope: 'tags', tags: ['summer', 'clearance'] })) as Array<{ code: string; args: { name: string; value: string }[] }>;
    const c = conds[0]!;
    expect(c.code).toBe('at_least_n_with_tags');
    expect(JSON.parse(c.args.find((a) => a.name === 'tags')!.value)).toEqual(['summer', 'clearance']);
    expect(c.args.find((a) => a.name === 'minimum')!.value).toBe('1');
  });

  it('whole-order scope emits no scope condition at all', () => {
    expect(buildConditions(baseForm({ scope: '' }))).toBeNull();
  });

  it('emits at most one scope condition even when several scope fields are filled', () => {
    const conds = buildConditions(baseForm({ scope: 'tags', tags: ['t1'], collectionIds: ['c1'], products: [{ id: 'p1', name: 'x' }] })) as Array<{ code: string }>;
    expect(conds).toHaveLength(1);
    expect(conds[0]!.code).toBe('at_least_n_with_tags');
  });

  it('a scope with an empty selection falls back to whole order (no condition)', () => {
    expect(buildConditions(baseForm({ scope: 'collections', collectionIds: [] }))).toBeNull();
    expect(buildConditions(baseForm({ scope: 'products', products: [] }))).toBeNull();
    expect(buildConditions(baseForm({ scope: 'tags', tags: [] }))).toBeNull();
  });

  it('clamps minimum matching quantity to at least 1', () => {
    for (const min of ['0', '-3', 'abc', '']) {
      const conds = buildConditions(baseForm({ scope: 'tags', tags: ['t1'], scopeMinimum: min })) as Array<{ args: { name: string; value: string }[] }>;
      expect(conds[0]!.args.find((a) => a.name === 'minimum')!.value).toBe('1');
    }
  });

  it('combines a minimum-order condition AND a scope condition', () => {
    const conds = buildConditions(baseForm({ minOrderAmount: '10', scope: 'collections', collectionIds: ['c1'] })) as Array<{ code: string }>;
    expect(conds.map((c) => c.code)).toEqual(['minimum_order_amount', 'at_least_n_in_collections']);
  });

  it('ignores a zero or blank minimum order amount (no phantom condition)', () => {
    expect(buildConditions(baseForm({ minOrderAmount: '0' }))).toBeNull();
    expect(buildConditions(baseForm({ minOrderAmount: '   ' }))).toBeNull();
  });

  it('never emits the retired at_least_n_with_facets code', () => {
    for (const scope of ['', 'collections', 'products', 'tags'] as const) {
      const conds = (buildConditions(baseForm({ scope, collectionIds: ['c'], products: [{ id: 'p', name: 'p' }], tags: ['t'] })) ?? []) as Array<{ code: string }>;
      expect(conds.every((c) => c.code !== 'at_least_n_with_facets')).toBe(true);
    }
  });
});

describe('readCondition — round-trips buildConditions() output', () => {
  it('reads back the minimum_order_amount amount', () => {
    const conds = buildConditions(baseForm({ minOrderAmount: '25.50' }));
    expect(readCondition(conds, 'minimum_order_amount')).toEqual({ amount: '2550' });
  });

  it('reads back each native scope arg set', () => {
    const col = readCondition(buildConditions(baseForm({ scope: 'collections', collectionIds: ['c1'], scopeMinimum: '2' })), 'at_least_n_in_collections');
    expect(JSON.parse(col.collectionIds!)).toEqual(['c1']);
    expect(col.minimum).toBe('2');
    const prod = readCondition(buildConditions(baseForm({ scope: 'products', products: [{ id: 'p1', name: 'x' }] })), 'at_least_n_products');
    expect(JSON.parse(prod.productIds!)).toEqual(['p1']);
    const tag = readCondition(buildConditions(baseForm({ scope: 'tags', tags: ['t1'] })), 'at_least_n_with_tags');
    expect(JSON.parse(tag.tags!)).toEqual(['t1']);
  });

  it('returns {} for a condition code that is not present', () => {
    expect(readCondition(null, 'minimum_order_amount')).toEqual({});
    expect(readCondition([{ code: 'other' }], 'minimum_order_amount')).toEqual({});
  });
});

describe('hydrateForm — readCondition -> form round-trips', () => {
  it('hydrates a collections scope', () => {
    const f = hydrateForm(detail([{ code: 'at_least_n_in_collections', args: [{ name: 'collectionIds', value: '["c1","c2"]' }, { name: 'minimum', value: '3' }] }]));
    expect(f.scope).toBe('collections');
    expect(f.collectionIds).toEqual(['c1', 'c2']);
    expect(f.scopeMinimum).toBe('3');
    expect(f.legacyFacetCondition).toBe(false);
    // and it serializes back to the same condition
    const back = buildConditions(f) as Array<{ code: string }>;
    expect(back[0]!.code).toBe('at_least_n_in_collections');
  });

  it('hydrates a products scope with ids (names resolved by the component)', () => {
    const f = hydrateForm(detail([{ code: 'at_least_n_products', args: [{ name: 'productIds', value: '["p1"]' }, { name: 'minimum', value: '1' }] }]));
    expect(f.scope).toBe('products');
    expect(f.products).toEqual([{ id: 'p1', name: 'p1' }]);
  });

  it('hydrates a tags scope', () => {
    const f = hydrateForm(detail([{ code: 'at_least_n_with_tags', args: [{ name: 'tags', value: '["summer"]' }, { name: 'minimum', value: '1' }] }]));
    expect(f.scope).toBe('tags');
    expect(f.tags).toEqual(['summer']);
  });

  it('hydrates whole-order (no scope condition) to an empty scope', () => {
    const f = hydrateForm(detail([{ code: 'minimum_order_amount', args: [{ name: 'amount', value: '1000' }] }]));
    expect(f.scope).toBe('');
    expect(f.minOrderAmount).toBe('10.00');
    expect(f.legacyFacetCondition).toBe(false);
  });

  it('flags a saved at_least_n_with_facets condition as retired…', () => {
    const f = hydrateForm(detail([{ code: 'at_least_n_with_facets', args: [{ name: 'facets', value: '["fa1"]' }, { name: 'minimum', value: '2' }] }]));
    expect(f.legacyFacetCondition).toBe(true);
    expect(f.scope).toBe('');
    // …and saving drops the legacy condition entirely
    const conds = buildConditions(f) ?? [];
    expect((conds as Array<{ code: string }>).every((c) => c.code !== 'at_least_n_with_facets')).toBe(true);
  });
});

describe('scopeError — a chosen scope with nothing selected must not save', () => {
  const MSG = 'Select at least one collection, product or tag — or choose Whole order.';

  it('is null for whole order', () => {
    expect(scopeError(baseForm({ scope: '' }))).toBeNull();
  });

  it('is null for each populated scope', () => {
    expect(scopeError(baseForm({ scope: 'collections', collectionIds: ['c1'] }))).toBeNull();
    expect(scopeError(baseForm({ scope: 'products', products: [{ id: 'p1', name: 'x' }] }))).toBeNull();
    expect(scopeError(baseForm({ scope: 'tags', tags: ['t1'] }))).toBeNull();
  });

  it('is the message for each empty scope', () => {
    expect(scopeError(baseForm({ scope: 'collections', collectionIds: [] }))).toBe(MSG);
    expect(scopeError(baseForm({ scope: 'products', products: [] }))).toBe(MSG);
    expect(scopeError(baseForm({ scope: 'tags', tags: [] }))).toBe(MSG);
  });

  it('ignores items stashed under a different scope (only the chosen scope counts)', () => {
    expect(scopeError(baseForm({ scope: 'tags', tags: [], collectionIds: ['c1'] }))).toBe(MSG);
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
