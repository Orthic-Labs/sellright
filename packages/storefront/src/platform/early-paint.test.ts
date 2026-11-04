// DP-5 / DP-6: the shop reveal script and the checkout summary paint script (platform/early-paint.ts), run in jsdom against the markup the
// shell routes send, with the live reads stubbed. What matters: no out-of-stock card is ever un-gated, a failed read paints nothing, the
// Qwik consumer still takes the original early response, and nothing the shell sends depends on the visitor.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	buildEarlyReadsPlan,
	earlyJsonOr,
	earlyPaintScriptSource,
	earlyReadsScriptSource,
	earlyReadsScriptTag,
	liveReadUrl,
	takeEarlyRead,
	EARLY_READS_GLOBAL,
	SHOP_CONFIG_URL,
	type EarlyReadsContext,
} from './early-reads';
import { SHOP_GATE_CSS } from './early-paint';
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
	it('shell /shop/ (base grid) and shell /checkout/ only; dynamic, excluded, brand shop, license and the opt-out get none', () => {
		expect(buildEarlyReadsPlan('/shop/', damned).paint).toEqual({ kind: 'shop', k: liveReadUrl('shop-catalog'), t: 4000 });
		expect(buildEarlyReadsPlan('/checkout/', damned).paint).toMatchObject({ kind: 'checkout' });
		expect(buildEarlyReadsPlan('/shop/', { ...damned, shell: false }).paint).toBeUndefined();
		expect(buildEarlyReadsPlan('/checkout/', { ...damned, shell: false }).paint).toBeUndefined();
		expect(buildEarlyReadsPlan('/shop/', rotten).paint).toBeUndefined(); // the configurator shop is not a grid
		expect(buildEarlyReadsPlan('/checkout/', { ...damned, license: true }).paint).toBeUndefined();
		for (const p of ['/', '/products/oni/', '/blog/', '/shop/oni/']) expect(buildEarlyReadsPlan(p, damned).paint, p).toBeUndefined();
	});
	it('the tag carries the reads script and then the paint script; a plan without paint has one script', () => {
		const plan = buildEarlyReadsPlan('/shop/', damned);
		expect(executableInlineScripts(earlyReadsScriptTag(plan))).toEqual([earlyReadsScriptSource(plan), earlyPaintScriptSource(plan)]);
		expect(executableInlineScripts(earlyReadsScriptTag(buildEarlyReadsPlan('/', damned)))).toHaveLength(1);
	});
	it('a shell render allows both scripts by sha256; a nonce render nonces both (CSP)', () => {
		const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('base64');
		for (const path of ['/shop/', '/checkout/']) {
			const plan = buildEarlyReadsPlan(path, damned);
			const csp = withScriptHashes(buildCsp({ nonce: undefined }), inlineScriptHashSources(earlyReadsScriptTag(plan), sha));
			for (const src of [earlyReadsScriptSource(plan), earlyPaintScriptSource(plan)!]) expect(csp, path).toContain(`'sha256-${sha(src)}'`);
			const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src '))!;
			expect(scriptSrc, path).not.toMatch(/unsafe-inline|nonce-/);
			expect(earlyReadsScriptTag(plan, 'abc').match(/<script nonce="abc">/g), path).toHaveLength(2);
		}
	});
	it('the paint scripts carry no price, stock value or visitor value (the shell is identical for every visitor) and are safe inside <script>', () => {
		for (const path of ['/shop/', '/checkout/']) {
			const src = earlyPaintScriptSource(buildEarlyReadsPlan(path, damned))!;
			expect(src).not.toContain('</script');
			expect(src).not.toMatch(/[$€£₹]\s?\d/); // edge-conformance's currency scan
			expect(src).not.toMatch(/"(?:price|priceWithTax|minPrice|maxPrice|salePrice|unitPrice|stockLevel)"\s*:/);
			expect(src).not.toMatch(/"inStock"\s*:\s*true/);
			expect(src).not.toMatch(/sessionStorage|localStorage\.setItem|document\.cookie\s*=/); // LOCKED: nothing stock-like is stored
		}
	});
});

