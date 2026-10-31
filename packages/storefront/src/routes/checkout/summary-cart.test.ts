// @vitest-environment node
/**
 * L11: the checkout summary's display-only server read. One live GET per call (never a cached or shared result), a hard
 * timeout, null on any doubt; the client's LOCKED entry read and the PLACE ORDER quote gate stay as they are.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ServerCart } from '~/sellright/types/cart';
import { checkoutSummarySource, hasMixedPreOrder, readCheckoutServerCart, serverCartShipCountry, toDisplayCart } from './summary-cart';

const route = readFileSync(fileURLToPath(new URL('./index.tsx', import.meta.url)), 'utf8');

const serverCart = (over: Partial<ServerCart> = {}): ServerCart => ({
  token: 'tok_srv', revision: 4, status: 'active', currency: 'USD', subtotal: 5000, discountTotal: 0, shippingTotal: 800, taxTotal: 0,
  grandTotal: 5800, unavailable: [], coupon: null, couponCodes: [], coupons: [], pointsDiscount: 0, pricingIntent: 'checkout',
  quoteHash: 'qh1', shippingMethodCode: 'std', email: 'a@b.c', customerId: 'cus_1',
  lines: [{ sku: 'SKU1', name: 'Widget', quantity: 2, unitPrice: 2500, lineSubtotal: 5000, lineDiscount: 0, lineTotal: 5000, available: true, availableQuantity: 3, image: 'p/w.jpg' } as ServerCart['lines'][number]],
  ...over,
} as ServerCart);

describe('serverCartShipCountry', () => {
  it('uses a valid country cookie, else the client default', () => {
    expect(serverCartShipCountry('de')).toBe('DE');
    expect(serverCartShipCountry(undefined)).toBe('US');
    expect(serverCartShipCountry('')).toBe('US');
    expect(serverCartShipCountry('USA')).toBe('US');
    expect(serverCartShipCountry('<x>')).toBe('US');
  });
});

describe('toDisplayCart', () => {
  it('keeps the amounts and lines, drops identity fields, resolves images', () => {
    const cart = toDisplayCart(serverCart(), 'tok_srv')!;
    expect(cart.grandTotal).toBe(5800);
    expect(cart.quoteHash).toBe('qh1');
    expect(cart.lines[0].image).toBe('/assets/p/w.jpg');
    expect(cart.token).toBe('');
    expect(cart.email).toBeNull();
    expect(cart.customerId).toBeNull();
  });

  it('refuses another cart, a non-active cart, a non-checkout quote and an empty cart', () => {
    expect(toDisplayCart(serverCart(), 'tok_other')).toBeNull();
    expect(toDisplayCart(serverCart({ status: 'converted' } as Partial<ServerCart>), 'tok_srv')).toBeNull();
    expect(toDisplayCart(serverCart({ pricingIntent: 'preview' }), 'tok_srv')).toBeNull();
    expect(toDisplayCart(serverCart({ lines: [] }), 'tok_srv')).toBeNull();
    expect(toDisplayCart(undefined, 'tok_srv')).toBeNull();
  });
});

describe('readCheckoutServerCart', () => {
  it('makes no request without a token', async () => {
    const get = vi.fn();
    expect(await readCheckoutServerCart(get, undefined, 'US')).toBeNull();
    expect(await readCheckoutServerCart(get, '', 'US')).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('reads the checkout quote live on every call (no reuse)', async () => {
    const get = vi.fn(async () => ({ data: serverCart() }));
    const a = await readCheckoutServerCart(get, 'tok_srv', 'US');
    const b = await readCheckoutServerCart(get, 'tok_srv', 'US');
    expect(a?.grandTotal).toBe(5800);
    expect(b?.grandTotal).toBe(5800);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledWith('/v1/shop/cart/{token}', expect.objectContaining({
      params: { path: { token: 'tok_srv' }, query: { pricingIntent: 'checkout', shipCountry: 'US' } },
    }));
  });

  it('is null on an error or an empty body', async () => {
    expect(await readCheckoutServerCart(async () => { throw new Error('500'); }, 'tok_srv', 'US')).toBeNull();
    expect(await readCheckoutServerCart(async () => ({}), 'tok_srv', 'US')).toBeNull();
  });

  it('is null past the timeout, and aborts the request', async () => {
    let signal: AbortSignal | undefined;
    const get = vi.fn((_p: string, init: { signal: AbortSignal }) => {
      signal = init.signal;
      return new Promise<{ data?: ServerCart }>(() => { /* never settles, ignores the abort */ });
    });
    const started = Date.now();
    expect(await readCheckoutServerCart(get, 'tok_srv', 'US', 30)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(signal?.aborted).toBe(true);
  });
});

