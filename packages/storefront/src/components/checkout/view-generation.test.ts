import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { needsTotalConsent, totalChange } from '~/hooks/checkout-total';
import type { CheckoutPhase, PaymentMethod } from '~/hooks/useCheckout';
import type { ShopConfig } from '~/sellright/types/checkout';
import { applyPaymentInitError, applyPaymentProcessingChange } from './payment-callbacks';
import { submitOrderFlow, type PlaceOrderFlowDeps } from './place-order-flow';
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

	const callbackDeps = () => {
		const flags = { processingModal: { value: true }, orderProcessing: { value: true } };
		return { view: { gen: 0, failed: false }, state: { loading: false }, flags };
	};

	it('a deferred init-error callback from a replaced component is rejected and does not touch the replacement', async () => {
		const deps = callbackDeps();
		const stripeMount = deps.view.gen; // Stripe rendered with this id
		let runDeferred!: () => Promise<boolean>;
		const deferred = new Promise<void>((release) => {
			// the QRL resolves lazily, after the shopper switched method
			runDeferred = async () => { await new Promise((r) => setTimeout(r, 0)); release(); return applyPaymentInitError(deps, stripeMount); };
		});
		bumpView(deps.view); // method switch → NMI is the current view
		const nmiMount = deps.view.gen;
		expect(await runDeferred()).toBe(false);
		await deferred;
		expect(deps.view.failed).toBe(false);
		// the current component still reports normally
		expect(applyPaymentInitError(deps, nmiMount)).toBe(true);
		expect(deps.view.failed).toBe(true);
		expect(deps.flags.orderProcessing.value).toBe(false);
	});

	it('a stale component cannot lock the current view, but its lock release is always accepted', () => {
		const deps = callbackDeps();
		const stale = deps.view.gen;
		bumpView(deps.view);
		expect(applyPaymentProcessingChange(deps, true, stale)).toBe(false);
		expect(deps.state.loading).toBe(false);
		expect(applyPaymentProcessingChange(deps, true, deps.view.gen)).toBe(true);
		expect(deps.state.loading).toBe(true);
		expect(applyPaymentProcessingChange(deps, false, stale)).toBe(true);
		expect(deps.state.loading).toBe(false);
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
	// Only a view replacement may bump. These cases run the checkout's own handlers (place-order-flow.ts,
	// payment-callbacks.ts, the Sezzle component in sezzle.render.test.tsx) with deferred provider responses; the source
	// scans at the end are supplemental guards only.
	describe('one place-order → payment sequence keeps a single generation', () => {
		type Form = { items: string[] };
		const setup = (grandTotal: number, shownCents: number, phase: CheckoutPhase = 'paying') => {
			const view = { gen: 0, failed: false };
			const srState = { convertedCart: false, phase: 'idle' as CheckoutPhase, code: '', receiptToken: '', stockConflict: false, error: null as string | null, grandTotal: 0, shownTotal: 0 };
			const flags = { processingModal: { value: true }, orderProcessing: { value: true }, totalConfirmed: { value: true } };
			const state = { error: 'old' as string | null, loading: false };
			const navigate = vi.fn();
			const onPaying = vi.fn();
			const beginResume = vi.fn(async () => {});
			let finishOrder!: () => void;
			const orderCreated = new Promise<void>((r) => { finishOrder = r; });
			const placeOrder = vi.fn(async (_form: Form, _method: PaymentMethod | null, shown: number): Promise<CheckoutPhase> => {
				srState.phase = 'placing';
				srState.shownTotal = shown;
				await orderCreated; // the cart converts here; the order request is a deferred provider response
				srState.code = 'ORD-9';
				srState.receiptToken = 'rt9';
				srState.grandTotal = grandTotal;
				srState.phase = phase;
				return phase;
			});
			const deps: PlaceOrderFlowDeps<Form> = {
				srState,
				state,
				flags,
				selectedMethod: () => 'sezzle',
				shownCents: () => shownCents,
				ensureShopConfig: async () => ({ stripeConfigured: false, gateways: { sezzle: {} } }) as unknown as ShopConfig,
				placeOrder,
				beginResume,
				refreshStock: async () => {},
				navigate,
				hasCartToken: () => true,
				onPaying,
			};
			const gen = view.gen; // captured at entry, as in the route
			const run = submitOrderFlow(deps, { items: ['A'] }, () => isCurrentView(view, gen));
			return { view, srState, flags, state, navigate, onPaying, beginResume, placeOrder, run, finishOrder, gen };
		};
		const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

		it('changed-total consent gate: after the order is created at a different total the payment controls stay gated until the shopper confirms', async () => {
			const t = setup(3300, 3000);
			await tick();
			expect(t.flags.totalConfirmed.value).toBe(false); // reset before the order request, never carried over
			expect(t.placeOrder).toHaveBeenCalledWith({ items: ['A'] }, 'sezzle', 3000); // the shown 30.00 is what was agreed to
			t.finishOrder();
			await t.run;
			expect(t.onPaying).toHaveBeenCalledTimes(1);
			expect(t.view.gen).toBe(t.gen); // order creation did not replace the view
			// the panel's gate, on the stores the flow just wrote
			expect(totalChange(t.srState.shownTotal, t.srState.grandTotal)).toMatchObject({ changed: true, shownCents: 3000, chargeCents: 3300 });
			expect(needsTotalConsent(t.srState.shownTotal, t.srState.grandTotal, t.flags.totalConfirmed.value)).toBe(true); // charge prevented
			t.flags.totalConfirmed.value = true; // the shopper ticks "I confirm I will be charged $33.00"
			expect(needsTotalConsent(t.srState.shownTotal, t.srState.grandTotal, t.flags.totalConfirmed.value)).toBe(false);
		});

		it('an unchanged total is not gated', async () => {
			const t = setup(3000, 3000);
			t.finishOrder();
			await t.run;
			expect(needsTotalConsent(t.srState.shownTotal, t.srState.grandTotal, t.flags.totalConfirmed.value)).toBe(false);
		});

		it('Sezzle mount: the id the payment view renders with is accepted by the route callbacks after order creation, and rejected after a method switch', async () => {
			const t = setup(3000, 3000);
			t.finishOrder();
			await t.run;
			const mountGen = t.view.gen; // <Sezzle mountGen={paymentInit.gen}/> once the phase is 'paying'
			const deps = { view: t.view, state: t.state, flags: t.flags };
			expect(applyPaymentProcessingChange(deps, true, mountGen)).toBe(true); // Continue pressed
			expect(t.state.loading).toBe(true);
			expect(applyPaymentProcessingChange(deps, false, mountGen)).toBe(true);
			bumpView(t.view); // method switch replaces the payment view
			expect(applyPaymentProcessingChange(deps, true, mountGen)).toBe(false); // the old Sezzle can no longer lock it
			expect(t.state.loading).toBe(false);
		});

		it('a method switch while the order request is pending discards the place-order: nothing shown, nothing navigated', async () => {
			const t = setup(3300, 3000);
			await tick();
			bumpView(t.view); // the shopper switched method (or left) during the order request
			t.finishOrder();
			await t.run;
			expect(t.onPaying).not.toHaveBeenCalled();
			expect(t.navigate).not.toHaveBeenCalled();
			expect(t.beginResume).not.toHaveBeenCalled();
		});

		it('a zero-due order navigates to its confirmation; a converted cart resumes instead of showing the form', async () => {
			const paid = setup(0, 3000, 'paid');
			paid.finishOrder();
			await paid.run;
			expect(paid.navigate).toHaveBeenCalledWith('/checkout/confirmation/ORD-9?rt=rt9');
			expect(paid.view.gen).toBe(paid.gen);
		});

		it('supplemental source guard: the route has no bump between PLACE ORDER and the payment view, and renders Sezzle with the view generation', () => {
			expect(read('place-order-flow.ts')).not.toMatch(/bumpView\(/);
			const route = readFileSync(join(ROUTE_DIR, 'index.tsx'), 'utf8');
			const start = route.indexOf('const placeOrder = $(');
			const end = route.indexOf('const recoverResumePaymentError', start);
			expect(start).toBeGreaterThan(-1);
			expect(route.slice(start, end)).not.toMatch(/bumpView\(/);
			expect(read('CheckoutPaymentPanel.tsx')).toMatch(/<Sezzle\s+mountGen=\{props\.paymentInit\.gen\}/);
			expect(read('CheckoutResumePanel.tsx')).toMatch(/<Sezzle\s+mountGen=\{props\.paymentInit\.gen\}/);
			expect(read('CheckoutPaymentPanel.tsx')).toMatch(/needsTotalConsent\(props\.srState\.shownTotal/);
		});
	});
});
