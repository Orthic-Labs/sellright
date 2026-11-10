import { describe, expect, it } from 'vitest';
import type { ProductDetail, VariantRow } from '../../api';
import { availableOf, backorderError, buildPlan, effective, shipsNowOf, variantErrors } from './model';

const v = (o: Partial<VariantRow> = {}): VariantRow => ({ id: 'v1', sku: 'S', name: 'N', price: 1000, salePrice: null, enabled: true, onHand: 2, allocated: 3, available: 4, incoming: 5, backorderLabel: 'Ships in 3 weeks', ...o });
const prod = (variant = v()) => ({ id: 'p', slug: 'p', name: 'P', description: null, status: 'active', assetPath: null, featuredAssetId: null, images: [], variants: [variant] }) as ProductDetail;

describe('#446 variant stock numbers', () => {
  it('sellable counts incoming; ships now never goes below 0', () => {
    const p = prod();
    expect(availableOf(p, {}, p.variants[0]!)).toBe(4);
    expect(shipsNowOf(p, {}, p.variants[0]!)).toBe(0);
    expect(availableOf(p, { 'v1.inc': '7', 'v1.oh': '4' }, p.variants[0]!)).toBe(8);
    expect(shipsNowOf(p, { 'v1.oh': '4' }, p.variants[0]!)).toBe(1);
  });
  it('an older API without incoming behaves as 0', () => {
    const p = prod(v({ incoming: undefined, backorderLabel: undefined }));
    expect(availableOf(p, {}, p.variants[0]!)).toBe(-1);
  });
});

describe('#446 validation', () => {
  it('needs a whole number and, above 0, a label', () => {
    const p = prod(v({ incoming: 0, backorderLabel: null }));
    const x = p.variants[0]!;
    expect(variantErrors(p, effective(p, { 'v1.inc': 'x' }), x).inc).toBeTruthy();
    expect(variantErrors(p, effective(p, { 'v1.inc': '4' }), x).bo).toContain('Ships in 3 weeks');
    expect(variantErrors(p, effective(p, { 'v1.inc': '4', 'v1.bo': ' Soon ' }), x)).toEqual({});
    expect(variantErrors(p, effective(p, { 'v1.inc': '0' }), x)).toEqual({});
  });
  it('clearing the label while incoming stays above 0 is an error', () => {
    const p = prod();
    expect(variantErrors(p, effective(p, { 'v1.bo': '' }), p.variants[0]!).bo).toBeTruthy();
  });
  it('an untouched legacy variant never errors', () => {
    const p = prod(v({ backorderLabel: null }));
    expect(variantErrors(p, {}, p.variants[0]!)).toEqual({});
  });
});

describe('#446 save plan', () => {
  it('incoming edit goes to the incoming route with the label; label-only goes in the variant patch', () => {
    const p = prod();
    expect(buildPlan(p, effective(p, { 'v1.inc': '9', 'v1.bo': ' Soon ' })).variants[0]).toMatchObject({ incoming: { incoming: 9, backorderLabel: 'Soon' }, patch: {} });
    const label = buildPlan(p, effective(p, { 'v1.bo': 'Later' })).variants[0]!;
    expect(label.incoming).toBeUndefined();
    expect(label.patch).toEqual({ backorderLabel: 'Later' });
  });
  it('setting incoming to 0 sends a null label when the field is empty', () => {
    const p = prod();
    expect(buildPlan(p, effective(p, { 'v1.inc': '0', 'v1.bo': '' })).variants[0]!.incoming).toEqual({ incoming: 0, backorderLabel: null });
  });
});

describe('#446 error copy', () => {
  it.each([
    ['BACKORDER_LABEL_REQUIRED', {}, 'Add what customers see'],
    ['INCOMING_BELOW_SOLD', { minIncoming: 4 }, "Incoming can't be below 4."],
    ['BACKORDER_UNSUPPORTED', {}, 'Only physical products'],
    ['INCOMING_CHANGED', {}, 'Incoming stock changed'],
    ['RECEIVE_EXCEEDS_INCOMING', {}, "can't receive more than is incoming"],
  ])('%s', (code, body, want) => { expect(backorderError({ code, message: 'server', body })).toContain(want); });
  it('keeps the server message for other errors (INSUFFICIENT_ON_HAND names the SKU)', () => {
    expect(backorderError({ code: 'INSUFFICIENT_ON_HAND', message: 'cannot ship 3 x A-1: only 1 on hand' })).toBe('cannot ship 3 x A-1: only 1 on hand');
  });
});
