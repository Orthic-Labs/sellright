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

	it('emits a script that warms nothing at load: cart and checkout only on intent, Save-Data respected', () => {
		const s = warmScript(warmGroups(manifest));
		expect(s).not.toContain("'load'");
		expect(s).not.toContain('requestIdleCallback');
		expect(s).toContain("'pointerover','focusin','touchstart'");
		expect(s).toContain('saveData');
		expect(s).toContain('/build/q-cart.js');
		expect(s).not.toContain('/build/q-home.js');
		expect(s).not.toContain('/build/q-pdp.js');
		expect(() => new Function(s)).not.toThrow();
	});
});
