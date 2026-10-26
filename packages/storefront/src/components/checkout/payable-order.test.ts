// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { paymentControlsMounted, stripeElementMountable } from './payable-order';

const s = (phase: string, code = '', clientSecret = '', chargeTotalCents = 2300) => ({ phase, code, clientSecret, chargeTotalCents });

describe('#372 payment controls stay mounted from the first PAY to the charge', () => {
	it('mounts before any order once something is due', () => {
		expect(paymentControlsMounted(s('idle'))).toBe(true);
		expect(paymentControlsMounted(s('error'))).toBe(true);
		expect(paymentControlsMounted(s('idle', '', '', 0))).toBe(false); // nothing due: PLACE ORDER instead
	});

	it('stays mounted through order creation, including the gap where the code is set and the phase is still placing', () => {
		// The sequence useCheckout.placeOrder walks: placing (no code) -> placing (code set, awaiting init) -> paying.
		const sequence = [s('placing'), s('placing', 'DD1'), s('paying', 'DD1')];
		expect(sequence.map(paymentControlsMounted)).toEqual([true, true, true]);
		// Stripe: deferred element (no secret yet) must survive the same gap, then confirm with the minted secret.
		expect([s('placing'), s('placing', 'DD1'), s('paying', 'DD1', 'pi_secret')].map(stripeElementMountable)).toEqual([true, true, true]);
	});

	it('unmounts once paid, and after an order whose payment failed to start (the page resumes it)', () => {
		expect(paymentControlsMounted(s('paid', 'DD1'))).toBe(false);
		expect(paymentControlsMounted(s('error', 'DD1'))).toBe(false);
	});
});
