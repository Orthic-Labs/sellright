import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { CartService, parseLegacyCartSnapshot } from './CartService';
import { CountryPreferenceService } from './CountryPreferenceService';
import { installLocks, removeLocks } from './cart-test-harness';

const build = vi.hoisted(() => ({ isDemo: false }));
vi.mock('~/theme/theme.config', () => ({ theme: build }));

const CLAIM = '33333333-3333-4333-8333-333333333333';
const raw = JSON.stringify({ items: [{ productVariantId: 17, quantity: 2, salePrice: 1, lastStockCheck: Date.now() }],
  subTotal: 1, totalQuantity: 99, currencyCode: 'USD', countryCode: 'CA', countryExplicitlySet: true,
  appliedCoupon: { code: 'SAVE', discountAmount: 999999 } });
const cart = { token: 'migrated', revision: 1, status: 'active', email: null, customerId: null, currency: 'USD',
  lines: [{ sku: 'REAL-SKU', name: 'Current', quantity: 2, unitPrice: 1000, lineSubtotal: 2000, lineDiscount: 0, lineTotal: 2000, available: true, availableQuantity: 3 }],
  unavailable: [], coupon: { code: 'SAVE', applied: false }, subtotal: 2000, discountTotal: 0, shippingTotal: 0, taxTotal: 0, grandTotal: 2000 };
const response = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
let requests: Array<{ path: string; body: Record<string, unknown> }>;
beforeEach(() => {
  installLocks();
  localStorage.clear();
  for (const name of ['sr_cart', 'authToken', 'sr_legacy_cart']) document.cookie = `${name}=; Path=/; Max-Age=0`;
  build.isDemo = false;
  CartService['resetMirror']();
  requests = [];
  vi.stubGlobal('crypto', { subtle: webcrypto.subtle, randomUUID: () => CLAIM });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); removeLocks(); });

function mockTransfer(behavior: (body: Record<string, unknown>) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ path, body });
    if (path.endsWith('/auth/me')) return response(401, {});
    if (path.endsWith('/legacy-migration')) return behavior(body);
    return response(200, cart);
  }));
}

describe('legacy browser snapshot', () => {
  it('ports only numeric variant IDs, quantities, coupon code & country intent', () => {
    expect(parseLegacyCartSnapshot(raw)).toEqual({ items: [{ variantId: '17', quantity: 2 }], couponCode: 'SAVE', countryCode: 'CA', countryExplicit: true });
    expect(() => parseLegacyCartSnapshot(JSON.stringify({ items: [{ productVariantId: 'SKU17', quantity: 1 }] }))).toThrow();
    expect(() => parseLegacyCartSnapshot(JSON.stringify({ items: [{ productVariantId: '17', quantity: 1.5 }] }))).toThrow();
  });
  it('recovers original country selection before blob transfer', () => {
    localStorage.setItem('vendure_local_cart', raw);
    expect(CountryPreferenceService.getCountry()).toBe('CA');
    expect(CountryPreferenceService.hasExplicitCountrySelection()).toBe(true);
  });
  it('retains blob & stable claim across lost response, then removes after receipt', async () => {
    localStorage.setItem('vendure_local_cart', raw);
    let attempts = 0;
    mockTransfer(body => {
      expect(body).toEqual({ claimId: CLAIM, items: [{ variantId: '17', quantity: 2 }], couponCode: 'SAVE', countryCode: 'CA' });
      if (attempts++ === 0) throw new TypeError('response lost');
      return response(200, { receipt: CLAIM, cart, couponCode: 'SAVE', countryCode: 'CA', unresolved: [] });
    });
    await expect(CartService.bootstrap()).rejects.toThrow('response lost');
    expect(localStorage.getItem('vendure_local_cart')).toBe(raw);
    const claimBefore = localStorage.getItem('sr_legacy_cart_claim');
    const result = await CartService.bootstrap();
    expect(localStorage.getItem('sr_legacy_cart_claim')).toBe(claimBefore);
    expect(localStorage.getItem('vendure_local_cart')).toBeNull();
    expect(result.cart.lines[0].sku).toBe('REAL-SKU');
    expect(requests.filter(r => r.path.endsWith('/legacy-migration'))).toHaveLength(2);
  });
  it('retains a newer legacy blob written while migration request was pending', async () => {
    localStorage.setItem('vendure_local_cart', raw);
    const newer = JSON.stringify({ items: [{ productVariantId: '17', quantity: 3 }] });
    mockTransfer(() => {
      localStorage.setItem('vendure_local_cart', newer);
      return response(200, { receipt: CLAIM, cart, couponCode: null, countryCode: null, unresolved: [] });
    });
    await CartService.bootstrap();
    expect(localStorage.getItem('vendure_local_cart')).toBe(newer);
  });
  it('completes source-only bootstrap from SSR transport marker before returning cart snapshot', async () => {
    document.cookie = 'sr_legacy_cart=1; Path=/';
    mockTransfer(body => {
      expect(body.items).toBeNull();
      return response(200, { receipt: CLAIM, cart, couponCode: null, countryCode: null, unresolved: [] });
    });
    expect((await CartService.bootstrap()).cart.lines).toHaveLength(1);
    expect(requests.map(r => r.path).slice(0, 2)).toEqual(['/v1/shop/auth/me', '/v1/shop/cart/legacy-migration']);
    expect(document.cookie).not.toContain('sr_legacy_cart=1');
  });
});

