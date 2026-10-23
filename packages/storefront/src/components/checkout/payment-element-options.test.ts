import { describe, expect, it } from 'vitest';
import { PAYMENT_METHOD_ORDER, paymentElementOptions } from './payment-element-options';

describe('paymentElementOptions', () => {
	it('is an open accordion with radios, no wallets, card first and crypto last', () => {
		expect(paymentElementOptions()).toEqual({
			layout: { type: 'accordion', defaultCollapsed: false, radios: 'always', spacedAccordionItems: false },
			wallets: { applePay: 'never', googlePay: 'never' },
			paymentMethodOrder: ['card', 'affirm', 'klarna', 'afterpay_clearpay', 'cashapp', 'link', 'crypto'],
		});
	});

	it('hands each mount its own order array (the shared constant cannot be mutated through it)', () => {
		const a = paymentElementOptions();
		a.paymentMethodOrder!.reverse();
		expect(paymentElementOptions().paymentMethodOrder).toEqual([...PAYMENT_METHOD_ORDER]);
	});
});
