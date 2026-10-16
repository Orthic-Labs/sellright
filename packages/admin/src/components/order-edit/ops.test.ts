import { describe, expect, it } from 'vitest';
import { addressToWire, addressValid, buildOps, parseCents, storedToForm } from './ops';
import { emptyStaged, type EditContext } from './types';

const ctx = {
  lines: [
    { id: 'l1', sku: 'A', name: 'A', quantity: 3, unitPrice: 1000, lineTotal: 3000, fulfilledQty: 1, refundedQty: 0, minQuantity: 1 },
    { id: 'l2', sku: 'B', name: 'B', quantity: 1, unitPrice: 2000, lineTotal: 2000, fulfilledQty: 0, refundedQty: 0, minQuantity: 0 },
  ],
} as unknown as EditContext;

describe('parseCents', () => {
  it('parses money strings to integer cents', () => {
    expect(parseCents('12.5')).toBe(1250);
    expect(parseCents('-3')).toBe(-300);
    expect(parseCents('$0.07')).toBe(7);
    expect(parseCents('1.234')).toBeNull();
    expect(parseCents('abc')).toBeNull();
    expect(parseCents('')).toBeNull();
  });
});

describe('buildOps', () => {
  it('emits nothing for an untouched session', () => {
    expect(buildOps(ctx, emptyStaged())).toEqual([]);
  });
  it('only emits quantity ops for changed lines, in a stable order', () => {
    const st = emptyStaged();
    st.qty = { l1: 1, l2: 1 };
    st.swaps = { l2: { sku: 'C', name: 'C' } };
    st.adds = [{ sku: 'D', name: 'D', quantity: 2 }, { sku: 'E', name: 'E', quantity: 0 }];
    st.coupon = { mode: 'apply', code: ' TEN ' };
    st.shipping = { mode: 'custom', code: '', amountCents: 250 };
    st.adjAdd = [{ label: ' Goodwill ', amountCents: -500 }, { label: '', amountCents: 5 }];
    st.adjRemove = ['adj1'];
    expect(buildOps(ctx, st)).toEqual([
      { op: 'set_quantity', lineId: 'l1', quantity: 1 },
      { op: 'swap_variant', lineId: 'l2', sku: 'C' },
      { op: 'add_item', sku: 'D', quantity: 2 },
      { op: 'apply_coupon', code: 'TEN' },
      { op: 'set_shipping_amount', amount: 250 },
      { op: 'remove_adjustment', adjustmentId: 'adj1' },
      { op: 'add_adjustment', label: 'Goodwill', amount: -500 },
    ]);
  });
  it('shipping removal, coupon removal and address ops', () => {
    const st = emptyStaged();
    st.coupon = { mode: 'remove', code: '' };
    st.shipping = { mode: 'none', code: '', amountCents: 0 };
    st.address = { saveToAddressBook: true, shipping: { fullName: '', line1: ' 1 A St ', line2: '', city: 'X', province: '', postalCode: '', country: 'ca', phone: '' } };
    expect(buildOps(ctx, st)).toEqual([
      { op: 'remove_coupon' }, { op: 'remove_shipping' },
      { op: 'set_address', kind: 'shipping', address: { fullName: undefined, line1: '1 A St', line2: undefined, city: 'X', province: undefined, postalCode: undefined, country: 'CA', phone: undefined }, saveToAddressBook: true },
    ]);
  });
});

describe('address helpers', () => {
  it('reads legacy Vendure-ish keys and validates required fields', () => {
    const f = storedToForm({ firstName: 'x', streetLine1: '1 Main', city: 'Austin', countryCode: 'us', zip: '78701' });
    expect(f).toMatchObject({ line1: '1 Main', city: 'Austin', country: 'US', postalCode: '78701' });
    expect(addressValid(f)).toBe(true);
    expect(addressValid({ ...f, country: 'USA' })).toBe(false);
    expect(addressValid({ ...f, line1: ' ' })).toBe(false);
    expect(addressToWire({ ...f, line2: ' ' }).line2).toBeUndefined();
  });
});
