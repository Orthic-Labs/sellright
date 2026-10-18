import { describe, expect, it } from 'vitest';
import { calculatePromotionStack, type StackInput, type StackLine, type ResolvedPromotion } from '../money/promotion-stack.js';
import { buildOrderPricingSnapshot, readOrderPricingSnapshot } from '../money/pricing-snapshot.js';
import { migrationId } from '../import/context.js';
import { orderEditAcceptanceHash, orderEditStoredFingerprint, priceEditShippingCarriers, priceOrderEditStack, projectEditStackLines, readImportedOrderEditBasis, readImportedOrderEditComponents, type OrderEditStackInput, type EditStackWorkingLine } from './order-edit-stack.js';

const A = 'cccccccc-0000-4000-8000-000000000001';
const B = 'cccccccc-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const D = 'cccccccc-0000-4000-8000-000000000004';
const ACCOUNT = 'cccccccc-0000-4000-8000-000000000005';
const line = (key: string, patch: Partial<StackLine> = {}): StackLine => ({ key, quantity: 1, placedQuantity: 1,
  unitListPrice: 101, priceIncludesTax: false, taxRateBps: 0, ...patch });
const promo = (patch: Partial<ResolvedPromotion> = {}): ResolvedPromotion => ({ id: 'half', code: 'HALF', kind: 'percentage',
  scope: 'order', value: 50, priority: 0, sequence: 0, freeShipping: false, conditions: [], ...patch });
function fixture(patch: Partial<StackInput> = {}): StackInput {
  return { lines: [line('a'), line('b')], promotions: [promo(), promo({ id: 'one', code: 'ONE', kind: 'fixed', value: 1, priority: 1, sequence: 1 })],
    couponCodes: ['HALF', 'ONE'], currency: 'USD', phase: 'PaymentSettled', pricesIncludeTax: false,
    shipping: 10, shippingTaxRateBps: 0, shippingIncludesTax: false, pointsDiscount: 0, adjustments: [],
    couponContext: { activeVerifications: [] }, ...patch };
}
function request(input = fixture(), snapshot = false): OrderEditStackInput {
  const result = calculatePromotionStack(input);
  const orderLines = input.lines.map((item, index) => ({ key: item.key, id: [A, B][index]!, quantity: item.quantity }));
  const { lines: _lines, phase: _phase, currency: _currency, ...pricing } = input;
  return { before: { basis: snapshot ? { kind: 'snapshot', snapshot: buildOrderPricingSnapshot(input, result, new Map(orderLines.map(item => [item.key, item.id]))) }
    : { kind: 'imported', input: structuredClone(input), result: structuredClone(result) },
    currency: input.currency, orderLines, totals: result, economicHash: result.quoteHash }, creditLedgerEvidence: [],
    lines: input.lines.map(item => ({ key: item.key, quantity: item.quantity, change: 'untouched' })), pricing: structuredClone(pricing) as OrderEditStackInput['pricing'] };
}
function refreshed(item: StackLine, quantity: number): EditStackWorkingLine {
  const { key, quantity: _old, ...basis } = item;
  return { key, quantity, change: 'touched', basis };
}
const refusal = (input: OrderEditStackInput, code = 'ORDER_EDIT_STACK_BASIS_INVALID') => {
  expect(() => priceOrderEditStack(input)).toThrow(expect.objectContaining({ code }));
};