// ---------------------------------------------------------------------------------------------------- shop

/** The shell shop page as the server sends it: the gated grid with its `data-slug` wrappers, the end sentinel after it. */
const gridHtml = (slugs: string[], sentinel = true) =>
	`<div id="grid" data-listing-pending="" data-live-gate="">${slugs.map((s) => `<div class="contents" data-slug="${s}"><a href="/products/${s}/">${s}</a></div>`).join('')}</div>${sentinel ? '<i hidden data-live-gate-end=""></i>' : ''}`;

function startShop(answer: () => Promise<Response>) {
	window.history.replaceState(null, '', '/shop/');
	vi.stubGlobal('fetch', vi.fn(() => answer()));
	const plan = buildEarlyReadsPlan('/shop/', damned);
	new Function(earlyReadsScriptSource(plan))();
	new Function(earlyPaintScriptSource(plan)!)();
}
const shown = () => Array.from(document.getElementById('grid')!.children).filter((c) => (c as HTMLElement).style.display !== 'none').map((c) => c.getAttribute('data-slug'));
const applied = () => document.getElementById('grid')!.hasAttribute('data-live-applied');
const slow = () => document.documentElement.hasAttribute('data-sr-shop-slow');
const catalog = (items: Array<[string, boolean]>) => json({ totalItems: items.length, products: items.map(([slug, inStock]) => ({ slug, inStock })) });

describe('DP-6 shop reveal: the grid stays gated until the live in-stock filter is applied', () => {
	it('hides every card the live read does not confirm in stock, then lifts the gate', async () => {
		startShop(() => Promise.resolve(catalog([['a', true], ['b', false], ['c', true]])));
		document.body.innerHTML = gridHtml(['a', 'b', 'c', 'd']);
		await tick();
		expect(shown()).toEqual(['a', 'c']); // b is out of stock; d is not in the read at all (fail closed)
		expect(applied()).toBe(true);
		expect(slow()).toBe(false);
	});
	it('nothing is un-gated before the read lands, so no card is visible for a frame', async () => {
		let release!: (res: Response) => void;
		startShop(() => new Promise<Response>((resolve) => { release = resolve; }));
		document.body.innerHTML = gridHtml(['a', 'b']);
		await tick(5);
		expect(document.getElementById('grid')!.hasAttribute('data-live-gate')).toBe(true);
		expect(applied()).toBe(false); // CSS: [data-live-gate]:not([data-live-applied]){visibility:hidden}
		release(catalog([['a', true], ['b', false]]));
		await tick();
		expect(shown()).toEqual(['a']);
		expect(applied()).toBe(true);
	});
	it('the gate is lifted only after the out-of-stock cards are hidden (same synchronous step)', async () => {
		startShop(() => Promise.resolve(catalog([['a', true], ['b', false]])));
		const seen: (string | null)[][] = [];
		const grid = () => document.getElementById('grid');
		new MutationObserver(() => { if (grid()?.hasAttribute('data-live-applied')) seen.push(shown()); }).observe(document.documentElement, { attributes: true, subtree: true, childList: true });
		document.body.innerHTML = gridHtml(['a', 'b']);
		await tick();
		expect(seen.length).toBeGreaterThan(0);
		for (const s of seen) expect(s).toEqual(['a']); // at no observable point was the gate lifted with b still shown
	});
	it('a card whose inStock is not exactly true is hidden (fail closed); prototype-named slugs never match', async () => {
		startShop(() => Promise.resolve(json({ products: [{ slug: 'a', inStock: 'true' }, { slug: 'b', inStock: true }] })));
		document.body.innerHTML = gridHtml(['a', 'b', 'constructor', '__proto__']);
		await tick();
		expect(shown()).toEqual(['b']);
	});
	it('a failed read (5xx, network, malformed) keeps the grid gated, nothing un-gated, and shows the notice', async () => {
		for (const answer of [() => Promise.resolve(json({ error: 'x' }, 503)), () => Promise.reject(new TypeError('offline')), () => Promise.resolve(json({ nope: true }))]) {
			delete (window as unknown as W)[EARLY_READS_GLOBAL];
			document.documentElement.removeAttribute('data-sr-shop-slow');
			startShop(answer);
			document.body.innerHTML = gridHtml(['a', 'b']);
			await tick();
			expect(applied()).toBe(false);
			expect(slow()).toBe(true);
		}
	});
	it('a half-streamed grid is never filtered: with the document still loading it waits for the end sentinel', async () => {
		Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'loading' });
		startShop(() => Promise.resolve(catalog([['a', true], ['b', false]])));
		document.body.innerHTML = gridHtml(['a', 'b'], false);
		await tick();
		expect(applied()).toBe(false);
		document.body.insertAdjacentHTML('beforeend', '<i hidden data-live-gate-end=""></i>');
		await tick();
		expect(shown()).toEqual(['a']);
		expect(applied()).toBe(true);
	});
	it('a read that lands before the grid is parsed applies when the grid arrives', async () => {
		startShop(() => Promise.resolve(catalog([['a', true], ['b', false]])));
		await tick();
		document.body.innerHTML = gridHtml(['a', 'b']);
		await tick();
		expect(shown()).toEqual(['a']);
	});
	it('the Qwik consumer still takes the original early response (the script read a clone): no second round trip', async () => {
		startShop(() => Promise.resolve(catalog([['a', true]])));
		document.body.innerHTML = gridHtml(['a']);
		await tick();
		const body = await earlyJsonOr<{ products: Array<{ slug: string }> }>(liveReadUrl('shop-catalog'), async () => { throw new Error('no second read'); });
		expect(body.products[0]!.slug).toBe('a');
	});
	it('the shop CSS gates only the unapplied grid; the notice shows only while the read is late or failed', () => {
		expect(SHOP_GATE_CSS).toContain('[data-live-gate]:not([data-live-applied]){visibility:hidden}');
		expect(SHOP_GATE_CSS).toContain('[data-shop-slow]{display:none}');
		expect(SHOP_GATE_CSS).toContain('html[data-sr-shop-slow] [data-shop-slow]{display:block}');
	});
});

