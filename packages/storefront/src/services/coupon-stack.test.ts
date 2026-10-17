import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto, randomUUID } from 'node:crypto';
import { CartService, couponMembership, parseLegacyCartSnapshot } from './CartService';
import { installLocks, removeLocks } from './cart-test-harness';
import { placeOrder, QuoteChangedError } from '~/providers/shop/checkout/checkout';
import { useCheckout } from '~/hooks/useCheckout';
import { CountryPreferenceService } from './CountryPreferenceService';
import type { ServerCart } from '~/sellright/types/cart';

// Exercise the checkout action outside rendering; cart locks, live reads & order POST remain real.
vi.mock('@qwik.dev/core', async importOriginal => ({
  ...await importOriginal<typeof import('@qwik.dev/core')>(),
  $: <T,>(action: T) => action,
  useStore: <T,>(state: T) => state,
}));

const ordinary = { code: 'SAVE', kind: 'percentage' as const, applied: true, appliedAmount: 100 };
const credit = { code: 'CREDIT', kind: 'account_credit' as const, applied: true, appliedAmount: 900, availableAmount: 1500, remainingAmount: 600 };
const cart = (over: Partial<ServerCart> = {}): ServerCart => ({
  token: 'stack-cart', status: 'active', revision: 1, currency: 'USD', email: null, customerId: null,
  subtotal: 2000, discountTotal: 100, shippingTotal: 500, taxTotal: 0, grandTotal: 2400,
  unavailable: [], coupon: ordinary, couponCodes: ['SAVE'], coupons: [ordinary], quoteHash: 'quote-one',
  shippingMethodCode: 'standard', pointsDiscount: 0, pricingIntent: 'checkout',
  lines: [{ sku: 'SKU', name: 'Item', quantity: 1, unitPrice: 2000, lineSubtotal: 2000, lineDiscount: 100,
    lineTotal: 1900, available: true, availableQuantity: 5 }], ...over,
});
const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
let responses: Response[] = [];
const respond = (body: unknown, status = 200) => responses.push(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
beforeEach(() => {
  vi.stubGlobal('crypto', { subtle: webcrypto.subtle, randomUUID });
  installLocks(); localStorage.clear(); document.cookie = 'sr_cart=stack-cart; Path=/';
  CartService['resetMirror'](); CartService.setQuoteContext({}); calls.length = 0; responses = [];
  vi.stubGlobal('fetch', vi.fn(async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    calls.push({ url: request.url, method: request.method, body: request.body ? await request.clone().json() : null });
    const response = responses.shift(); if (!response) throw new Error('Unexpected request'); return response;
  }));
});
afterEach(() => { vi.unstubAllGlobals(); removeLocks(); document.cookie = 'sr_cart=; Path=/; Max-Age=0'; });