describe('pure ordinary-promotion order edit candidate', () => {
  it.each([false, true])('recomputes complete coupon stack once from untouched bases (snapshot=%s)', snapshot => {
    const input = request(fixture(), snapshot);
    const saved = structuredClone(input);
    const result = priceOrderEditStack(input);
    expect(result.couponCodes).toEqual(['HALF', 'ONE']);
    expect(result.result).toMatchObject({ subtotal: 202, discountTotal: 102, shippingTotal: 10, grandTotal: 110, selectedCredit: null });
    expect(result.result.applied.map(entry => entry.promotionId)).toEqual(['half', 'one']);
    expect(result.result.applied[0]!.lineAllocations.map(part => part.units)).toEqual([[-50], [-51]]);
    // Half allocates -50/-51; the final cent goes to first line's remainder.
    expect(result.result.applied[1]!.lineAllocations.map(part => part.units)).toEqual([[-1], [0]]);
    expect([...result.perLine.values()].map(item => [item.unitPrice, item.lineTotal])).toEqual([[101, 50], [101, 50]]);
    expect(result.beforeEconomicHash).toBe(result.afterEconomicHash);
    expect(result.balance).toBe(0);
    expect(input).toEqual(saved);
  });

  it('preserves untouched price basis while touched/new lines use refreshed exact list prices', () => {
    const input = request();
    input.lines[1] = refreshed(line('b', { unitListPrice: 137, placedQuantity: 2, taxRateBps: 875 }), 2);
    input.lines.push({ key: 'new:0', quantity: 3, change: 'new', basis: { placedQuantity: 3, unitListPrice: 103, priceIncludesTax: true, taxRateBps: 2000 } });
    const result = priceOrderEditStack(input);
    expect(result.input.lines.map(item => item.unitListPrice)).toEqual([101, 137, 103]);
    expect([...result.perLine.values()].map(item => item.unitPrice)).toEqual([101, 137, 103]);
    expect(result.input.lines[1]).toMatchObject({ quantity: 2, placedQuantity: 2, taxRateBps: 875 });
    expect(result.afterEconomicHash).not.toBe(result.beforeEconomicHash);
    expect(result.balance).toBe(result.result.grandTotal - input.before.totals.grandTotal);
  });

  it('removes ordinary coupons without retaining their generated prior discounts', () => {
    const input = request(fixture(), true);
    input.pricing.couponCodes = []; input.pricing.promotions = [];
    const result = priceOrderEditStack(input);
    expect(result.result).toMatchObject({ subtotal: 202, discountTotal: 0, grandTotal: 212, applied: [] });
    expect(result.couponCodes).toEqual([]);
    expect(result.balance).toBe(102);
  });

  it('keeps mixed inclusive/exclusive tax line facts & rounded units separate from line averages', () => {
    const input = request(fixture({ lines: [line('a', { unitListPrice: 1, quantity: 2, placedQuantity: 2, taxRateBps: 5000 }),
      line('b', { unitListPrice: 120, priceIncludesTax: true, taxRateBps: 2000 })], promotions: [], couponCodes: [], shipping: 0 }));
    const result = priceOrderEditStack(input);
    expect(result.result).toMatchObject({ subtotal: 102, discountTotal: 0, taxTotal: 21, grandTotal: 123 });
    expect(result.result.lineSnapshots).toEqual([
      { lineKey: 'a', quantity: 2, proratedUnitPriceWithTax: 2, lineNet: 2, lineGross: 3, sourceAdjustmentTotal: 0, sourceAdjustmentDivisor: 2 },
      { lineKey: 'b', quantity: 1, proratedUnitPriceWithTax: 120, lineNet: 100, lineGross: 120, sourceAdjustmentTotal: 0, sourceAdjustmentDivisor: 1 },
    ]);
    expect(result.perLine.get('a')!.unitPrice).toBe(1);
  });

  it('retains placed-quantity provenance on reductions & explicit zero-money rows', () => {
    const input = request(fixture({ lines: [line('a', { quantity: 3, placedQuantity: 3 }), line('b')],
      promotions: [promo({ kind: 'fixed', value: 101 })], couponCodes: ['HALF'], shipping: 0 }));
    input.lines = [refreshed(line('a', { placedQuantity: 3 }), 1), refreshed(line('b'), 0)];
    const result = priceOrderEditStack(input);
    expect(result.input.lines.map(item => [item.quantity, item.placedQuantity])).toEqual([[1, 3], [0, 1]]);
    expect(result.result.applied[0]!.lineAllocations[0]).toMatchObject({ lineKey: 'a', sourceAdjustmentAmount: -101, amount: -34, units: [-34] });
    expect(result.result.grandTotal).toBe(67);
    expect(result.perLine.get('b')).toMatchObject({ quantity: 0, lineSubtotal: 0, lineDiscount: 0, lineTotal: 0 });
  });

  it('applies signed order adjustments & points exactly once', () => {
    const input = request(fixture({ lines: [line('a', { unitListPrice: 101 })], promotions: [promo()], couponCodes: ['HALF'],
      shipping: 0, pointsDiscount: 1, adjustments: [{ label: 'Manual credit', amount: -2 }] }));
    const result = priceOrderEditStack(input);
    expect(result.result).toMatchObject({ subtotal: 101, discountTotal: 51, pointsDiscount: 1, adjustmentTotal: -2, grandTotal: 48 });
    expect(result.result.applied[0]!.amount).toBe(-50);
  });

  it.each([false, true])('retains signed surcharge tax & exact zero/positive payables (snapshot=%s)', snapshot => {
    for (const [amount, taxTotal, grandTotal] of [[-200, -10, 890], [-1009, -91, 0]] as const) {
      const basis = fixture({ lines: [line('a', { unitListPrice: 100, taxRateBps: 1000 }), line('b', { unitListPrice: 1000 })],
        promotions: [], couponCodes: [], shipping: 0, adjustments: [{ label: 'Signed taxable source adjustment', amount, taxable: true }] });
      const input = request(basis, snapshot), before = structuredClone(input);
      const candidate = priceOrderEditStack(input);
      expect(candidate.result).toMatchObject({ subtotal: 1100, discountTotal: 0, shippingTotal: 0, taxTotal, grandTotal, pointsDiscount: 0 });
      expect(candidate.balance).toBe(0);
      expect(candidate.afterEconomicHash).toBe(candidate.beforeEconomicHash);
      const persisted = buildOrderPricingSnapshot(candidate.snapshotDraft.input, candidate.snapshotDraft.result, new Map([['a', A], ['b', B]]));
      expect(readOrderPricingSnapshot(JSON.parse(JSON.stringify(persisted)), { currency: 'USD', orderLines: input.before.orderLines,
        totals: candidate.result, mode: 'settlement' })).toEqual(persisted);
      expect(input).toEqual(before);
    }
  });

  it('rejects invalid signed tax & preserves nonnegative bounds for all other totals', () => {
    for (const taxTotal of [NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, -2_147_483_648, 2_147_483_648]) {
      const input = request(); input.before.totals.taxTotal = taxTotal; refusal(input);
    }
    for (const key of ['subtotal', 'discountTotal', 'shippingTotal', 'grandTotal', 'pointsDiscount'] as const) {
      const input = request(); input.before.totals[key] = -1; refusal(input);
    }
  });

  it('admits signed discount only through independently normalized current pricing proof', () => {
    const basis = fixture(), input = request(basis);
    input.before.basis = { kind: 'current-proof', lines: basis.lines, pricesIncludeTax: false, economicHash: input.before.economicHash };
    input.before.totals = { ...input.before.totals, discountTotal: -10 };
    expect(priceOrderEditStack(input).result.grandTotal).toBe(110);
    input.before.totals.grandTotal = -1;
    refusal(input);
  });

  it('binds item eligibility facts to logical line identities, beyond aggregate quantity', () => {
    const items = [
      { lineKey: 'a', quantity: 1, productId: 'eligible', tags: [], collectionIds: [] },
      { lineKey: 'b', quantity: 1, productId: 'other', tags: [], collectionIds: [] },
    ];
    const input = request(fixture({ promotions: [promo({ conditions: [{ code: 'at_least_n_products', args: [{ name: 'productIds', value: '["eligible"]' }] }] })],
      couponCodes: ['HALF'], couponContext: { activeVerifications: [], items } }));
    expect(priceOrderEditStack(input).result.applied).toHaveLength(1);
    input.pricing.couponContext.items![1]!.lineKey = 'a'; refusal(input);
    input.pricing.couponContext.items![1]!.lineKey = 'unrelated'; refusal(input);
  });

  it('keeps new logical keys & persisted UUIDs outside economic hashes, then binds snapshot bijectively', () => {
    const first = request();
    first.lines.push({ key: 'new:0', quantity: 2, change: 'new', basis: { placedQuantity: 2, unitListPrice: 107, priceIncludesTax: false, taxRateBps: 875 } });
    const second = structuredClone(first); second.lines[2]!.key = 'other-provisional-key';
    const a = priceOrderEditStack(first); const b = priceOrderEditStack(second);
    expect(a.afterEconomicHash).toBe(b.afterEconomicHash);
    const sa = buildOrderPricingSnapshot(a.snapshotDraft.input, a.snapshotDraft.result, new Map([['a', A], ['b', B], ['new:0', C]]));
    const sb = buildOrderPricingSnapshot(b.snapshotDraft.input, b.snapshotDraft.result, new Map([['a', B], ['b', A], ['other-provisional-key', D]]));
    expect(sa.quoteHash).toBe(sb.quoteHash);
    expect(sa.lines[2]!.orderLineId).toBe(C); expect(sb.lines[2]!.orderLineId).toBe(D);
    expect(readOrderPricingSnapshot(sa, { currency: 'USD', orderLines: sa.lines.map(item => ({ id: item.orderLineId, quantity: item.quantity })), totals: a.result, mode: 'settlement' })).toEqual(sa);
  });

  it.each(['order', 'item'] as const)('refuses retained generated %s adjustments instead of double-discounting', kind => {
    const input = request();
    const touched = refreshed(line('a'), 1);
    if (touched.change !== 'untouched') touched.basis.priorAdjustments = [{ kind, amount: -50, units: [-50], promotionId: 'half' }];
    input.lines[0] = touched; refusal(input);
  });

  it('clears historic item vectors before current ordinary promotions & rejects incomplete refreshed vectors', () => {
    const input = request(fixture({ lines: [line('a', { priorAdjustments: [{ kind: 'item', amount: -1, units: [-1] }] })] }));
    expect(priceOrderEditStack(input).input.lines[0]!.priorAdjustments).toEqual([]);
    const touched = refreshed(line('a', { priorAdjustments: [{ kind: 'item', amount: -1, units: [] }] }), 1);
    input.lines = [touched]; refusal(input);
  });

  it('refuses stored drift, unbound hashes & incomplete native/logical line closure', () => {
    const cases: Array<(input: OrderEditStackInput) => void> = [
      input => { input.before.totals.grandTotal += 1; },
      input => { input.before.economicHash = '0'.repeat(64); },
      input => { input.before.orderLines.pop(); },
      input => { input.before.orderLines[0]!.key = 'other'; },
      input => { input.lines.pop(); },
      input => { input.lines.push(structuredClone(input.lines[0]!)); },
      input => { input.lines[0]!.quantity += 1; },
      input => { input.pricing.couponCodes = ['HALF', 'half']; },
      input => { input.pricing.pointsDiscount = undefined; },
      input => { input.pricing.couponContext.items = []; },
      input => { input.pricing.promotions[0]!.conditions = [{ code: 'minimum_order_amount', args: [{ name: 'amount', value: 'not money' }] }]; },
      input => { input.pricing.promotions[0]!.conditions = [{ code: 'verified_customer', args: [{ name: 'categories', value: '[invalid json' }] }]; },
    ];
    for (const mutate of cases) { const input = request(); mutate(input); refusal(input); }
    const snapshot = request(fixture(), true);
    if (snapshot.before.basis.kind === 'snapshot') (snapshot.before.basis.snapshot as { lines: StackLine[] }).lines[0]!.unitListPrice += 1;
    refusal(snapshot);
    const incomplete = request(fixture(), true);
    if (incomplete.before.basis.kind === 'snapshot') delete (incomplete.before.basis.snapshot as Partial<{ selectedCredit: null }>).selectedCredit;
    refusal(incomplete);
  });

  it('rejects invalid money & missing refreshed tax/placed facts before pricing', () => {
    for (const bad of [NaN, 1.5, -1, 2_147_483_648]) {
      const input = request(); input.lines[0] = refreshed(line('a', { unitListPrice: bad }), 1); refusal(input);
    }
    const input = request(); input.lines[0] = refreshed(line('a'), 2);
    if (input.lines[0].change !== 'untouched') delete (input.lines[0].basis as Partial<StackLine>).placedQuantity;
    refusal(input);
  });

  it('retains unavailable ordinary coupon membership without applying an action', () => {
    const input = request(); input.pricing.couponCodes.push('EXPIRED');
    const candidate = priceOrderEditStack(input);
    expect(candidate.couponCodes).toEqual(['HALF', 'ONE', 'EXPIRED']);
    expect(candidate.result.coupons.at(-1)).toMatchObject({ code: 'EXPIRED', applied: false, promotionId: null });
  });

  it('projects inclusive net list with unrounded unit times quantity, independently of gross final total', () => {
    const input = fixture({ lines: [line('a', { unitListPrice: 1, quantity: 3, placedQuantity: 3, priceIncludesTax: true, taxRateBps: 2000 })],
      promotions: [], couponCodes: [], shipping: 0 });
    expect(projectEditStackLines(input, calculatePromotionStack(input))).toEqual([
      { key: 'a', quantity: 3, unitPrice: 1, lineSubtotal: 3, lineDiscount: 0, lineTax: 0, lineTotal: 3 },
    ]);
  });

  it('binds equal-total edits to full before economics & ordered canonical operations', () => {
    const before = orderEditStoredFingerprint({ lines: [{ id: A, refundedQty: 0 }], updatedAt: new Date('2026-01-01T00:00:00Z') });
    const after = 'a'.repeat(64);
    const hash = orderEditAcceptanceHash(before, after, [{ op: 'remove_coupon', code: 'Ten' }, { op: 'apply_coupon', code: 'VIP' }]);
    expect(orderEditAcceptanceHash(before, after, [{ op: 'remove_coupon', code: 'tEN' }, { op: 'apply_coupon', code: 'vip' }])).toBe(hash);
    expect(orderEditAcceptanceHash(before, after, [{ op: 'apply_coupon', code: 'VIP' }, { op: 'remove_coupon', code: 'Ten' }])).not.toBe(hash);
    expect(orderEditAcceptanceHash(before, after, [{ op: 'remove_coupon', code: ' Ten ' }, { op: 'apply_coupon', code: 'VIP' }])).not.toBe(hash);
    expect(orderEditStoredFingerprint({ lines: [{ id: A, refundedQty: 1 }], updatedAt: new Date('2026-01-01T00:00:00Z') })).not.toBe(before);
    expect(orderEditStoredFingerprint({ lines: [{ id: A, refundedQty: 0 }], updatedAt: new Date('2026-01-02T00:00:00Z') })).not.toBe(before);
  });

  it('admits imported raw LIST only through complete digest/ownership/getter parity', () => {
    const orderId = migrationId(C, 'source', 'order', 9), lineId = migrationId(C, 'source', 'order-line', 7);
    const sourceLine = { id: 7, orderId: 9, quantity: 2, orderPlacedQuantity: 3, listPrice: 120, listPriceIncludesTax: true,
      adjustments: [{ amount: -60, type: 'PROMOTION' }], taxLines: [{ taxRate: 20 }], shippingLineId: null };
    const payload = { version: 1, format: 'retained-pg-jsonb-text-v1', sourceKey: 'source', sourceOrderId: '9',
      sourceOrderRecord: JSON.stringify({ id: 9, currencyCode: 'USD', subTotal: 167, subTotalWithTax: 200, shipping: 0, shippingWithTax: 0, couponCodes: ['EXPIRED'] }),
      channel: { sourceId: '3', projection: 'pricing-v1', sourceRecord: JSON.stringify({ id: 3, defaultCurrencyCode: 'USD', pricesIncludeTax: true, defaultTaxZoneId: 1 }), orderChannelRecord: JSON.stringify({ orderId: 9, channelId: 3 }) },
      header: { subTotal: '167', subTotalWithTax: '200', shipping: '0', shippingWithTax: '0' },
      lines: [{ sourceId: '7', orderLineId: lineId, sourceRecord: JSON.stringify(sourceLine) }], shippingLines: [], shippingMethods: [], surcharges: [] };
    const metadata = { vendure: { id: 9, sourceKey: 'source', editBasisV1: { ...payload, sourceDigest: orderEditStoredFingerprint(payload) } } };
    const native = { id: lineId, orderId, storeId: C, quantity: 2, unitPrice: 100, lineSubtotal: 200, lineDiscount: 33, lineTax: 33, lineTotal: 200, metadata: { vendure: { id: 7 } } };
    const context = { storeId: C, orderId, currency: 'USD', orderLines: [native], couponCodes: ['EXPIRED'] };
    const basis = readImportedOrderEditBasis(metadata, context);
    expect(basis.lines).toEqual([{ key: lineId, quantity: 2, placedQuantity: 3, unitListPrice: 120, priceIncludesTax: true, taxRateBps: 2000, priorAdjustments: [] }]);
    expect(() => readImportedOrderEditBasis(metadata, { ...context, orderId: B })).toThrow(/order identity/);
    expect(() => readImportedOrderEditBasis(metadata, { ...context, orderLines: [{ ...native, unitPrice: 101 }] })).toThrow();
    expect(() => readImportedOrderEditBasis(metadata, { ...context, couponCodes: ['OTHER'] })).toThrow();
    const changed = structuredClone(metadata); changed.vendure.editBasisV1.lines[0]!.sourceRecord += ' ';
    expect(() => readImportedOrderEditBasis(changed, context)).toThrow();
    expect(() => readImportedOrderEditBasis({ vendure: { id: 9, sourceKey: 'source' } }, context)).toThrow();
    // Header anomalies stay raw; equal rounded JS Numbers do not prove parity.
    const anomalous = { ...payload, sourceOrderRecord: payload.sourceOrderRecord.replace('"subTotal":167', '"subTotal":9007199254740993'),
      header: { ...payload.header, subTotal: '9007199254740993' } };
    const captured = { vendure: { id: 9, sourceKey: 'source', editBasisV1: { ...anomalous, sourceDigest: orderEditStoredFingerprint(anomalous) } } };
    expect(readImportedOrderEditBasis(captured, context).lines).toEqual(basis.lines);
    const roundedCollision = { ...anomalous, header: { ...anomalous.header, subTotal: '9007199254740992' } };
    expect(() => readImportedOrderEditBasis({ vendure: { id: 9, sourceKey: 'source', editBasisV1: {
      ...roundedCollision, sourceDigest: orderEditStoredFingerprint(roundedCollision) } } }, context)).toThrow(/header differs/);
  });

  it('retains independent mixed shipping getters & signed surcharge facts after merchandise changes', () => {
    const payload = { version: 1, format: 'retained-pg-jsonb-text-v1', sourceKey: 'source', sourceOrderId: '9',
      sourceOrderRecord: JSON.stringify({ id: 9, currencyCode: 'USD', subTotal: -100, subTotalWithTax: -120, shipping: 15, shippingWithTax: 18 }),
      channel: { sourceId: '3', projection: 'pricing-v1', sourceRecord: JSON.stringify({ id: 3, defaultCurrencyCode: 'USD', pricesIncludeTax: false, defaultTaxZoneId: 1 }), orderChannelRecord: JSON.stringify({ orderId: 9, channelId: 3 }) },
      header: { subTotal: '-100', subTotalWithTax: '-120', shipping: '15', shippingWithTax: '18' },
      lines: [{ sourceId: '7', orderLineId: A, sourceRecord: JSON.stringify({ id: 7, orderId: 9, shippingLineId: 11 }) }],
      shippingLines: [
        { sourceId: '11', sourceRecord: JSON.stringify({ id: 11, orderId: 9, shippingMethodId: 4, listPrice: 12, listPriceIncludesTax: true, adjustments: [{ amount: -6 }], taxLines: [{ taxRate: 20 }] }) },
        { sourceId: '12', sourceRecord: JSON.stringify({ id: 12, orderId: 9, shippingMethodId: null, listPrice: 10, listPriceIncludesTax: false, adjustments: [], taxLines: [{ taxRate: 20 }] }) },
      ], shippingMethods: [{ sourceId: '4', sourceRecord: JSON.stringify({ id: 4, code: 'POST' }) }],
      surcharges: [{ sourceId: '13', sourceRecord: JSON.stringify({ id: 13, orderId: 9, description: 'Historic credit', listPrice: -120, listPriceIncludesTax: true, taxLines: [{ taxRate: 20 }] }) }] };
    const metadata = { vendure: { id: 9, sourceKey: 'source', editBasisV1: { ...payload, sourceDigest: orderEditStoredFingerprint(payload) } } };
    const components = readImportedOrderEditComponents(metadata, 'USD');
    expect(components.pricesIncludeTax).toBe(false);
    expect(components.shippingLines.map(line => line.orderLineIds)).toEqual([[A], []]);
    expect(components.shippingLines.map(({ net, gross, tax, methodCode }) => ({ net, gross, tax, methodCode }))).toEqual([
      { net: 5, gross: 6, tax: 1, methodCode: 'POST' }, { net: 10, gross: 12, tax: 2, methodCode: null },
    ]);
    expect(components.surcharges[0]).toMatchObject({ net: -100, gross: -120, tax: -20 });
    const foreignChannel = { ...payload, channel: { ...payload.channel, orderChannelRecord: JSON.stringify({ orderId: 8, channelId: 3 }) } };
    expect(() => readImportedOrderEditComponents({ vendure: { ...metadata.vendure, editBasisV1: { ...foreignChannel, sourceDigest: orderEditStoredFingerprint(foreignChannel) } } }, 'USD')).toThrow(/channel/);
    const missingMethod = { ...payload, shippingMethods: [] };
    expect(() => readImportedOrderEditComponents({ vendure: { ...metadata.vendure, editBasisV1: { ...missingMethod, sourceDigest: orderEditStoredFingerprint(missingMethod) } } }, 'USD')).toThrow(/method closure/);
  });

  it('keeps net-zero gross-positive shipping until an accepted shipping action removes exact pairs', () => {
    const retainedShipping = { sourceDigest: 'a'.repeat(64), mode: 'keep' as const, lines: [{ sourceId: '11', net: 0, gross: 1 }] };
    const base = fixture({ lines: [line('a', { unitListPrice: 100 })], shipping: 0, retainedShipping,
      promotions: [promo({ kind: 'free_shipping', value: 0 })], couponCodes: ['HALF'] });
    const kept = priceOrderEditStack(request(base));
    expect(kept.result).toMatchObject({ shippingTotal: 0, taxTotal: 1, grandTotal: 101, retainedShippingFinal: retainedShipping.lines });
    const input = request(base); input.pricing.retainedShipping!.mode = 'revalidate-promotions';
    const revalidated = priceOrderEditStack(input);
    expect(revalidated.result).toMatchObject({ shippingTotal: 0, taxTotal: 0, grandTotal: 100, retainedShippingFinal: [{ sourceId: '11', net: 0, gross: 0 }] });
    expect(revalidated.afterEconomicHash).not.toBe(kept.afterEconomicHash);
    expect(revalidated.result.applied[0]!.shippingAdjustment).toEqual({ net: 0, gross: -1 });
  });

  it('preserves negative source payable arithmetic through ordinary snapshots', () => {
    const base = fixture({ lines: [line('a', { unitListPrice: 100 })], shipping: 0, promotions: [], couponCodes: [],
      adjustments: [{ label: 'Historic signed surcharge', amount: -200, sourceSurcharge: { sourceId: '13', sourceDigest: 'b'.repeat(64), net: -200, gross: -240 } }] });
    const candidate = priceOrderEditStack(request(base, true));
    expect(candidate.result).toMatchObject({ taxTotal: -40, grandTotal: -140 });
    expect(candidate.balance).toBe(0);
    const bad = request(base); bad.pricing.adjustments![0]!.sourceSurcharge!.net++;
    refusal(bad);
  });

  it.each([
    [false, false, 80, 80, false], [false, true, 0, 0, true],
    [true, false, 30, 33, false], [true, true, 0, 0, true],
  ])('prices carrier flags recalculate=%s promotions=%s from exact prior adjustments', (recalculateShipping, recalculateShippingPromotions, net, gross, applied) => {
    const retainedShipping = priceEditShippingCarriers({ sourceDigest: 'd'.repeat(64),
      basis: [{ sourceId: '11', amount: 100, includesTax: false, taxRateBps: 0 }], adjustments: { '11': -20 },
      carriers: [{ sourceId: '11', methodCode: 'POST', lineKeys: ['a'] }], final: [{ sourceId: '11', net: 80, gross: 80 }],
      lines: [{ key: 'a', quantity: 1 }], methods: [{ id: A, code: 'POST', calculator: { flat: 50, taxRate: 1000, taxInclusive: false } }],
      recalculateShipping: Boolean(recalculateShipping), recalculateShippingPromotions: Boolean(recalculateShippingPromotions),
      context: { subtotal: 100 }, defaultTaxRateBps: 0, defaultIncludesTax: false });
    const base = fixture({ lines: [line('a', { unitListPrice: 100 })], shipping: retainedShipping.lines.reduce((sum, line) => sum + line.net, 0), retainedShipping,
      promotions: [promo({ kind: 'free_shipping', value: 0 })], couponCodes: ['HALF'] });
    const candidate = priceOrderEditStack(request(base, true));
    expect(candidate.result).toMatchObject({ shippingTotal: net, grandTotal: 100 + Number(gross), taxTotal: Number(gross) - Number(net) });
    expect(candidate.result.applied.length > 0).toBe(applied);
    expect(candidate.input.retainedShipping!.carriers).toEqual([{ sourceId: '11', methodCode: 'POST', lineKeys: ['a'] }]);
  });

  it('retains per-carrier membership & signed adjustments through fallback, replacement & removal', () => {
    const input: Parameters<typeof priceEditShippingCarriers>[0] = { sourceDigest: 'e'.repeat(64),
      basis: [{ sourceId: '11', amount: 100, includesTax: false, taxRateBps: 0 }, { sourceId: '12', amount: 40, includesTax: false, taxRateBps: 0 }],
      adjustments: { '11': -20, '12': -5 }, carriers: [{ sourceId: '11', methodCode: 'OLD', lineKeys: ['a'] }, { sourceId: '12', methodCode: 'SECOND', lineKeys: ['b'] }],
      final: [{ sourceId: '11', net: 80, gross: 80 }, { sourceId: '12', net: 35, gross: 35 }],
      lines: [{ key: 'a', quantity: 1 }, { key: 'b', quantity: 1 }, { key: 'new', quantity: 1 }],
      methods: [{ id: A, code: 'OLD', calculator: { flat: 100, min: 1000 } }, { id: B, code: 'POST', calculator: { flat: 50, taxRate: 1000 } },
        { id: C, code: 'SECOND', calculator: { flat: 40, taxRate: 2000 } }],
      recalculateShipping: true, recalculateShippingPromotions: false, context: { subtotal: 100 }, defaultTaxRateBps: 0, defaultIncludesTax: false };
    const fallback = priceEditShippingCarriers(input);
    expect(fallback.carriers).toEqual([{ sourceId: '11', methodCode: 'SECOND', lineKeys: ['a'] }, { sourceId: '12', methodCode: 'SECOND', lineKeys: ['b'] }]);
    expect(fallback.lines).toEqual([{ sourceId: '11', net: 20, gross: 24 }, { sourceId: '12', net: 35, gross: 42 }]);
    const replacement = priceEditShippingCarriers({ ...input, selectedMethodCode: 'POST' });
    expect(replacement.carriers).toEqual([{ sourceId: '11', methodCode: 'POST', lineKeys: ['a', 'b', 'new'] }]);
    expect(replacement.lines).toEqual([{ sourceId: '11', net: 30, gross: 33 }]);
    const custom = priceEditShippingCarriers({ ...input, replacement: { kind: 'custom', amount: 70 }, defaultTaxRateBps: 1000 });
    expect(custom.lines).toEqual([{ sourceId: '11', net: 50, gross: 55 }]);
    expect(custom.carriers).toEqual([{ sourceId: '11', methodCode: null, lineKeys: ['a', 'b', 'new'] }]);
    const removed = priceEditShippingCarriers({ ...input, replacement: { kind: 'none' } });
    expect(removed).toMatchObject({ lines: [], carriers: [], repricedBasis: [] });
    expect(priceEditShippingCarriers({ ...input, basis: [], adjustments: {}, carriers: [], final: [], recalculateShipping: false }).lines).toEqual([]);
    expect(priceEditShippingCarriers({ ...input, basis: [], adjustments: {}, carriers: [], final: [] }).carriers).toEqual([]);
    expect(priceEditShippingCarriers({ ...input, lines: [{ key: 'a', quantity: 0 }, { key: 'b', quantity: 1 }] }).carriers).toEqual([{ sourceId: '12', methodCode: 'SECOND', lineKeys: ['b'] }]);
  });

  it('keeps signed historic shipping adjustments on a newly priced carrier & skips current shipping actions', () => {
    // New net list 10 plus retained source adjustment -20 gives net -10;
    // its own current 10% tax gives gross -11, independently of item tax.
    const retainedShipping = { sourceDigest: 'c'.repeat(64), mode: 'recalculate-keep-promotions' as const,
      lines: [{ sourceId: '11', net: -10, gross: -11 }],
      repricedBasis: [{ sourceId: '11', amount: 10, includesTax: false, taxRateBps: 1000 }] };
    const base = fixture({ lines: [line('a', { unitListPrice: 100 })], shipping: -10, retainedShipping,
      promotions: [promo({ kind: 'free_shipping', value: 0 })], couponCodes: ['HALF'] });
    const candidate = priceOrderEditStack(request(base, true));
    expect(candidate.result).toMatchObject({ shippingTotal: -10, taxTotal: -1, grandTotal: 89, retainedShippingFinal: retainedShipping.lines });
    expect(candidate.result.applied).toEqual([]);
    const changed = request(base); changed.pricing.retainedShipping!.repricedBasis![0]!.amount++;
    expect(priceOrderEditStack(changed).afterEconomicHash).not.toBe(candidate.afterEconomicHash);
    const missing = request(base); delete missing.pricing.retainedShipping!.repricedBasis;
    refusal(missing);
  });

  it('refuses every credit admission surface without inferring balances or eligibility', () => {
    const CREDIT = 'ORDER_EDIT_STACK_CREDIT_UNSUPPORTED';
    const cases: Array<(input: OrderEditStackInput) => void> = [
      input => { input.creditLedgerEvidence = [{ kind: 'RESERVE', status: 'VOID' }]; },
      input => { input.pricing.promotions[0]!.kind = 'account_credit'; },
      input => { input.pricing.promotions[0]!.credit = { accountId: ACCOUNT, availableCents: 0 }; },
      input => { input.pricing.promotions[0]!.conditions = [{ code: 'account_credit_eligible', args: [] }]; },
      input => { if ('input' in input.before.basis) input.before.basis.input.promotions[0]!.kind = 'account_credit'; },
      input => { if ('result' in input.before.basis) input.before.basis.result.applied[0]!.kind = 'account_credit'; },
      input => { if ('result' in input.before.basis) input.before.basis.result.selectedCredit = { accountId: ACCOUNT, promotionId: A, appliedAmount: 1, allocation: {} }; },
      input => { if ('result' in input.before.basis) input.before.basis.result.resolvedPromotions![0]!.credit = { accountId: ACCOUNT, availableCents: 0 }; },
    ];
    for (const mutate of cases) { const input = request(); mutate(input); refusal(input, CREDIT); }
    const creditInput = fixture({ lines: [line('a')], promotions: [promo({ id: A, kind: 'account_credit', value: 0, credit: { accountId: ACCOUNT, availableCents: 1 } })], couponCodes: ['HALF'] });
    refusal(request(creditInput, true), CREDIT);
    const missing = request(); delete (missing as Partial<OrderEditStackInput>).creditLedgerEvidence; refusal(missing);
  });
});