// ---------------------------------------------------------------------------------------------------- checkout

const TOKEN = 'tok-1';
const line = (over: Record<string, unknown> = {}) => ({ sku: 'S1', name: 'Oni - Large', productName: 'Oni', productSlug: 'oni', quantity: 2, lineSubtotal: 9000, available: true, availableQuantity: null, image: 'a/oni.jpg', ...over });
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
	vi.stubGlobal('fetch', vi.fn((u: string) => (u.startsWith('/v1/shop/cart/') ? answer() : Promise.resolve(json({})))));
	const plan = buildEarlyReadsPlan('/checkout/', { ...ctx, assetDomain: 'damned.test', assetRev: 3 });
	new Function(earlyReadsScriptSource(plan))();
	new Function(earlyPaintScriptSource(plan)!)();
	await tick();
}

describe('DP-5 checkout summary paint: before hydration, into shadow-DOM hosts', () => {
	it('paints the lines, the totals and the order total from the live cart read', async () => {
		await startCheckout(() => Promise.resolve(json(cart())));
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
	it('a painted host hides the Qwik skeleton beside it (CSS), and an unpainted host is hidden', () => {
		expect(CHECKOUT_STYLES).toContain('[data-sr-host]:not([data-painted]){display:none}');
		expect(CHECKOUT_STYLES).toContain('[data-sr-host][data-painted]+[data-sr-skel]{display:none}');
	});
	it('the hosts stay empty light DOM: Qwik never has a node here to diff or wipe', async () => {
		await startCheckout(() => Promise.resolve(json(cart())));
		for (const h of ['total', 'lines', 'totals']) expect(host(h).childNodes).toHaveLength(0);
	});
	it('free shipping reads "Free", an unquoted cart "Calculated at next step", and a discount gets its row', async () => {
		await startCheckout(() => Promise.resolve(json(cart({ shippingTotal: 0, grandTotal: 9000 }))));
		expect(hostText('totals')).toContain('ShippingFree');
		await startCheckout(() => Promise.resolve(json(cart({ quoteHash: '', shippingTotal: 0, grandTotal: 0, discountTotal: 1000 }))));
		expect(hostText('totals')).toContain('Calculated at next step');
		expect(hostText('totals')).toContain('Discount-$10');
		expect(hostText('totals')).toContain('Total$80'); // subtotal - discount, the arithmetic CartTotals does without a quote
	});
	it('a cart the script cannot mirror exactly is left to Qwik: coupon, pre-order, unavailable, unknown availability, another cart, converted, wrong intent, empty', async () => {
		const cases: Record<string, unknown> = {
			coupon: cart({ coupons: [{ code: 'X', applied: true, appliedAmount: 100 }] }),
			preorder: cart({ lines: [line({ isPreOrder: true })] }),
			unavailable: cart({ lines: [line({ available: false })] }),
			'unknown availability': cart({ lines: [line({ available: undefined })] }),
			'another cart': cart({ token: 'someone-else' }),
			converted: cart({ status: 'converted' }),
			'preview intent': cart({ pricingIntent: 'preview' }),
			empty: cart({ lines: [] }),
		};
		for (const [name, body] of Object.entries(cases)) {
			await startCheckout(() => Promise.resolve(json(body)));
			for (const h of ['total', 'lines', 'totals']) expect(painted(h), `${name} ${h}`).toBe(false);
		}
	});
	it('a failed or late cart read paints nothing: the Qwik skeleton and entry read are exactly as before', async () => {
		for (const answer of [() => Promise.resolve(json({ error: 'x' }, 500)), () => Promise.reject(new TypeError('offline')), () => new Promise<Response>(() => {})]) {
			await startCheckout(answer);
			expect(painted('lines')).toBe(false);
		}
	});
	it('nothing is painted before the read lands: the browser keeps no line items, and sr_cart_count counts units, not lines, so it never sizes rows', async () => {
		await startCheckout(() => new Promise<Response>(() => {}), () => localStorage.setItem('sr_cart_count', JSON.stringify({ token: TOKEN, count: 3 })));
		for (const h of ['total', 'lines', 'totals']) expect(painted(h), h).toBe(false);
	});
	it('no cart cookie: no cart read, nothing painted', async () => {
		document.body.innerHTML = checkoutHtml;
		clearCookies();
		window.history.replaceState(null, '', '/checkout/');
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({}))));
		const plan = buildEarlyReadsPlan('/checkout/', damned);
		new Function(earlyReadsScriptSource(plan))();
		new Function(earlyPaintScriptSource(plan)!)();
		await tick(10);
		expect(painted('lines')).toBe(false);
	});
	it('cart text is escaped: a product name is data, never markup', async () => {
		await startCheckout(() => Promise.resolve(json(cart({ lines: [line({ productName: '<img src=x onerror=1>"', name: 'v' })] }))));
		const lines = host('lines').shadowRoot!;
		expect(lines.querySelector('h3')!.textContent).toBe('<img src=x onerror=1>"');
		expect(lines.querySelectorAll('img')).toHaveLength(1); // only the thumbnail
	});
	it('the Qwik cart boot still takes the original early response (the script read a clone): no second round trip', async () => {
		await startCheckout(() => Promise.resolve(json(cart())));
		const key = Object.keys(store()!.r).find((k) => k.startsWith('/v1/shop/cart/'))!;
		expect(Object.keys(store()!.r)).toContain(SHOP_CONFIG_URL);
		expect(((await (await takeEarlyRead(key)!).json()) as { token: string }).token).toBe(TOKEN);
	});
});
