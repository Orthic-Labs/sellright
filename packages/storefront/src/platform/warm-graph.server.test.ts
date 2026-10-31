import { describe, expect, it } from 'vitest';
import { warmGroups, warmScript } from './warm-graph.server';

const sym = (origin: string, ctxName = 'component$', ctxKind = 'function', displayName = 'x') => ({ origin, ctxName, ctxKind, displayName });
const manifest = {
	symbols: {
		s1: sym('components/cart/Cart.tsx'),
		s2: sym('components/cart/Cart.tsx', 'onClick$', 'eventHandler'),
		s3: sym('routes/products/[...slug]/ProductPageView.tsx'),
		s4: sym('routes/checkout/index.tsx'),
		s5: sym('node_modules/@qwik.dev/router', 'component$', 'function', 'index.qwik.mjs_Link_component'),
		s6: sym('routes/account/index.tsx'),
		s7: sym('brand-slots/route.home.tsx'),
	},
	mapping: { s1: 'q-cart.js', s2: 'q-cartclick.js', s3: 'q-pdp.js', s4: 'q-co.js', s5: 'q-link.js', s6: 'q-acct.js', s7: 'q-home.js' },
	bundles: { 'q-cart.js': { imports: ['q-shared.js'] }, 'q-shared.js': { imports: ['q-cart.js'] }, 'q-pdp.js': {}, 'q-co.js': {}, 'q-link.js': {}, 'q-home.js': {} },
};

describe('warm graph (#425 step 3)', () => {
	it('groups render symbols with their static imports; event handlers and other routes stay out', () => {
		const g = warmGroups(manifest);
		expect(g.cart).toEqual(['/build/q-cart.js', '/build/q-link.js', '/build/q-shared.js']);
		expect(g.product).toEqual(['/build/q-pdp.js']);
		expect(g.home).toEqual(['/build/q-home.js']);
		expect(g.checkout).toEqual(['/build/q-co.js']);
		expect(Object.values(g).flat()).not.toContain('/build/q-cartclick.js');
		expect(Object.values(g).flat()).not.toContain('/build/q-acct.js');
	});

	it('cart warms everything the drawer renders and runs; product warms its click handlers (#427)', () => {
		const m = {
			symbols: {
				a: sym('components/ui/LazyImage.tsx'),
				b: sym('components/icons/TrashIcon.tsx'),
				c: sym('components/checkout/ExpressCheckout.tsx', 'useVisibleTask$'),
				d: sym('components/cart/CartExpress.tsx', 'useVisibleTask$'),
				e: sym('utils/addressStorage.ts', '$'),
				f: sym('routes/products/[...slug]/ProductPageView.tsx', 'onClick$', 'eventHandler'),
				g: sym('components/checkout/StripeForm.tsx'),
			},
			mapping: { a: 'q-a.js', b: 'q-b.js', c: 'q-c.js', d: 'q-d.js', e: 'q-e.js', f: 'q-f.js', g: 'q-g.js' },
			bundles: {},
		};
		const g = warmGroups(m);
		expect(g.cart).toEqual(['/build/q-a.js', '/build/q-b.js', '/build/q-c.js', '/build/q-d.js', '/build/q-e.js']);
		expect(g.product).toEqual(['/build/q-f.js']);
		expect(g.cart).not.toContain('/build/q-g.js');
	});

	it('emits a script that only warms after load (no work at parse) and respects Save-Data', () => {
		const s = warmScript(warmGroups(manifest));
		expect(s).toContain("addEventListener('load',after,{once:true})");
		expect(s).toContain('saveData');
		expect(s).toContain("l.rel='modulepreload'");
		// #427: checkout warms after load too; the cart's Checkout control is a button, so link intent never fired (12 s live).
		expect(s).toContain("w('checkout',1)}");
		expect(() => new Function(s)).not.toThrow();
	});
});
