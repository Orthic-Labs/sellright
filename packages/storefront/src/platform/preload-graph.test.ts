import { describe, expect, it } from 'vitest';
import { CART_ANCHOR, CART_REGION, CART_SEEDS, CHECKOUT_ANCHOR, CHECKOUT_REGION, pruneBundleGraph, type BundleGraph } from './preload-graph';

// Decode the flat graph the same way the rc.3 preloader does (preloader.mjs `F`): name -> [{dep, probability}].
const decode = (g: BundleGraph) => {
	const out: Record<string, { dep: string; p: number }[]> = {};
	let i = 0;
	while (i < g.length) {
		const name = g[i++] as string;
		const deps: { dep: string; p: number }[] = [];
		let p = 1;
		while (typeof g[i] === 'number') { const n = g[i++] as number; if (n < 0) p = -n / 10; else deps.push({ dep: g[n] as string, p }); }
		out[name] = deps;
	}
	return out;
};

describe('pruneBundleGraph (P7/V30)', () => {
	// a.js: static b.js, dynamic c.js (0.8) and d.js (0.6); route "shop/" -> a.js, c.js (dynamic); symbol "s1" -> c.js.
	const graph: BundleGraph = ['a.js', 6, -8, 7, -6, 8, 'b.js', 'c.js', 'd.js', 'shop/', -9, 0, 7, 's1', -9, 7];
	it('drops dynamic edges out of JS bundles and keeps static imports', () => {
		const g = decode(pruneBundleGraph(graph));
		expect(g['a.js']).toEqual([{ dep: 'b.js', p: 1 }]);
		expect(g['b.js']).toEqual([]);
		expect(g['d.js']).toEqual([]);
	});
	it('keeps route and symbol edges intact, with indexes rewritten', () => {
		const pruned = pruneBundleGraph(graph);
		const g = decode(pruned);
		expect(g['shop/']).toEqual([{ dep: 'a.js', p: 0.9 }, { dep: 'c.js', p: 0.9 }]);
		expect(g['s1']).toEqual([{ dep: 'c.js', p: 0.9 }]);
		expect(pruned.length).toBe(graph.length - 4);
	});
	it('returns a malformed graph unchanged', () => {
		const bad = [1, 2, 3] as unknown as BundleGraph;
		expect(pruneBundleGraph(bad)).toBe(bad);
		const dangling: BundleGraph = ['a.js', 99];
		expect(pruneBundleGraph(dangling)).toBe(dangling);
		expect(pruneBundleGraph([])).toEqual([]);
	});

	describe('checkout closure (L10)', () => {
		// co.js (checkout component): static w.js; dynamic seg.js. w.js (address-form wrapper): dynamic form.js.
		// form.js: static util.js; dynamic deep.js. util.js: dynamic shared.js (util is not region code: not expanded).
		// cart.js (shared cart drawer, not an anchor): dynamic seg2.js.
		const names = ['co.js', 'w.js', 'seg.js', 'form.js', 'util.js', 'deep.js', 'shared.js', 'cart.js', 'seg2.js', 'checkout/'];
		const graph: BundleGraph = [];
		const at: Record<string, number> = {};
		const deps: Record<string, (string | number)[]> = {
			'co.js': ['w.js', -8, 'seg.js'], 'w.js': [-9, 'form.js'], 'seg.js': [], 'form.js': ['util.js', -7, 'deep.js'],
			'util.js': [-5, 'shared.js'], 'deep.js': [], 'shared.js': [], 'cart.js': [-9, 'seg2.js'], 'seg2.js': [], 'checkout/': [-5, 'co.js'],
		};
		let pos = 0;
		for (const n of names) { at[n] = pos; pos += 1 + deps[n].length; }
		for (const n of names) { graph.push(n); for (const d of deps[n]) graph.push(typeof d === 'number' ? d : at[d]); }
		const origins: Record<string, string[]> = {
			'co.js': ['src/components/checkout/CheckoutAddresses.tsx'],
			'w.js': ['src/components/address-form/AddressForm.tsx'],
			'seg.js': ['src/components/checkout/CheckoutAddresses.tsx_CheckoutAddresses_component_x.js'],
			'form.js': ['src/components/address-form/AddressForm.tsx_AddressForm_component_y.js'],
			'util.js': ['src/utils/format.ts'],
			'deep.js': ['src/components/address-form/AddressTextInput.tsx_z.js'],
			'shared.js': ['src/components/header/header.tsx'],
			'cart.js': ['src/components/cart-contents/CartContents.tsx'],
			'seg2.js': ['src/components/cart-contents/CartContents.tsx_c.js'],
		};
		const closure = { origins: (n: string) => origins[n], anchor: CHECKOUT_ANCHOR, region: CHECKOUT_REGION, probability: 0.8 };

		it('flattens the checkout closure onto the anchor, after its static imports', () => {
			const g = decode(pruneBundleGraph(graph, closure));
			expect(g['co.js']).toEqual([
				{ dep: 'w.js', p: 1 },
				...['seg.js', 'form.js', 'util.js', 'deep.js'].map((dep) => ({ dep, p: 0.8 })),
			]);
		});
		it('does not expand non-region bundles or change bundles that are not anchors', () => {
			const g = decode(pruneBundleGraph(graph, closure));
			expect(g['co.js'].map((d) => d.dep)).not.toContain('shared.js');
			expect(g['w.js']).toEqual([]);
			expect(g['form.js']).toEqual([{ dep: 'util.js', p: 1 }]);
			expect(g['cart.js']).toEqual([]);
			expect(g['checkout/']).toEqual([{ dep: 'co.js', p: 0.5 }]);
		});
		it('needs every source of an anchor to be checkout code', () => {
			const mixed = { ...closure, origins: (n: string) => (n === 'co.js' ? [...origins[n], 'src/routes/index.tsx'] : origins[n]) };
			expect(decode(pruneBundleGraph(graph, mixed))['co.js']).toEqual([{ dep: 'w.js', p: 1 }]);
			expect(pruneBundleGraph(graph, { ...closure, origins: () => undefined })).toEqual(pruneBundleGraph(graph));
		});
		it('matches the checkout source paths of both commerce flows and the client-rendered checkout parts', () => {
			expect(CHECKOUT_ANCHOR.test('src/routes/checkout/index.tsx')).toBe(true);
			expect(CHECKOUT_ANCHOR.test('src/platform/license/routes/checkout/index.tsx')).toBe(true);
			expect(CHECKOUT_ANCHOR.test('src/routes/checkout-old/index.tsx')).toBe(false);
			for (const o of ['src/components/billing-address-form/BillingAddressForm.tsx', 'src/components/cart-totals/CartTotals.tsx_x.js',
				'src/components/cart/StockWarning.tsx', 'src/components/loyalty/LoyaltyEarnHint.tsx', 'src/hooks/useCheckout.ts',
				'src/contexts/CartContext.tsx_loadCartIfNeeded_x.js', 'src/components/ui/LazyImage.tsx']) expect(CHECKOUT_REGION.test(o)).toBe(true);
			for (const o of ['src/components/header/header.tsx', 'src/routes/products/[...slug]/index.tsx', 'src/components/ui/index.ts'])
				expect(CHECKOUT_REGION.test(o)).toBe(false);
		});
	});
});

