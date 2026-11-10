// DP-5 / DP-6: the shop reveal script and the checkout summary paint script (platform/early-paint.ts), run in jsdom against the markup the
// shell routes send, with the live reads stubbed. What matters: no out-of-stock card is ever un-gated, a failed read paints nothing, the
// Qwik consumer still takes the original early response, and nothing the shell sends depends on the visitor.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	buildEarlyReadsPlan,
	earlyPaintScriptSource,
	earlyReadsScriptSource,
	earlyReadsScriptTag,
	CHECKOUT_SUMMARY_URL,
	takeEarlyRead,
	EARLY_READS_GLOBAL,
	SHOP_CONFIG_URL,
	type EarlyReadsContext,
} from './early-reads';
import { buildCsp, executableInlineScripts, inlineScriptHashSources, withScriptHashes } from '~/utils/csp';
import { CHECKOUT_STYLES } from '~/routes/checkout/checkout-styles';

const damned: EarlyReadsContext = {
	productPrefix: 'products', shell: true, brandHome: true, brandShop: false, brandProduct: false,
	homeSpotlightSlug: 'pocket-fixed-blade', detailSlugs: [], shopLiveListing: false,
};
const rotten: EarlyReadsContext = {
	productPrefix: 'shop', shell: true, brandHome: true, brandShop: true, brandProduct: true,
	homeSpotlightSlug: null, detailSlugs: ['shortsleeveshirt'], shopLiveListing: true,
};

type W = Record<string, unknown>;
const store = () => (window as unknown as W)[EARLY_READS_GLOBAL] as { r: Record<string, Promise<Response>> } | undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const clearCookies = () => { for (const c of document.cookie.split(';')) { const n = c.split('=')[0]!.trim(); if (n) document.cookie = `${n}=; Max-Age=0; Path=/`; } };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
	delete (window as unknown as W)[EARLY_READS_GLOBAL];
	clearCookies();
	localStorage.clear();
	document.body.innerHTML = '';
	document.documentElement.removeAttribute('data-sr-shop-slow');
	window.history.replaceState(null, '', '/');
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	delete (document as unknown as { readyState?: string }).readyState;
});

describe('plan: which render gets a paint script', () => {
	it('shell /checkout/ only; the shop (#425: its grid is visible from the HTML), dynamic, excluded, license and the opt-out get none', () => {
		expect(buildEarlyReadsPlan('/shop/', damned).paint).toBeUndefined();
		expect(buildEarlyReadsPlan('/checkout/', damned).paint).toMatchObject({ kind: 'checkout' });
		expect(buildEarlyReadsPlan('/shop/', { ...damned, shell: false }).paint).toBeUndefined();
		expect(buildEarlyReadsPlan('/checkout/', { ...damned, shell: false }).paint).toBeUndefined();
		expect(buildEarlyReadsPlan('/shop/', rotten).paint).toBeUndefined(); // the configurator shop is not a grid
		expect(buildEarlyReadsPlan('/checkout/', { ...damned, license: true }).paint).toBeUndefined();
		for (const p of ['/', '/products/oni/', '/blog/', '/shop/oni/']) expect(buildEarlyReadsPlan(p, damned).paint, p).toBeUndefined();
	});
	it('the tag carries the reads script and then the paint script; a plan without paint has one script', () => {
		const plan = buildEarlyReadsPlan('/checkout/', damned);
		expect(executableInlineScripts(earlyReadsScriptTag(plan))).toEqual([earlyReadsScriptSource(plan), earlyPaintScriptSource(plan)]);
		expect(executableInlineScripts(earlyReadsScriptTag(buildEarlyReadsPlan('/', damned)))).toHaveLength(1);
	});
	it('a shell render allows both scripts by sha256; a nonce render nonces both (CSP)', () => {
		const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('base64');
		for (const path of ['/checkout/']) {
			const plan = buildEarlyReadsPlan(path, damned);
			const csp = withScriptHashes(buildCsp({ nonce: undefined }), inlineScriptHashSources(earlyReadsScriptTag(plan), sha));
			for (const src of [earlyReadsScriptSource(plan), earlyPaintScriptSource(plan)!]) expect(csp, path).toContain(`'sha256-${sha(src)}'`);
			const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src '))!;
			expect(scriptSrc, path).not.toMatch(/unsafe-inline|nonce-/);
			expect(earlyReadsScriptTag(plan, 'abc').match(/<script nonce="abc">/g), path).toHaveLength(2);
		}
	});
	it('the paint scripts carry no price, stock value or visitor value (the shell is identical for every visitor) and are safe inside <script>', () => {
		for (const path of ['/checkout/']) {
			const src = earlyPaintScriptSource(buildEarlyReadsPlan(path, damned))!;
			expect(src).not.toContain('</script');
			expect(src).not.toMatch(/[$€£₹]\s?\d/); // edge-conformance's currency scan
			expect(src).not.toMatch(/"(?:price|priceWithTax|minPrice|maxPrice|salePrice|unitPrice|stockLevel)"\s*:/);
			expect(src).not.toMatch(/"inStock"\s*:\s*true/);
			expect(src).not.toMatch(/sessionStorage|localStorage\.setItem|document\.cookie\s*=/); // LOCKED: nothing stock-like is stored
		}
	});
});