describe('checkoutSummarySource', () => {
  const active = { status: 'active', lineCount: 2 };
  const empty = { status: 'active', lineCount: 0 };
  it('after loading always shows the client cart', () => {
    expect(checkoutSummarySource({ pageLoading: false, entryReadDone: true, client: empty, hasServerCart: true })).toBe('client');
    expect(checkoutSummarySource({ pageLoading: false, entryReadDone: false, client: empty, hasServerCart: false })).toBe('client');
  });
  it('before the entry read lands shows the server read, else the skeleton', () => {
    expect(checkoutSummarySource({ pageLoading: true, entryReadDone: false, client: empty, hasServerCart: true })).toBe('server');
    expect(checkoutSummarySource({ pageLoading: true, entryReadDone: false, client: active, hasServerCart: false })).toBe('skeleton');
  });
  it('once the entry read lands the client read replaces the server read', () => {
    expect(checkoutSummarySource({ pageLoading: true, entryReadDone: true, client: active, hasServerCart: true })).toBe('client');
    expect(checkoutSummarySource({ pageLoading: true, entryReadDone: true, client: empty, hasServerCart: true })).toBe('skeleton');
    expect(checkoutSummarySource({ pageLoading: true, entryReadDone: true, client: { status: 'converted', lineCount: 2 }, hasServerCart: true })).toBe('skeleton');
  });
  it('#412 shell: the live entry read fills the summary as soon as it lands; nothing else ever does', () => {
    expect(checkoutSummarySource({ pageLoading: true, entryReadDone: false, client: empty, hasServerCart: false, shell: true })).toBe('skeleton');
    expect(checkoutSummarySource({ pageLoading: true, entryReadDone: false, client: active, hasServerCart: false, shell: true })).toBe('client');
    expect(checkoutSummarySource({ pageLoading: true, entryReadDone: false, client: { status: 'converted', lineCount: 2 }, hasServerCart: false, shell: true })).toBe('skeleton');
  });
});

describe('hasMixedPreOrder', () => {
  it('needs both a pre-order and a regular line', () => {
    expect(hasMixedPreOrder([{ isPreOrder: true }, { isPreOrder: false }])).toBe(true);
    expect(hasMixedPreOrder([{ isPreOrder: true }])).toBe(false);
    expect(hasMixedPreOrder([{}])).toBe(false);
  });
});

describe('checkout route wiring', () => {
  it('the loader is never cached and skips client loader fetches', () => {
    const loader = route.slice(route.indexOf('export const useCheckoutServerCart'), route.indexOf('interface CheckoutState'));
    expect(loader).toContain("sharedMap.has('@loaderId')");
    expect(loader).not.toMatch(/cacheKey|eTag/);
  });
  it('the server read never reaches the cart mirror', () => {
    expect(route).not.toMatch(/serverCart\.value[^\n]*(localCart|CartService)/);
    expect(route).not.toMatch(/localCart\.cart\s*=/);
  });
  it('the LOCKED entry read and the PLACE ORDER quote gate are unchanged', () => {
    expect(route).toMatch(/const read = await refreshCartLive\(localCart\);\n\s*if \(!current\(\)\) return;\n\s*entryReadDone\.value = true;/);
    expect(route).toContain("if (localCart.cart.pricingIntent !== 'checkout') {");
    expect(route).toMatch(/refreshStock: \(\) => refreshCartStock\(localCart\)/);
  });
  it('#412: one cart GET and one session GET at entry, and no network read holds back the summary\'s re-render', () => {
    // The pricing task leaves the read to the entry until it lands (the entry re-reads when the inputs moved meanwhile).
    const pricing = route.slice(route.indexOf("CartService.setQuoteContext({ pricingIntent: 'checkout'"), route.indexOf('useVisibleTask$(({ cleanup })'));
    expect(pricing.indexOf('if (!untrack(() => entryReadDone.value)) return;')).toBeGreaterThan(-1);
    expect(pricing.indexOf('if (!untrack(() => entryReadDone.value)) return;')).toBeLessThan(pricing.indexOf('CartService.refresh()'));
    expect(pricing).toMatch(/void \(async \(\) => \{\n\s*try \{\n\s*await CartService\.refresh\(\);/);
    // The shipping quote is not awaited by its task either.
    expect(route).toMatch(/void \(async \(\) => \{\n\s*try \{\n[^\n]*\n\s*const quote = await getShippingQuote/);
    // The entry read's own shipping quote is taken first; the POST runs only without one.
    expect(route.indexOf('CartService.takeShippingQuote(countryCode)')).toBeGreaterThan(-1);
    expect(route.indexOf('CartService.takeShippingQuote(countryCode)')).toBeLessThan(route.indexOf('await getShippingQuote'));
    // Identity: the layout's session read for this page, never a second GET /api/session/.
    expect(route).toContain('await pageSessionCustomer()');
    expect(route).not.toContain('fetchSessionCustomer');
    // The shell's qinit starts (or joins) the document-start entry read; it never defers to a later one.
    expect(route).toContain('startCheckoutEntryBoot(location.pathname)');
  });
});
