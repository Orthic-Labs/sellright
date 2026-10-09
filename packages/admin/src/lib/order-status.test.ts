import { describe, expect, it } from 'vitest';
import { BUILTIN_VIEWS, EMPTY_FILTERS, FULFILLMENT_OPTIONS, PAYMENT_OPTIONS, customerLabel, filtersFromParams, filtersToApiQuery, filtersToExportQuery, filtersToParams, orderDef, paymentDef, sameFilters } from './order-status';

describe('owner-facing statuses', () => {
  it('never offers authorized or voided as filters', () => {
    expect(PAYMENT_OPTIONS.map((o) => o.value)).toEqual(['pending', 'paid', 'balance_due', 'partially_refunded', 'refunded', 'failed']);
    expect(FULFILLMENT_OPTIONS.map((o) => o.value)).not.toContain('partially_delivered');
  });
  it('labels internal values in plain words', () => {
    expect(paymentDef('partially_refunded').label).toBe('Partially refunded');
    expect(orderDef('completed').label).toBe('Open');
    expect(orderDef('open').label).toBe('Open');
  });
});

describe('filters <-> URL', () => {
  it('round-trips and drops invalid values', () => {
    const p = filtersToParams({ ...EMPTY_FILTERS, paymentStatus: 'paid', from: '2026-09-01', preOrder: true });
    expect(filtersFromParams(p)).toEqual({ ...EMPTY_FILTERS, paymentStatus: 'paid', from: '2026-09-01', preOrder: true });
    expect(filtersFromParams(new URLSearchParams('paymentStatus=voided&from=yesterday')).paymentStatus).toBe('');
    expect(filtersFromParams(new URLSearchParams('from=yesterday')).from).toBe('');
  });
  it('maps archived to trashed for the list and export APIs', () => {
    const f = { ...EMPTY_FILTERS, status: 'archived' };
    expect(filtersToApiQuery(f, 2).get('trashed')).toBe('1');
    expect(filtersToApiQuery(f, 2).has('status')).toBe(false);
    expect(filtersToExportQuery(f).get('trashed')).toBe('1');
    expect(filtersToApiQuery({ ...EMPTY_FILTERS, status: 'active' }, 1).get('status')).toBe('active');
  });
  it('built-in views are mutually distinguishable', () => {
    const matches = (f: typeof EMPTY_FILTERS) => BUILTIN_VIEWS.filter((v) => sameFilters(f, v.filters)).map((v) => v.id);
    expect(matches(EMPTY_FILTERS)).toEqual(['all']);
    expect(matches({ ...EMPTY_FILTERS, status: 'cancelled' })).toEqual(['cancelled']);
    expect(matches({ ...EMPTY_FILTERS, paymentStatus: 'paid', fulfillmentStatus: 'unfulfilled', status: 'active' })).toEqual(['unfulfilled']);
  });
  it('shows name over email when a name exists', () => {
    expect(customerLabel({ firstName: 'Ada', lastName: 'B', email: 'a@x.co' })).toEqual({ name: 'Ada B', email: 'a@x.co' });
    expect(customerLabel({ email: 'a@x.co' }).name).toBeNull();
  });
});