describe('complete coupon intent', () => {
  it('deduplicates by case only & preserves whitespace-bearing identity', () => {
    expect(couponMembership(['SAVE', 'save', ' SAVE', 'CREDIT'])).toEqual(['SAVE', ' SAVE', 'CREDIT']);
    expect(parseLegacyCartSnapshot(JSON.stringify({ items: [], couponCodes: ['SAVE', 'save', 'CREDIT'] })).couponCodes).toEqual(['SAVE', 'CREDIT']);
    expect(() => parseLegacyCartSnapshot(JSON.stringify({ items: [], couponCodes: ['SAVE', 3] }))).toThrow('original cart is preserved');
  });
  it('lifts old single-code storage once & persists versioned full membership', async () => {
    localStorage.setItem('sr_cart_intent', JSON.stringify({ token: 'stack-cart', couponCode: 'SAVE' }));
    respond(cart()); respond(cart({ revision: 2 })); respond(cart({ revision: 2 })); await CartService.bootstrap();
    expect(new URL(calls[0].url).searchParams.has('couponCodes')).toBe(false);
    expect(calls[1].body).toMatchObject({ couponCodes: ['SAVE'], expectedRevision: 1 });
    expect(JSON.parse(localStorage.getItem('sr_cart_intent')!)).toEqual({ version: 2, token: 'stack-cart', couponCodes: ['SAVE'] });
  });
  it('merges legacy code after canonical membership & recomputes it once after conflict', async () => {
    localStorage.setItem('sr_cart_intent', JSON.stringify({ token: 'stack-cart', couponCode: 'SAVE' }));
    respond(cart({ couponCodes: ['CREDIT'] }));
    respond({ code: 'stale', revision: 2, cart: cart({ revision: 2, couponCodes: ['CREDIT', 'OTHER', 'save'] }) }, 409);
    respond(cart({ revision: 3, couponCodes: ['CREDIT', 'OTHER', 'save'] }));
    respond(cart({ revision: 3, couponCodes: ['CREDIT', 'OTHER', 'save'] }));
    await CartService.bootstrap();
    expect(calls.filter(call => call.method === 'PATCH').map(call => call.body)).toEqual([
      { lines: [], couponCodes: ['CREDIT', 'SAVE'], expectedRevision: 1, shipCountry: 'US' },
      { lines: [], couponCodes: ['CREDIT', 'OTHER', 'save'], expectedRevision: 2, shipCountry: 'US' },
    ]);
    expect(calls.filter(call => call.method === 'GET').every(call => !new URL(call.url).searchParams.has('couponCodes'))).toBe(true);
    expect(JSON.parse(localStorage.getItem('sr_cart_intent')!).couponCodes).toEqual(['CREDIT', 'OTHER', 'save']);
  });
  it('keeps legacy replay storage after failed lift & retries it after reload', async () => {
    const legacy = JSON.stringify({ token: 'stack-cart', couponCode: 'SAVE' });
    localStorage.setItem('sr_cart_intent', legacy);
    respond(cart({ couponCodes: ['CREDIT'] }));
    respond({ error: { code: 'UNAVAILABLE', message: 'Try again' } }, 503);
    await expect(CartService.bootstrap()).rejects.toThrow();
    expect(localStorage.getItem('sr_cart_intent')).toBe(legacy);
    CartService['resetMirror']();
    respond(cart({ revision: 2, couponCodes: ['CREDIT', 'OTHER'] }));
    respond(cart({ revision: 3, couponCodes: ['CREDIT', 'OTHER', 'SAVE'] }));
    respond(cart({ revision: 3, couponCodes: ['CREDIT', 'OTHER', 'SAVE'] }));
    await CartService.bootstrap();
    expect(calls.filter(call => call.method === 'PATCH')[1].body).toMatchObject({
      couponCodes: ['CREDIT', 'OTHER', 'SAVE'], expectedRevision: 2,
    });
    expect(JSON.parse(localStorage.getItem('sr_cart_intent')!)).toMatchObject({ version: 2, couponCodes: ['CREDIT', 'OTHER', 'SAVE'] });
  });
  it('adopts saved server membership without an empty local override', async () => {
    respond(cart({ couponCodes: ['SAVE', 'CREDIT'], coupons: [ordinary, credit] })); await CartService.bootstrap();
    expect(new URL(calls[0].url).searchParams.has('couponCodes')).toBe(false);
    expect(CartService.getCart().couponCodes).toEqual(['SAVE', 'CREDIT']);
  });
  it('adds credit & removes only that code through revisioned durable mutations', async () => {
    respond(cart()); respond(cart({ revision: 2, couponCodes: ['SAVE', 'CREDIT'], coupons: [ordinary, credit], quoteHash: 'quote-two' }));
    expect(await CartService.applyCoupon('CREDIT')).toEqual({ valid: true });
    expect(calls[1].body).toMatchObject({ lines: [], expectedRevision: 1, couponCodes: ['SAVE', 'CREDIT'] });
    expect(CartService.getCart().coupons[1]).toMatchObject({ availableAmount: 1500, remainingAmount: 600 });
    respond(cart({ revision: 3 })); await CartService.removeCoupon('credit');
    expect(calls[2].body).toMatchObject({ lines: [], expectedRevision: 2, couponCodes: ['SAVE'] });
    expect(CartService.getCart().couponCodes).toEqual(['SAVE']);
  });
  it('retains another tab’s ordinary code when stale coupon mutation retries', async () => {
    respond(cart());
    respond({ code: 'stale', revision: 2, cart: cart({ revision: 2, couponCodes: ['SAVE', 'OTHER'] }) }, 409);
    respond(cart({ revision: 3, couponCodes: ['SAVE', 'OTHER', 'CREDIT'], coupons: [ordinary, credit] }));
    await CartService.applyCoupon('CREDIT');
    expect(calls[2].body).toMatchObject({ expectedRevision: 2, couponCodes: ['SAVE', 'OTHER', 'CREDIT'] });
  });
});

