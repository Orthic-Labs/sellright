import { describe, expect, it } from 'vitest';
import { actionToTypeValue, classifyPromotionActions, parseFacetIdsArg, translatePromotionConditions } from './catalog.js';

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

describe('de-Vendure — facet-condition -> native collection-condition translation', () => {
  it('parseFacetIdsArg reads the JSON-encoded facets arg', () => {
    expect(parseFacetIdsArg({ code: 'at_least_n_with_facets', args: [{ name: 'facets', value: '["1","2"]' }] })).toEqual(['1', '2']);
  });

  it('parseFacetIdsArg tolerates a missing/malformed facets arg', () => {
    expect(parseFacetIdsArg({ code: 'at_least_n_with_facets' })).toEqual([]);
    expect(parseFacetIdsArg({ code: 'at_least_n_with_facets', args: [{ name: 'facets', value: 'not json' }] })).toEqual([]);
  });

  it('translatePromotionConditions rewrites at_least_n_with_facets to at_least_n_in_collections', () => {
    const map = new Map([['1', 'col-uuid-1'], ['2', 'col-uuid-2']]);
    const out = translatePromotionConditions(
      [{ code: 'at_least_n_with_facets', args: [{ name: 'minimum', value: '3' }, { name: 'facets', value: '["1","2"]' }] }],
      map,
    );
    expect(out).toEqual([
      { code: 'at_least_n_in_collections', args: [{ name: 'minimum', value: '3' }, { name: 'collectionIds', value: JSON.stringify(['col-uuid-1', 'col-uuid-2']) }] },
    ]);
  });

  it('translatePromotionConditions leaves other conditions (minimum_order_amount, verified_customer) untouched', () => {
    const passthrough = [
      { code: 'minimum_order_amount', args: [{ name: 'amount', value: '1000' }] },
      { code: 'verified_customer', args: [{ name: 'categories', value: '["military"]' }] },
    ];
    expect(translatePromotionConditions(passthrough, new Map())).toEqual(passthrough);
  });

  it('translatePromotionConditions drops unresolved facet ids (no surviving product) to an empty, fail-closed collectionIds list', () => {
    const out = translatePromotionConditions(
      [{ code: 'at_least_n_with_facets', args: [{ name: 'minimum', value: '1' }, { name: 'facets', value: '["9"]' }] }],
      new Map(), // facet id 9 never resolved to a collection
    );
    expect(out).toEqual([
      { code: 'at_least_n_in_collections', args: [{ name: 'minimum', value: '1' }, { name: 'collectionIds', value: '[]' }] },
    ]);
  });

  it('translatePromotionConditions defaults minimum to "1" when the source omitted it', () => {
    const out = translatePromotionConditions(
      [{ code: 'at_least_n_with_facets', args: [{ name: 'facets', value: '["1"]' }] }],
      new Map([['1', 'col-uuid-1']]),
    );
    expect(out[0]).toMatchObject({ args: [{ name: 'minimum', value: '1' }, { name: 'collectionIds', value: '["col-uuid-1"]' }] });
  });
});