// ---------------------------------------------------------------------------------------------------- checkout

const TOKEN = 'tok-1';
const line = (over: Record<string, unknown> = {}) => ({ sku: 'S1', name: 'Oni - Large', productName: 'Oni', productSlug: 'oni', quantity: 2, lineSubtotal: 9000, available: true, availableQuantity: null, image: 'a/oni.jpg', ...over });
/** The /api/live/checkout-summary/ answer. */
const sum = (c: unknown, status = 200) => json({ cart: c }, status);
const cart = (over: Record<string, unknown> = {}) => ({ token: TOKEN, status: 'active', pricingIntent: 'checkout', currency: 'USD', subtotal: 9000, discountTotal: 0, shippingTotal: 500, grandTotal: 9500, quoteHash: 'qh', coupons: [], lines: [line()], ...over });

/** The shell checkout's three empty paint hosts, each before its Qwik skeleton, as CheckoutOrderSummary renders them. */
const checkoutHtml = '<span data-sr-host="total"></span><span data-sr-skel=""></span><div data-sr-host="lines"></div><div data-sr-skel=""></div><div data-sr-host="totals"></div><div data-sr-skel=""></div>';
const host = (n: string) => document.querySelector(`[data-sr-host="${n}"]`)!;
const hostText = (n: string) => host(n).shadowRoot!.lastElementChild!.textContent;
const painted = (n: string) => host(n).hasAttribute('data-painted');

async function startCheckout(answer: () => Promise<Response>, setup: () => void = () => {}, ctx: EarlyReadsContext = damned) {
	delete (window as unknown as W)[EARLY_READS_GLOBAL];
	document.body.innerHTML = checkoutHtml;
	document.cookie = `sr_cart=${TOKEN}; Path=/`;
	setup();
	window.history.replaceState(null, '', '/checkout/');
	vi.stubGlobal('fetch', vi.fn((u: string) => (u === CHECKOUT_SUMMARY_URL ? answer() : u.startsWith('/v1/shop/cart/') ? Promise.resolve(json(cart())) : Promise.resolve(json({})))));
	const plan = buildEarlyReadsPlan('/checkout/', { ...ctx, assetDomain: 'damned.test', assetRev: 3 });
	new Function(earlyReadsScriptSource(plan))();
	new Function(earlyPaintScriptSource(plan)!)();
	await tick();
}

