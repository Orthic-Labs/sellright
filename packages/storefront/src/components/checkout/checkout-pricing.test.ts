import { describe, expect, it } from 'vitest';
import { chooseShippingMethod, pricingReadStep } from './checkout-pricing';

describe('pricingReadStep (V27: one checkout pricing read per state change)', () => {
	it('does nothing when the inputs equal the last recorded read', () => {
		expect(pricingReadStep({ context: 'a', recorded: 'a', shippingPending: false })).toBe('same');
		expect(pricingReadStep({ context: 'a', recorded: 'a', shippingPending: true })).toBe('same');
	});

	it('waits (no read, not recorded) while the shipping quote for the new inputs is in flight', () => {
		expect(pricingReadStep({ context: 'US', recorded: '', shippingPending: true })).toBe('wait');
	});

	it('reads once the quote settled, even when the method did not change (the deferred change is never lost)', () => {
		// Destination set while quoting: wait. The quote settles with no method change: the context still differs
		// from the recorded one (never recorded while waiting), so the read happens.
		const recorded = '';
		expect(pricingReadStep({ context: 'US|-', recorded, shippingPending: true })).toBe('wait');
		expect(pricingReadStep({ context: 'US|-', recorded, shippingPending: false })).toBe('read');
	});

	it('simulated entry: country set then method selected makes exactly one read', () => {
		let recorded = '';
		let reads = 0;
		const run = (context: string, shippingPending: boolean) => {
			const step = pricingReadStep({ context, recorded, shippingPending });
			if (step === 'read') { recorded = context; reads++; }
		};
		run('US|', true); // country set, shipping quote starts
		run('US|free-shipping', true); // method written before the pending flag clears
		run('US|free-shipping', false); // flag clears
		run('US|free-shipping', false); // a mirror replacement re-runs the task with equal inputs
		expect(reads).toBe(1);
	});

	it('a later address change with no shipping re-quote reads at once', () => {
		expect(pricingReadStep({ context: 'US|addr2|m', recorded: 'US|addr1|m', shippingPending: false })).toBe('read');
	});
});

describe('chooseShippingMethod (#412)', () => {
	const methods = [{ code: 'express', rate: 1500 }, { code: 'std', rate: 500 }, { code: 'eco', rate: 500 }];

	it('the POST quote: the cheapest eligible, the first of equal rates (unchanged)', () => {
		expect(chooseShippingMethod(methods)?.code).toBe('std');
		expect(chooseShippingMethod(methods, null)?.code).toBe('std');
	});

	it("the cart read's quote: keeps the method the server priced the cart with while it is quoted", () => {
		expect(chooseShippingMethod(methods, 'express')?.code).toBe('express');
		expect(chooseShippingMethod(methods, 'pickup')?.code).toBe('std');
	});

	it('nothing eligible: no method', () => {
		expect(chooseShippingMethod([], 'std')).toBeNull();
	});
});
