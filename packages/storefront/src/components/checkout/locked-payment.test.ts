// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { lockedPaymentMarks } from './locked-payment';

describe('#404 lockedPaymentMarks — from the configured providers, never a brand list', () => {
	it('Stripe store (Rotten): cards, Apple Pay, Link', () => {
		expect(lockedPaymentMarks(['stripe'])).toEqual(['cards', 'apple-pay', 'link']);
	});
	it('NMI + Sezzle store (Damned): cards, Sezzle', () => {
		expect(lockedPaymentMarks(['nmi', 'sezzle'])).toEqual(['cards', 'sezzle']);
	});
	it('each mark once, in a fixed order; nothing configured shows nothing', () => {
		expect(lockedPaymentMarks(['sezzle', 'nmi', 'stripe'])).toEqual(['cards', 'apple-pay', 'link', 'sezzle']);
		expect(lockedPaymentMarks([])).toEqual([]);
	});
});
