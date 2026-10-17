import { describe, expect, it } from 'vitest';
import { actionToTypeValue, capturePromotionSequence, classifyPromotionActions, hydrateActivePromotions, promotionSequenceCoverage, parseFacetIdsArg, translatePromotionConditions } from './catalog.js';

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
    expect(tv).toEqual({ type: 'percentage', value: 15, freeShipping: true, discountScope: 'order' });
  });

  it('actionToTypeValue leaves freeShipping false for a plain fixed discount', () => {
    const tv = actionToTypeValue([{ code: 'order_fixed_discount', args: [{ name: 'discount', value: '500' }] }]);
    expect(tv).toEqual({ type: 'fixed', value: 500, freeShipping: false, discountScope: 'order' });
  });

  it('actionToTypeValue on a bare free_shipping action: type free_shipping, freeShipping false (redundant field, type already covers it)', () => {
    const tv = actionToTypeValue([{ code: 'free_shipping', args: [] }]);
    expect(tv).toEqual({ type: 'free_shipping', value: 0, freeShipping: false, discountScope: 'order' });
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

describe('source promotion profile', () => {
  it('preserves signed percentage & fixed source discount values', () => {
    for (const [code, type] of [['order_percentage_discount', 'percentage'], ['order_fixed_discount', 'fixed']] as const) {
      expect(actionToTypeValue([{ code, args: [{ name: 'discount', value: '-15' }] }]))
        .toMatchObject({ type, value: -15, discountScope: 'order' });
    }
  });

  it('rejects old amount argument, missing/duplicate discount & values target integer storage cannot preserve', () => {
    for (const args of [[], [{ name: 'amount', value: '500' }],
      [{ name: 'discount', value: '5' }, { name: 'discount', value: '6' }],
      ...['', ' ', 'NaN', 'Infinity', '15.5', '1e2', '9007199254740992', '2147483648'].map(value => [{ name: 'discount', value }])]) {
      expect(() => actionToTypeValue([{ code: 'order_fixed_discount', args }])).toThrow('Invalid source promotion discount');
    }
    expect(() => actionToTypeValue([{ code: 'order_percentage_discount', args: [{ name: 'discount', value: '15.5' }] }]))
      .toThrow('Invalid source promotion discount');
  });

  it('classifies unknown single actions as unsupported', () => {
    expect(classifyPromotionActions([{ code: 'other_discount', args: [] }])).toBe('unsupported');
  });

  const row = (id: string, priority = 1, translation = 'en') => ({ id, prio: priority,
    actions: [{ code: 'order_fixed_discount', args: [{ name: 'discount', value: '500' }] }], conditions: [],
    source_record: JSON.stringify({ id, priority }), translation_record: JSON.stringify({ id, translation }) });
  const capture = async (first: ReturnType<typeof row>[], second = first, selected = [...new Set(first.map(value => value.id))]) => {
    let read = 0;
    const exclusions: import('./context.js').ManifestExclusion[] = [];
    const results = [[{ database: 'fixture', database_oid: '42', server_address: '127.0.0.1', server_port: 5432,
      isolation: 'repeatable read', read_only: 'on' }], first, selected.map(id => ({ id })), second];
    const result = await capturePromotionSequence({ channelId: 1, sourceKey: 'fixture', exclusions,
      q: async () => results[read++]! });
    return { ...result, exclusions };
  };

  it('hydrates joined entities by first appearance without numeric/UUID tie sorting', async () => {
    const rows = [row('20'), row('20', 1, 'fr'), row('3'), row('8', 2)];
    const result = await capture(rows);
    expect(result.provenance.orderedSourceIds).toEqual(['20', '3', '8']);
    expect(result.provenance.entries.map(value => value.stackOrder)).toEqual([0, 1, 2]);
    expect(result.provenance.entries[0]!.translationRecords).toHaveLength(2);
    expect(result.provenance.entries[0]!.actions).toEqual(rows[0]!.actions);
    expect(result.provenance.repeatMatches).toBe(true);
    expect(result.exclusions).toEqual([]);
  });

  it('blocks changed tied sequence & leaves its ranks unresolved without sorting', async () => {
    const result = await capture([row('20'), row('3'), row('8', 2)], [row('3'), row('20'), row('8', 2)]);
    expect(result.provenance.repeatedSourceIds).toEqual(['3', '20', '8']);
    expect(result.provenance.entries.map(value => value.stackOrder)).toEqual([null, null, 2]);
    expect(result.exclusions[0]).toMatchObject({ table: 'promotion', blocking: true });
  });

  it('blocks active captured credit promotion omitted by materialization', async () => {
    const { provenance } = await capture([row('ordinary'), row('credit')]);
    const ctx = { promotionSequence: provenance, id: (_entity: string, id: unknown) => 'native-' + String(id) };
    expect(promotionSequenceCoverage(ctx, ['native-ordinary']))
      .toMatchObject({ blocking: true, sourceValues: ['missing-source:credit'] });
    expect(promotionSequenceCoverage(ctx, ['native-ordinary', 'native-credit'])).toBeNull();
  });

  it('rejects incomplete sets, decreasing priorities & conflicting hydrated identities', async () => {
    await expect(capture([row('20')], undefined, ['20', '3'])).rejects.toThrow('Incomplete active source promotion sequence');
    expect(() => hydrateActivePromotions([row('20', 2), row('3', 1)])).toThrow('Invalid active source promotion sequence');
    expect(() => hydrateActivePromotions([row('20'), { ...row('20'), source_record: 'different' }])).toThrow('Conflicting source promotion identity');
  });
});
