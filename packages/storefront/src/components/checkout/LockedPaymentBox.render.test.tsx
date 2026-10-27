import { ssrRenderToDom } from '@qwik.dev/core/testing';
import { describe, expect, it } from 'vitest';
import { PaymentLock } from './LockedPaymentBox';

const render = async (unlocked: boolean, methods: ('stripe' | 'nmi' | 'sezzle')[]) => (await ssrRenderToDom(<PaymentLock unlocked={unlocked} methods={methods} />, {})).document;

describe('#404 locked payment box', () => {
	it('locked (Stripe): heading, unlock line, cards + Apple Pay + Link; a status, nothing focusable or clickable', async () => {
		const doc = await render(false, ['stripe']);
		const box = doc.querySelector('[data-testid="payment-locked"]');
		expect(box?.getAttribute('role')).toBe('status');
		expect(box?.textContent).toContain('Payment');
		expect(box?.textContent).toContain('Enter your email and shipping address to unlock payment.');
		expect(box?.querySelector('[data-brand="visa"]')).toBeTruthy();
		expect(box?.textContent).toContain('Apple Pay');
		expect(box?.textContent).toContain('Link');
		expect(box?.querySelector('img')).toBeFalsy();
		expect(box?.querySelector('a, button, input, select, textarea, [tabindex]')).toBeFalsy();
		expect(doc.querySelector('[data-testid="payment-unlock-status"]')?.textContent).toBe('');
	});
	it('locked (NMI + Sezzle): cards and the Sezzle mark, no wallets', async () => {
		const box = (await render(false, ['nmi', 'sezzle'])).querySelector('[data-testid="payment-locked"]');
		expect(box?.querySelector('[data-brand="mastercard"]')).toBeTruthy();
		expect(box?.querySelector('img')?.getAttribute('alt')).toBe('Sezzle');
		expect(box?.textContent).not.toContain('Apple Pay');
	});
	it('unlocked: the box is gone and the status announces the unlock', async () => {
		const doc = await render(true, ['stripe']);
		expect(doc.querySelector('[data-testid="payment-locked"]')).toBeFalsy();
		expect(doc.querySelector('[data-testid="payment-unlock-status"]')?.textContent).toBe('Payment options unlocked.');
	});
});