describe('ordinary native bootstrap', () => {
  it('does not request auth or migration for a normal empty cart', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('unexpected closed endpoint'); }));
    expect((await CartService.bootstrap()).cart.lines).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves native read fallback without Web Locks, auth or migration', async () => {
    removeLocks();
    document.cookie = 'sr_cart=migrated; Path=/';
    mockTransfer(() => { throw new Error('unexpected migration'); });
    expect((await CartService.bootstrap()).cart.lines).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toContain('/v1/shop/cart/migrated');
  });
  it('keeps native reads available when browser storage is disabled', async () => {
    removeLocks();
    document.cookie = 'sr_cart=migrated; Path=/';
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage disabled'); });
    mockTransfer(() => { throw new Error('unexpected migration'); });
    expect((await CartService.bootstrap()).cart.lines).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });
  it('keeps migration dependent writes fail closed without Web Locks & preserves blob', async () => {
    removeLocks();
    localStorage.setItem('vendure_local_cart', raw);
    vi.stubGlobal('fetch', vi.fn());
    await expect(CartService.bootstrap()).rejects.toThrow('Please update your browser');
    expect(localStorage.getItem('vendure_local_cart')).toBe(raw);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps isolated demo usable when auth & migration are forbidden, even with legacy transport present', async () => {
    build.isDemo = true;
    removeLocks();
    document.cookie = 'authToken=legacy; Path=/';
    document.cookie = 'sr_legacy_cart=1; Path=/';
    document.cookie = 'sr_cart=migrated; Path=/';
    localStorage.setItem('vendure_local_cart', raw);
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const path = String(input);
      requests.push({ path, body: {} });
      return path.includes('/auth/') || path.endsWith('/legacy-migration') ? response(403, {}) : response(200, cart);
    }));
    expect((await CartService.bootstrap()).cart.lines).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toContain('/v1/shop/cart/migrated');
    expect(localStorage.getItem('vendure_local_cart')).toBe(raw);
  });
  it('preserves local snapshot when receipt refers to a retired cart', async () => {
    localStorage.setItem('vendure_local_cart', raw);
    mockTransfer(() => response(200, { receipt: CLAIM, cart: null, couponCode: null, countryCode: null, unresolved: [] }));
    await expect(CartService.bootstrap()).rejects.toThrow('no confirmed receipt');
    expect(localStorage.getItem('vendure_local_cart')).toBe(raw);
  });
});
