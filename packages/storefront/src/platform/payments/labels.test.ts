import { describe, expect, it } from 'vitest';
import { INSTALLMENT_PROVIDER, PROVIDER_LABELS, PROVIDER_PREFETCH_ORIGINS, continueToLabel, providerLabel } from './labels';

describe('payment provider labels (A20)', () => {
	it('the installment provider id is the wire id the API reports', () => {
		expect(INSTALLMENT_PROVIDER).toBe('sezzle');
	});

	it('labels every provider id', () => {
		expect(PROVIDER_LABELS).toEqual({ stripe: 'Stripe', nmi: 'NMI', sezzle: 'Sezzle' });
		expect(providerLabel('sezzle')).toBe('Sezzle');
	});

	it('continueToLabel reproduces the balance-pay button text that used to be inline', () => {
		expect(continueToLabel(INSTALLMENT_PROVIDER)).toBe('Continue to Sezzle');
		expect(`${continueToLabel(INSTALLMENT_PROVIDER)} · $12.00`).toBe('Continue to Sezzle · $12.00');
	});

	it('prefetch origins keep the head order: live, then sandbox', () => {
		expect([...PROVIDER_PREFETCH_ORIGINS]).toEqual(['https://gateway.sezzle.com', 'https://sandbox.gateway.sezzle.com']);
	});
});
