import { ssrRenderToDom } from '@qwik.dev/core/testing';
import { describe, expect, it } from 'vitest';
import type { SlotProps } from '~/components/slots/registry';
import { FreeShippingProgress } from './FreeShippingProgress';

const props = (over: Partial<SlotProps<'cart.free-shipping-progress'>> = {}): SlotProps<'cart.free-shipping-progress'> => ({
	currencyCode: 'USD',
	subtotalCents: 7500,
	lineCount: 1,
	isCheckoutView: false,
	countryCode: 'GB',
	discountedSubtotalCents: 7500,
	freeShipping: { threshold: 10000, remaining: 2500 },
	...over,
});

describe('FreeShippingProgress (base cart.free-shipping-progress)', () => {
	it('shows the amount away and the server tier progress', async () => {
		const { document } = await ssrRenderToDom(<FreeShippingProgress {...props()} />, {});
		const root = document.querySelector('[data-testid="free-shipping-progress"]');
		expect(root?.textContent).toContain('Free Shipping');
		expect(root?.textContent).toContain('$25 away');
		expect(document.querySelector('[data-testid="free-shipping-progress-bar"]')?.getAttribute('style')).toContain('width: 75%');
	});

	it.each([
		['no quote yet', null],
		['already free', { threshold: 10000, remaining: 0 }],
		['an empty tier', { threshold: 0, remaining: 0 }],
	])('renders nothing for %s', async (_name, freeShipping) => {
		const { document } = await ssrRenderToDom(<FreeShippingProgress {...props({ freeShipping })} />, {});
		expect(document.querySelector('[data-testid="free-shipping-progress"]') ?? null).toBeNull();
	});
});