describe('cart-drawer closure (#425)', () => {
	// idle.js: the product page's cart-preload task (anchor), static util. handler.js: the add handler (seed). cc.js: the layout's cart wrapper
	// (seed). cart.js: the drawer component (seed), static cartutil.js, dynamic contents.js. contents.js (region): dynamic slot.js (region),
	// dynamic gateway.js (region, which has a dynamic edge to a brand view that is NOT drawer code: reviews.js).
	// page.js (the product page, not an anchor): dynamic reviews.js. other.js: a page bundle with no anchor.
	const names = ['idle.js', 'util.js', 'handler.js', 'cc.js', 'cart.js', 'cartutil.js', 'contents.js', 'slot.js', 'gateway.js', 'reviews.js', 'page.js', 'other.js'];
	const deps: Record<string, (string | number)[]> = {
		'idle.js': ['util.js', -8, 'reviews.js'], 'util.js': [], 'handler.js': [], 'cc.js': [-9, 'cart.js'], 'cart.js': ['cartutil.js', -9, 'contents.js'],
		'cartutil.js': [], 'contents.js': [-9, 'slot.js', 'gateway.js'], 'slot.js': [], 'gateway.js': [-9, 'reviews.js'], 'reviews.js': [],
		'page.js': [-9, 'reviews.js'], 'other.js': [-9, 'cart.js'],
	};
	const at: Record<string, number> = {};
	let pos = 0;
	for (const n of names) { at[n] = pos; pos += 1 + deps[n].length; }
	const graph: BundleGraph = [];
	for (const n of names) { graph.push(n); for (const d of deps[n]) graph.push(typeof d === 'number' ? d : at[d]); }
	const origins: Record<string, string[]> = {
		'idle.js': ['src/platform/controllers/cart-preload.ts_usePreloadCartDrawer_useVisibleTask_abc.js'],
		'util.js': ['src/utils/addressStorage.ts'],
		'handler.js': ['src/routes/products/[...slug]/ProductContent.tsx_ProductContent_component_handleAddToCart_abc.js'],
		'cc.js': ['src/components/cart/ConditionalCart.tsx_ConditionalCart_component_abc.js'],
		'cart.js': ['src/components/cart/Cart.tsx_Cart_component_abc.js'],
		'cartutil.js': ['src/components/cart/cart-shipping.ts'],
		'contents.js': ['src/components/cart-contents/CartContents.tsx_CartContents_component_abc.js'],
		'slot.js': ['src/brand-slots/cart.free-shipping-progress.tsx_x_abc.js'],
		'gateway.js': ['src/platform/gateway/index.tsx'],
		'reviews.js': ['src/components/reviews/Reviews.tsx'],
		'page.js': ['src/routes/products/[...slug]/index.tsx'],
		'other.js': ['src/routes/other/index.tsx'],
	};
	const cl = { origins: (n: string) => origins[n], anchor: CART_ANCHOR, anchorMode: 'any' as const, seeds: CART_SEEDS, region: CART_REGION, probability: 0.8 };
	const g1 = decode(pruneBundleGraph(graph, cl));
	const names1 = (n: string) => g1[n].map((d) => d.dep);

	it('the anchor gets the drawer, the add handler and the layout wrapper, and everything the drawer code reaches, as lazy edges', () => {
		expect(g1['idle.js'].filter((d) => d.p === 0.8).map((d) => d.dep).sort()).toEqual(['cart.js', 'cartutil.js', 'cc.js', 'contents.js', 'gateway.js', 'handler.js', 'slot.js']);
		expect(g1['idle.js'].find((d) => d.dep === 'util.js')).toEqual({ dep: 'util.js', p: 1 }); // its own static import stays certain
	});
	it('never adds the anchor\'s own lazy edge or non-drawer code reached through the drawer (reviews.js)', () => {
		expect(names1('idle.js')).not.toContain('reviews.js');
	});
	it('every other bundle is exactly as P7 left it: pages without the anchor preload no drawer', () => {
		const plain = decode(pruneBundleGraph(graph));
		for (const n of names.filter((x) => x !== 'idle.js')) expect(g1[n]).toEqual(plain[n]);
		expect(names1('other.js')).toEqual([]);
	});
	it('composes with the checkout closure', () => {
		const both = decode(pruneBundleGraph(graph, [{ origins: (n) => origins[n], anchor: CHECKOUT_ANCHOR, region: CHECKOUT_REGION, probability: 0.8 }, cl]));
		expect(both['idle.js']).toEqual(g1['idle.js']);
	});
	it('matches the real segment names the build produces', () => {
		expect(CART_SEEDS.test('src/platform/controllers/configurator.ts_useConfigurator_onAddToCart_abc.js')).toBe(true);
		expect(CART_SEEDS.test('src/contexts/CartContext.tsx_addToCartWithOutcome_abc.js')).toBe(true);
		expect(CART_SEEDS.test('src/routes/checkout/index.tsx_Checkout_component_abc.js')).toBe(false);
	});
});
