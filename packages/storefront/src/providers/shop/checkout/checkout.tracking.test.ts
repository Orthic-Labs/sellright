// @vitest-environment jsdom
// #375: for a brand with the OpenAI pixel, POST /v1/shop/checkout carries the ad match keys (pixel __obref, first-party
// visitor id) and falls back to the pixel's __oppref cookie when the tab's landing attribution has no oppref.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/platform/brand-data', async (importOriginal) => ({
	...(await importOriginal<typeof import('~/platform/brand-data')>()),
	BRAND_HEAD: { analytics: { provider: 'gtm', containerId: 'GTM-TEST', consent: 'implied', adPlatforms: ['openai'] } },
}));
vi.mock('~/services/CartService', async (importOriginal) => ({ ...(await importOriginal<typeof import('~/services/CartService')>()), CartService: {} }));

import type { CartLockScope } from '~/services/CartService';
import { __resetAnalyticsForTests, setAnalyticsConsent } from '~/sellright/analytics';
import { captureAttribution } from '~/sellright/attribution';
import { readCookie, VISITOR_COOKIE } from '~/platform/controllers/user-data';
import { placeOrder } from './checkout';

const bodies: Record<string, unknown>[] = [];
const snap = { token: 'tok', revision: 1, status: 'active' };
const scope = { readFresh: () => { throw new Error('no'); }, adoptConflict: () => undefined, retire: () => undefined } as unknown as CartLockScope;
const form = { email: 'a@b.c', shippingAddress: { fullName: 'A B', streetLine1: '1 St', city: 'X', postalCode: '1', countryCode: 'US' }, shippingMethodCode: 'std', items: [{ sku: 'SKU1', quantity: 1 }] };

beforeEach(() => {
	bodies.length = 0;
	document.cookie.split(';').forEach((c) => { document.cookie = c.split('=')[0]!.trim() + '=; Max-Age=0; Path=/'; });
	sessionStorage.clear();
	vi.stubGlobal('fetch', vi.fn(async (request: Request) => {
		bodies.push(JSON.parse(await request.clone().text()));
		return new Response(JSON.stringify({ code: 'O1', state: 'PendingPayment', grandTotal: 100, receiptToken: 'rt' }), { status: 200, headers: { 'content-type': 'application/json' } });
	}));
});
afterEach(() => { vi.unstubAllGlobals(); __resetAnalyticsForTests(); });

describe('checkout ad match keys (#375)', () => {
	it('sends obref + visitor id and the __oppref fallback with consent; nothing without it', async () => {
		document.cookie = '__obref=ob.abc; Path=/';
		document.cookie = '__oppref=opp-cookie; Path=/';
		await placeOrder(form, snap, scope);
		expect(bodies[0]).not.toHaveProperty('tracking');
		expect(bodies[0]).not.toHaveProperty('attribution');

		setAnalyticsConsent(true);
		await placeOrder(form, snap, scope);
		const vid = readCookie(VISITOR_COOKIE);
		expect(bodies[1]!.tracking).toEqual({ obref: 'ob.abc', visitorId: vid });
		expect(bodies[1]!.attribution).toEqual({ oppref: 'opp-cookie' });

		// The landing URL's own oppref wins over the cookie.
		captureAttribution('https://shop.test/?utm_source=chatgpt&oppref=opp-url');
		await placeOrder(form, snap, scope);
		expect(bodies[2]!.attribution).toEqual({ utm_source: 'chatgpt', oppref: 'opp-url' });
	});
});
