// #425/#427: the global stylesheet is inline for first paint; its body <link> starts as media="print" (never render-blocking)
// and applies after start-up, so a client navigation that drops the inline <style> keeps the page styled.
import { addToCart, goToCheckout } from './support/flows';
import { expect, skipExternal, test } from './fixtures';

test.describe('global stylesheet', () => {
	skipExternal();

	test('the body link is non-blocking at first, then applies; checkout after a client navigation is styled', async ({ apiProxyPage: page }) => {
		const res = await page.goto('/products/e2e-shirt/');
		const html = (await res?.text()) ?? '';
		expect(html).toMatch(/<link[^>]*rel="stylesheet"[^>]*media="print"[^>]*data-sr-global/);
		expect(html).toMatch(/<style[^>]*data-sr-global/);
		await expect.poll(() => page.evaluate(() => document.querySelector<HTMLLinkElement>('link[data-sr-global]')?.media)).toBe('all');

		await addToCart(page, 'e2e-shirt');
		await goToCheckout(page);
		// Every global rule still applies after the navigation: the linked sheet is active and the header is laid out by it.
		await expect.poll(() => page.evaluate(() => [...document.styleSheets].some((s) => (s.ownerNode as Element | null)?.hasAttribute?.('data-sr-global') && !s.disabled && s.media.mediaText !== 'print'))).toBe(true);
		const display = await page.evaluate(() => getComputedStyle(document.querySelector('header')!).display);
		expect(display).not.toBe('inline');
	});
});
