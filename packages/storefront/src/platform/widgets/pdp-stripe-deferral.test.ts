import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { afterInteraction } from '~/utils/load-trigger';

const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('PDP widgets never request Stripe before an interaction', () => {
	it('afterInteraction ignores load, idle and timers, and resolves on the first interaction', async () => {
		vi.useFakeTimers();
		const ric = vi.fn((cb: () => void) => { setTimeout(cb, 1); return 1; });
		vi.stubGlobal('requestIdleCallback', ric);
		let done = false;
		void afterInteraction().then(() => { done = true; });
		window.dispatchEvent(new Event('load'));
		await vi.advanceTimersByTimeAsync(60_000);
		expect(done).toBe(false);
		expect(ric).not.toHaveBeenCalled();
		window.dispatchEvent(new Event('pointerdown'));
		await vi.advanceTimersByTimeAsync(0);
		expect(done).toBe(true);
	});

	it('PayLaterMessaging waits on afterInteraction before getShopConfig (which gates Stripe)', () => {
		const s = src('./PayLaterMessaging.tsx');
		expect(s).toContain('afterInteraction()');
		expect(s).not.toContain('afterLoadIdleOrInteraction');
		expect(s.indexOf('afterInteraction()')).toBeLessThan(s.indexOf('getShopConfig()'));
	});

	it('PDP express buy-now loads Stripe on interaction only; checkout/cart keep the idle default', () => {
		expect(src('../../components/checkout/ExpressBuyNow.tsx')).toContain('loadOn="interaction"');
		const ec = src('../../components/checkout/ExpressCheckout.tsx');
		expect(ec).toMatch(/loadOn === 'interaction' \? afterInteraction\(\) : afterLoadIdleOrInteraction\(\)/);
		expect(src('../../components/cart/CartExpress.tsx')).not.toContain('loadOn');
		expect(src('../../components/checkout/CheckoutPageView.tsx')).not.toContain('loadOn');
	});
});
