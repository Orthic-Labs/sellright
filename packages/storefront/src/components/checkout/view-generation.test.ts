import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { totalChange } from '~/hooks/checkout-total';
import { acceptsMount, bumpView, isCurrentView, type ViewGeneration } from './view-generation';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTE_DIR = join(HERE, '../../routes/checkout');
const read = (rel: string) => readFileSync(join(HERE, rel), 'utf8');

/**
 * A payment component's QRL can run only after the view was replaced (lazy-loaded handler). The component captured its
 * mount id at mount; the route handler compares it with the current generation when the callback finally executes.
 */
describe('view generation', () => {
	const makeView = (): ViewGeneration => ({ gen: 0 });

	it('is monotonic and a handler that captured an older generation sees itself as stale', () => {
		const view = makeView();
		const captured = view.gen;
		expect(isCurrentView(view, captured)).toBe(true);
		const next = bumpView(view);
		expect(next).toBe(captured + 1);
		expect(isCurrentView(view, captured)).toBe(false);
		expect(isCurrentView(view, next)).toBe(true);
		expect(bumpView(view)).toBeGreaterThan(next);
	});

	it('a deferred init-error callback from a replaced component is rejected and does not touch the replacement', async () => {
		const view = makeView();
		const init = { failed: false };
		// the route handler, as written in routes/checkout/index.tsx
		const onInitError = async (_message: string, mountGen?: number) => {
			if (!acceptsMount(view, mountGen)) return;
			init.failed = true;
		};
		const stripeMount = view.gen; // Stripe rendered with this id
		let runDeferred!: () => Promise<void>;
		const deferred = new Promise<void>((resolve) => {
			// the QRL resolves lazily, after the shopper switched method
			runDeferred = async () => { await onInitError('loaderror', stripeMount); resolve(); };
		});
		bumpView(view); // method switch → NMI is the current view
		const nmiMount = view.gen;
		await runDeferred();
		await deferred;
		expect(init.failed).toBe(false);
		// the current component still reports normally
		await onInitError('timeout', nmiMount);
		expect(init.failed).toBe(true);
	});

	it('a stale component cannot lock the current view, but its lock release is always accepted', () => {
		const view = makeView();
		const stale = view.gen;
		bumpView(view);
		const state = { loading: false };
		const onProcessing = (isProcessing: boolean, mountGen?: number) => {
			if (isProcessing && !acceptsMount(view, mountGen)) return;
			state.loading = isProcessing;
		};
		onProcessing(true, stale);
		expect(state.loading).toBe(false);
		onProcessing(true, view.gen);
		expect(state.loading).toBe(true);
		onProcessing(false, stale);
		expect(state.loading).toBe(false);
	});

	it('a callback without a mount id (legacy caller) is accepted', () => {
		expect(acceptsMount(makeView(), undefined)).toBe(true);
	});

	it('a handler that captured the generation at entry stops before touching state or navigating after a bump', async () => {
		const view = makeView();
		const navigate = vi.fn();
		const state = { value: 'before' };
		let release!: () => void;
		const lookup = new Promise<void>((r) => { release = r; });
		const resume = async () => {
			const gen = view.gen;
			await lookup;
			if (!isCurrentView(view, gen)) return;
			state.value = 'after';
			navigate('/checkout/confirmation/X');
		};
		const run = resume();
		bumpView(view); // the shopper left checkout
		release();
		await run;
		expect(state.value).toBe('before');
		expect(navigate).not.toHaveBeenCalled();
	});

	// Regression (round 7): the normal flow must never change the generation between PLACE ORDER and the payment view.
	// Only a view replacement may bump. These cases exercise the checkout code itself (the changed-total gate, the
	// Sezzle component's callbacks, the route's place-order handler), not outcomes the test sets up for itself.
	describe('one place-order → payment sequence keeps a single generation', () => {
		it('changed-total consent gate: a server total that differs from the shown one is gated by the real totalChange', () => {
			// shown 30.00 at PLACE ORDER, the server priced the created order at 33.00: the notice must gate the charge
			expect(totalChange(3000, 3300)).toEqual({ changed: true, shownCents: 3000, chargeCents: 3300 });
			expect(totalChange(3000, 3000).changed).toBe(false);
			// both payment panels refuse to charge a changed total until the shopper confirms
			expect(read('CheckoutPaymentPanel.tsx')).toMatch(/needsConsent = paying && change\.changed && !props\.totalConfirmed\.value/);
			expect(read('CheckoutPaymentPanel.tsx')).toMatch(/totalChange\(props\.srState\.shownTotal, props\.srState\.grandTotal\)\.changed && !props\.totalConfirmed\.value\) return;/);
		});

		it('the place-order handler never bumps the view; only the view-replacing handlers do', () => {
			const route = readFileSync(join(ROUTE_DIR, 'index.tsx'), 'utf8');
			const start = route.indexOf('const placeOrder = $(');
			const end = route.indexOf('const recoverResumePaymentError', start);
			expect(start).toBeGreaterThan(-1);
			expect(end).toBeGreaterThan(start);
			const place = route.slice(start, end);
			expect(place).toMatch(/isCurrentView\(paymentInit, gen\)|current\(\)/); // it checks the generation it captured...
			expect(place).not.toMatch(/bumpView\(/); // ...and never replaces it
		});

		it('Sezzle: the component reports with the mount id it was rendered with, and that id is accepted by the route', () => {
			const sezzle = read('../payment/Sezzle.tsx');
			expect(sezzle).toMatch(/useSignal\(props\.mountGen\)/);
			expect(sezzle).toMatch(/onProcessingChange\$\?\.\(true, mountGen\.value\)/);
			expect(sezzle).toMatch(/onError\$\([^)]*mountGen\.value\)/);
			// both payment views render it with the view's current generation
			expect(read('CheckoutPaymentPanel.tsx')).toMatch(/<Sezzle\s+mountGen=\{props\.paymentInit\.gen\}/);
			expect(read('CheckoutResumePanel.tsx')).toMatch(/<Sezzle\s+mountGen=\{props\.paymentInit\.gen\}/);
			// the id rendered is the id the route compares against
			const view = makeView();
			const rendered = view.gen;
			expect(acceptsMount(view, rendered)).toBe(true);
		});

		it('a method switch (the only bump in the sequence) is what discards a place-order that began before it', () => {
			const view = makeView();
			const gen = view.gen;
			bumpView(view);
			expect(isCurrentView(view, gen)).toBe(false);
			expect(read('CheckoutPaymentPanel.tsx')).toMatch(/bumpView\(props\.paymentInit\)/);
		});
	});
});
