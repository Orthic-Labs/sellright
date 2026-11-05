// Lane A (CLS on rh checkout 0.058): the express row arrives after load + idle, above the steps and the form. On checkout it holds its
// height (hidden) from SSR until it shows or is known not to, so the buttons arriving push nothing below them.
import { $ } from '@qwik.dev/core';
import { ssrRenderToDom } from '@qwik.dev/core/testing';
import { describe, expect, it } from 'vitest';
import { EXPRESS_RESERVE_HEIGHT, ExpressCheckout } from './ExpressCheckout';

const render = async (reserve: boolean | undefined) => (await ssrRenderToDom(
	<ExpressCheckout
		reserve={reserve} gateway={null} cartToken={null} continueHint label="Express checkout" country="US" couponCodes={[]} redeemPoints={0}
		items={[]} cartKey="k" onPlaceOrder$={$(async () => ({ ok: false }) as never)} onError$={$(() => {})}
	/>, {})).document.querySelector('[data-testid="checkout-express"]')!;

const style = (el: Element) => (el.getAttribute('style') ?? '').replace(/\s+/g, '');

describe('ExpressCheckout reserved row (CLS)', () => {
	it('checkout (reserve): SSR holds the row height, hidden and inert, with its bottom margin', async () => {
		const row = await render(true);
		expect(EXPRESS_RESERVE_HEIGHT).toBe('96px');
		expect(row.getAttribute('data-express-reserved')).toBe('true');
		expect(style(row)).toContain(`height:${EXPRESS_RESERVE_HEIGHT}`);
		expect(style(row)).toContain('margin-bottom:16px');
		expect(style(row)).toContain('visibility:hidden');
		expect(style(row)).toContain('pointer-events:none');
		expect(row.getAttribute('aria-hidden')).toBe('true');
	});
	it('elsewhere (no reserve): collapsed to 0 as before', async () => {
		const row = await render(undefined);
		expect(row.hasAttribute('data-express-reserved')).toBe(false);
		expect(style(row)).toContain('height:0');
	});
});
