import { describe, expect, it } from 'vitest';
import { __qaDebug, maybeMock } from './qa-mocks.js';

describe('maybeMock — gating', () => {
  function withQaLocation<T>(fn: () => T): T {
    const g = globalThis as typeof globalThis & { __qaOverride?: boolean | null; location?: { search: string } };
    const prevOverride = g.__qaOverride;
    const prevLocation = g.location;
    g.__qaOverride = true;
    Object.defineProperty(g, 'location', { value: { search: '?qa=1&scenario=sparse' }, configurable: true });
    try { return fn(); }
    finally {
      g.__qaOverride = prevOverride;
      if (prevLocation) Object.defineProperty(g, 'location', { value: prevLocation, configurable: true });
      else Reflect.deleteProperty(g, 'location');
    }
  }

  it('returns null for unrecognised GET paths (passthrough)', () => {
    const out = maybeMock('/unknown-endpoint', new URLSearchParams('qa=1'));
    expect(out).toBeNull();
  });

  it('always passes through POST/PUT/DELETE/PATCH (mutations never mocked)', () => {
    expect(maybeMock('/staff/a1/permissions', new URLSearchParams('qa=1'), { method: 'PUT' })).toBeNull();
    expect(maybeMock('/orders/ORD-1/fulfill', new URLSearchParams('qa=1'), { method: 'POST' })).toBeNull();
    expect(maybeMock('/products/p1', new URLSearchParams('qa=1'), { method: 'PATCH' })).toBeNull();
  });

  it('matches normalised query endpoints when QA mode is enabled', () => withQaLocation(() => {
    expect(maybeMock('/me', new URLSearchParams(), { method: 'GET' })?.data).toHaveProperty('stores');
    expect(maybeMock('/inventory', new URLSearchParams('q=long'), { method: 'GET' })?.data).toHaveProperty('items');
    expect(maybeMock('/reports/sales', new URLSearchParams('days=30'), { method: 'GET' })?.data).toHaveProperty('series');
    expect(maybeMock('/customers', new URLSearchParams('page=1'), { method: 'GET' })?.data).toHaveProperty('items');
  }));
});

describe('__qaDebug — generator shapes', () => {
  it('qaEnabled returns a boolean regardless of env', () => {
    expect(__qaDebug.qaEnabled()).toBeTypeOf('boolean');
  });

  it('orders dense scenario returns a paginated page with rows + total', () => {
    const p = __qaDebug.makeOrders(40, 'dense');
    expect(p.items.length).toBe(40);
    expect(p.total).toBeGreaterThanOrEqual(p.items.length);
    expect(p.items[0]?.code).toMatch(/^ORD-/);
  });

  it('orders empty scenario returns zero items', () => {
    expect(__qaDebug.makeOrders(0, 'empty').items).toEqual([]);
  });

  it('orders preorders scenario flags isPreOrder on every row', () => {
    const p = __qaDebug.makeOrders(10, 'preorders');
    expect(p.items.every((o) => o.isPreOrder === true)).toBe(true);
  });

  it('orders error scenario throws so the page surfaces the error state', () => {
    expect(() => __qaDebug.makeOrders(1, 'error')).toThrow(/mock/);
  });

  it('products mixed scenario includes drafts and long names', () => {
    const p = __qaDebug.makeProducts(30, 'mixed');
    expect(p.items.some((x) => x.status === 'draft')).toBe(true);
    expect(p.items.some((x) => x.name.length > 40)).toBe(true);
  });

  it('products empty + error scenarios match the page empty/error paths', () => {
    expect(__qaDebug.makeProducts(0, 'empty').items).toEqual([]);
    expect(() => __qaDebug.makeProducts(1, 'error')).toThrow(/mock/);
  });

  it('inventory returns 40 rows with mixed on-hand values', () => {
    const p = __qaDebug.makeInventory();
    expect(p.items.length).toBe(40);
    expect(p.items.some((r) => r.onHand === 0)).toBe(true);
    expect(p.items.some((r) => r.onHand > 0)).toBe(true);
  });

  it('customers returns 20 rows with mixed lifetime spend', () => {
    const p = __qaDebug.makeCustomers();
    expect(p.items.length).toBe(20);
    expect(p.items.every((c) => typeof c.email === 'string' && c.email.length > 0)).toBe(true);
  });

  it('order detail returns a fully-populated OrderDetail', () => {
    const o = __qaDebug.makeOrderDetail('ORD-TEST');
    expect(o.code).toBe('ORD-TEST');
    expect(o.lines.length).toBeGreaterThan(0);
    expect(o.payments.length).toBeGreaterThan(0);
    expect(o.events.length).toBeGreaterThan(0);
  });

  it('product detail returns variants and a gallery for layout testing', () => {
    const pd = __qaDebug.makeProductDetail();
    expect(pd.variants.length).toBeGreaterThan(0);
    expect(pd.images.length).toBeGreaterThan(0);
  });

  it('dashboard fresh scenario is empty; active is populated', () => {
    const fresh = __qaDebug.makeDashboard('fresh');
    expect(fresh.orders).toBe(0);
    expect(fresh.recentOrders).toEqual([]);
    const active = __qaDebug.makeDashboard('active');
    expect(active.orders).toBeGreaterThan(0);
    expect(active.recentOrders.length).toBeGreaterThan(0);
  });

  it('sales series zero/sparse/real map to empty/sparse/full bars', () => {
    expect(__qaDebug.makeSalesSeries('zero').series.length).toBe(0);
    expect(__qaDebug.makeSalesSeries('sparse').series.length).toBe(30);
    expect(__qaDebug.makeSalesSeries('real').series.length).toBe(30);
  });
});