describe('quote consent before checkout', () => {
  const scope = { readFresh: async () => cart(), adoptConflict: vi.fn(), retire: vi.fn() };
  it('uses checkout address country for refresh, mutations & locked submit without changing preference', async () => {
    CountryPreferenceService.setCountry('US');
    CartService.setQuoteContext({ pricingIntent: 'checkout', shippingMethodCode: 'standard', shipCountry: 'CA' });
    respond(cart()); await CartService.refresh();
    respond(cart({ revision: 2 })); await CartService.updateLine('SKU', 1);
    respond(cart({ revision: 2 })); respond({ code: 'ORDER', state: 'PendingPayment', grandTotal: 2400 });
    CartService.setQuoteContext({ pricingIntent: 'checkout', shipCountry: 'GB' });
    const checkout = useCheckout();
    expect(await checkout.placeOrder({ shippingAddress: { country: 'CA' }, shippingMethodCode: 'standard', acceptedQuoteHash: 'quote-one' }, null)).toBe('paying');
    const reads = calls.filter(call => call.method === 'GET');
    expect(reads).toHaveLength(2);
    expect(reads.every(call => new URL(call.url).searchParams.get('shipCountry') === 'CA')).toBe(true);
    expect(calls.find(call => call.method === 'PATCH')?.body).toMatchObject({ shipCountry: 'CA' });
    expect(calls.find(call => call.method === 'POST')?.body).toMatchObject({ shippingAddress: { country: 'CA' } });
    expect(CountryPreferenceService.getCountry()).toBe('US');
    CartService.setQuoteContext({});
    respond(cart()); await CartService.refresh();
    expect(new URL(calls[calls.length - 1].url).searchParams.get('shipCountry')).toBe('US');
  });
  it('stops before POST when fresh validated quote differs from accepted quote', async () => {
    const quote = cart({ quoteHash: 'changed', grandTotal: 2600 });
    await expect(placeOrder({ couponCodes: ['SAVE'], acceptedQuoteHash: 'old' }, { token: quote.token, revision: 1, status: 'active', quoteHash: quote.quoteHash, quote }, scope)).rejects.toBeInstanceOf(QuoteChangedError);
    expect(calls).toHaveLength(0);
  });
  it('preserves full codes & acceptance, displays final changed quote & never retries automatically', async () => {
    const quote = cart({ couponCodes: ['SAVE', 'CREDIT'], coupons: [ordinary, credit] });
    const changed = cart({ quoteHash: 'changed-final', grandTotal: 2600 });
    respond({ error: { code: 'QUOTE_CHANGED', message: 'Quote changed' }, quote: changed, quoteHash: changed.quoteHash, revision: 1 }, 409);
    let failure: unknown;
    try { await placeOrder({ couponCodes: quote.couponCodes, acceptedQuoteHash: quote.quoteHash }, { token: quote.token, revision: 1, status: 'active', quoteHash: quote.quoteHash, quote }, scope); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(QuoteChangedError);
    expect((failure as QuoteChangedError).quote.grandTotal).toBe(2600);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ couponCodes: ['SAVE', 'CREDIT'], acceptedQuoteHash: 'quote-one', expectedRevision: 1 });
  });
});
