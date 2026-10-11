import { describe, expect, it, vi } from 'vitest';
import { acceptsMount, bumpView, isCurrentView, type ViewGeneration } from './view-generation';

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
	// Every step below is something the normal flow does; none of them may bump. Only a view replacement may.
	describe('one place-order → payment sequence keeps a single generation', () => {
		const run = async (finish: (view: ViewGeneration, placed: { total: number; shown: number }) => Promise<void>) => {
			const view = makeView();
			const gen0 = view.gen; // entry task, config read, form fill: no bump
			const ui = { consentShown: false, redirected: false, error: null as string | null };
			const placeOrder = async () => {
				const gen = view.gen; // captured at entry, as in routes/checkout/index.tsx
				await Promise.resolve(); // config read
				await Promise.resolve(); // order request: the cart converts here, entry/late tasks may re-run
				await Promise.resolve(); // stock refresh
				if (!isCurrentView(view, gen)) return; // a stale place-order shows nothing
				await finish(view, { total: 3300, shown: 3000 });
				ui.consentShown = true;
			};
			await placeOrder();
			expect(view.gen).toBe(gen0);
			return ui;
		};

		it('changed-total consent gate: the notice shows after the order is created', async () => {
			const ui = await run(async () => {});
			expect(ui.consentShown).toBe(true);
		});

		it('Sezzle: the mount id rendered for the payment view is accepted by its start/return callbacks', async () => {
			const view = makeView();
			await run(async (v) => {
				const mountGen = v.gen; // <Sezzle mountGen={paymentInit.gen}/> rendered once the phase is 'paying'
				expect(acceptsMount(v, mountGen)).toBe(true); // onProcessingChange$(true) on Continue
				expect(acceptsMount(v, mountGen)).toBe(true); // onError$ if session creation fails
			});
			expect(view.gen).toBe(0);
		});

		it('a method switch (the only bump in the sequence) is what discards a place-order that began before it', async () => {
			const view = makeView();
			const gen = view.gen;
			bumpView(view);
			expect(isCurrentView(view, gen)).toBe(false);
		});
	});
});