describe('DP-5 checkout summary paint: before hydration, into shadow-DOM hosts', () => {
	it('paints the lines, the totals and the order total from the live cart read', async () => {
		await startCheckout(() => Promise.resolve(sum(cart())));
		for (const h of ['total', 'lines', 'totals']) expect(painted(h), h).toBe(true);
		expect(hostText('total')).toBe('$95.00');
		const lines = host('lines').shadowRoot!;
		expect(lines.querySelectorAll('li')).toHaveLength(1);
		expect(lines.querySelector('h3')!.textContent).toBe('Oni');
		expect(lines.querySelector('.v')!.textContent).toBe('Oni / Large'); // = CartContents: normalizeOptionSeparators(line.name)
		expect(lines.querySelector('.q')!.textContent).toBe('Qty 2');
		expect(lines.querySelector('.p')!.textContent).toBe('$90');
		const img = lines.querySelector('img')!;
		expect(img.getAttribute('loading')).toBe('eager');
		expect(img.getAttribute('fetchpriority')).toBe('high');
		expect(lines.querySelector('source[type="image/avif"]')!.getAttribute('srcset')).toBe('/assets/a/oni.jpg?preset=thumb&format=avif&q=75&r=3 160w, /assets/a/oni.jpg?preset=card&format=avif&q=75&r=3 320w');
		expect([...host('totals').shadowRoot!.querySelectorAll('.t')].map((r) => r.textContent)).toEqual(['Subtotal$90', 'Shipping$5', 'Total$95']);
	});
	it('#446: a backorder line paints its ship label (fallback without one) and the order sentence once; no backorder paints neither', async () => {
		await startCheckout(() => Promise.resolve(sum(cart({ lines: [line({ backorder: true, shipLabel: 'Ships in 3 weeks' }), line({ sku: 'S2', backorder: true, shipLabel: null }), line({ sku: 'S3' })] }))));
		const lines = host('lines').shadowRoot!;
		expect([...lines.querySelectorAll('.bo')].map((n) => n.textContent)).toEqual(['Ships in 3 weeks', 'Ships later']);
		expect([...lines.querySelectorAll('.n')].map((n) => n.textContent)).toEqual(['Your whole order ships together when these items arrive.']);
	});
	it('#446: a backorder label is text, never markup', async () => {
		await startCheckout(() => Promise.resolve(sum(cart({ lines: [line({ backorder: true, shipLabel: '<img src=x onerror=1>' })] }))));
		const lines = host('lines').shadowRoot!;
		expect(lines.querySelector('.bo img')).toBeNull();
		expect(lines.querySelector('.bo')!.textContent).toBe('<img src=x onerror=1>');
	});
	it('#446: without backorder lines the painted summary has no notice', async () => {
		await startCheckout(() => Promise.resolve(sum(cart())));
		const lines = host('lines').shadowRoot!;
		expect(lines.querySelector('.bo')).toBeNull();
		expect(lines.querySelector('.n')).toBeNull();
	});
	it('a painted host hides the Qwik skeleton beside it (CSS), and an unpainted host is hidden', () => {
		expect(CHECKOUT_STYLES).toContain('[data-sr-host]:not([data-painted]){display:none}');
		expect(CHECKOUT_STYLES).toContain('[data-sr-host][data-painted]+[data-sr-skel]{display:none}');
	});
	it('the hosts stay empty light DOM: Qwik never has a node here to diff or wipe', async () => {
		await startCheckout(() => Promise.resolve(sum(cart())));
		for (const h of ['total', 'lines', 'totals']) expect(host(h).childNodes).toHaveLength(0);
	});
	it('free shipping reads "Free", an unquoted cart "Calculated at next step", and a discount gets its row', async () => {
		await startCheckout(() => Promise.resolve(sum(cart({ shippingTotal: 0, grandTotal: 9000 }))));
		expect(hostText('totals')).toContain('ShippingFree');
		await startCheckout(() => Promise.resolve(sum(cart({ quoteHash: '', shippingTotal: 0, grandTotal: 0, discountTotal: 1000 }))));
		expect(hostText('totals')).toContain('Calculated at next step');
		expect(hostText('totals')).toContain('Discount-$10');
		expect(hostText('totals')).toContain('Total$80'); // subtotal - discount, the arithmetic CartTotals does without a quote
	});
	it('a cart the script cannot mirror exactly is left to Qwik: coupon, pre-order, unavailable, unknown availability, converted, wrong intent, empty', async () => {
		const cases: Record<string, unknown> = {
			coupon: cart({ coupons: [{ code: 'X', applied: true, appliedAmount: 100 }] }),
			preorder: cart({ lines: [line({ isPreOrder: true })] }),
			unavailable: cart({ lines: [line({ available: false })] }),
			'unknown availability': cart({ lines: [line({ available: undefined })] }),
			converted: cart({ status: 'converted' }),
			'preview intent': cart({ pricingIntent: 'preview' }),
			empty: cart({ lines: [] }),
		};
		for (const [name, body] of Object.entries(cases)) {
			await startCheckout(() => Promise.resolve(sum(body)));
			for (const h of ['total', 'lines', 'totals']) expect(painted(h), `${name} ${h}`).toBe(false);
		}
	});
	it('a failed or late cart read paints nothing: the Qwik skeleton and entry read are exactly as before', async () => {
		for (const answer of [() => Promise.resolve(json({ error: 'x' }, 500)), () => Promise.resolve(sum(null)), () => Promise.reject(new TypeError('offline')), () => new Promise<Response>(() => {})]) {
			await startCheckout(answer);
			expect(painted('lines')).toBe(false);
		}
	});
	it('nothing is painted before the read lands: the browser keeps no line items, and sr_cart_count counts units, not lines, so it never sizes rows', async () => {
		await startCheckout(() => new Promise<Response>(() => {}), () => localStorage.setItem('sr_cart_count', JSON.stringify({ token: TOKEN, count: 3 })));
		for (const h of ['total', 'lines', 'totals']) expect(painted(h), h).toBe(false);
	});
	it('no cart cookie: the summary read still starts (it matches the preload) but no cart read, nothing painted', async () => {
		document.body.innerHTML = checkoutHtml;
		clearCookies();
		window.history.replaceState(null, '', '/checkout/');
		const fetchMock = vi.fn((u: string) => Promise.resolve(u === CHECKOUT_SUMMARY_URL ? sum(cart()) : json({})));
		vi.stubGlobal('fetch', fetchMock);
		const plan = buildEarlyReadsPlan('/checkout/', damned);
		new Function(earlyReadsScriptSource(plan))();
		new Function(earlyPaintScriptSource(plan)!)();
		await tick(10);
		expect(fetchMock.mock.calls.map((c) => c[0])).toContain(CHECKOUT_SUMMARY_URL);
		expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith('/v1/shop/cart/'))).toBe(false);
		expect(painted('lines')).toBe(false); // an answer for a visitor the page would not read a cart for is never painted
	});
	it('cart text is escaped: a product name is data, never markup', async () => {
		await startCheckout(() => Promise.resolve(sum(cart({ lines: [line({ productName: '<img src=x onerror=1>"', name: 'v' })] }))));
		const lines = host('lines').shadowRoot!;
		expect(lines.querySelector('h3')!.textContent).toBe('<img src=x onerror=1>"');
		expect(lines.querySelectorAll('img')).toHaveLength(1); // only the thumbnail
	});
	it('the Qwik cart boot still takes its own early cart read (single use); the summary read is the painter\'s alone', async () => {
		await startCheckout(() => Promise.resolve(sum(cart())));
		const key = Object.keys(store()!.r).find((k) => k.startsWith('/v1/shop/cart/'))!;
		expect(Object.keys(store()!.r)).toContain(SHOP_CONFIG_URL);
		expect(((await (await takeEarlyRead(key)!).json()) as { token: string }).token).toBe(TOKEN);
	});
});
