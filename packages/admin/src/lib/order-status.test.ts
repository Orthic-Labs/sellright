import { describe, expect, it } from 'vitest';
import { ALL_ORDERS, BUILTIN_VIEWS, DEFAULT_ORDER_STATUS, EMPTY_FILTERS, apiOrderStatus, FULFILLMENT_OPTIONS, PAYMENT_OPTIONS, customerLabel, filtersFromParams, filtersToApiQuery, filtersToExportQuery, filtersToParams, orderDef, paymentDef, sameFilters } from './order-status';

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
    const p = filtersToParams({ ...EMPTY_FILTERS, paymentStatus: 'paid', from: '2026-09-01', preOrder: true, excludeDemo: true });
    expect(filtersFromParams(p)).toEqual({ ...EMPTY_FILTERS, paymentStatus: 'paid', from: '2026-09-01', preOrder: true, excludeDemo: true });
    expect(filtersFromParams(new URLSearchParams('excludeDemo=0')).excludeDemo).toBe(false);
    expect(filtersFromParams(new URLSearchParams('paymentStatus=voided&from=yesterday')).paymentStatus).toBe('');
    expect(filtersFromParams(new URLSearchParams('from=yesterday')).from).toBe('');
  });
  it('maps archived to trashed for the list and export APIs', () => {
    const f = { ...EMPTY_FILTERS, status: 'archived' };
    expect(filtersToApiQuery(f, 2).get('trashed')).toBe('1');
    expect(filtersToApiQuery(f, 2).has('status')).toBe(false);
    expect(filtersToExportQuery(f).get('trashed')).toBe('1');
    expect(filtersToApiQuery({ ...EMPTY_FILTERS, status: 'active' }, 1).get('status')).toBe('active');
    expect(filtersToApiQuery({ ...EMPTY_FILTERS, excludeDemo: true }, 2).get('excludeDemo')).toBe('1');
    expect(filtersToExportQuery({ ...EMPTY_FILTERS, excludeDemo: true }).get('excludeDemo')).toBe('1');
  });
  it('built-in views are mutually distinguishable', () => {
    const matches = (f: typeof EMPTY_FILTERS) => BUILTIN_VIEWS.filter((v) => sameFilters(f, v.filters)).map((v) => v.id);
    expect(matches(EMPTY_FILTERS)).toEqual(['orders']);
    expect(matches({ ...EMPTY_FILTERS, status: ALL_ORDERS })).toEqual(['all']);
    expect(matches({ ...EMPTY_FILTERS, status: 'open' })).toEqual(['unpaid']);
    expect(matches({ ...EMPTY_FILTERS, status: 'cancelled' })).toEqual(['cancelled']);
    expect(matches({ ...EMPTY_FILTERS, paymentStatus: 'paid', fulfillmentStatus: 'unfulfilled', status: 'active', excludeDemo: true })).toEqual(['unfulfilled']);
  });
  it('shows name over email when a name exists', () => {
    expect(customerLabel({ firstName: 'Ada', lastName: 'B', email: 'a@x.co' })).toEqual({ name: 'Ada B', email: 'a@x.co' });
    expect(customerLabel({ email: 'a@x.co' }).name).toBeNull();
    // #374: the API's resolved name (a guest's checkout name) is shown when there is no linked customer.
    expect(customerLabel({ customerName: 'Gus Guest', email: 'g@x.co' })).toEqual({ name: 'Gus Guest', email: 'g@x.co' });
  });
  it('opens on paid orders by default; status=all lifts the filter (#374)', () => {
    expect(EMPTY_FILTERS.status).toBe(DEFAULT_ORDER_STATUS);
    expect(filtersFromParams(new URLSearchParams('')).status).toBe('completed');
    expect(filtersToParams(EMPTY_FILTERS).has('status')).toBe(false); // the default keeps a clean URL
    expect(filtersToApiQuery(EMPTY_FILTERS, 1).get('status')).toBe('completed');
    expect(filtersFromParams(new URLSearchParams('status=all')).status).toBe(ALL_ORDERS);
    expect(filtersToParams({ ...EMPTY_FILTERS, status: ALL_ORDERS }).get('status')).toBe('all');
    expect(filtersToApiQuery({ ...EMPTY_FILTERS, status: ALL_ORDERS }, 1).has('status')).toBe(false);
    expect(filtersToExportQuery({ ...EMPTY_FILTERS, status: ALL_ORDERS }).has('status')).toBe(false);
    expect(filtersToApiQuery({ ...EMPTY_FILTERS, status: 'open' }, 1).get('status')).toBe('open');
    // A view saved before #374 (empty status) means every order, never the API's invalid ''.
    expect(filtersToParams({ ...EMPTY_FILTERS, status: '' }).get('status')).toBe('all');
    expect(apiOrderStatus('')).toBe('');
    expect(filtersFromParams(new URLSearchParams('status=bogus')).status).toBe('completed');
  });
});
