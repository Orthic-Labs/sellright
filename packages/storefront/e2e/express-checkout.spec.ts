import type { Page } from '@playwright/test';
import { test, expect, skipExternal } from './fixtures';
import { STRIPE_ENABLED } from './support/env.mjs';
import { PRODUCT } from './support/api';
import { mock } from './support/mock';
import { addToCart, goToCheckout } from './support/flows';
import { installStripeStub } from './support/stripe-stub';

/**
 * Express checkout (Apple Pay / Google Pay) against the real checkout route, real API and the mock Stripe gateway. Only
 * Stripe.js is stubbed (at the network edge): the wallet sheet is driven by firing the Express Checkout Element's own
 * events. Every amount the wallet is given must come from the API's express quote; confirm creates exactly one order at
 * that total and confirms that order's PaymentIntent. Needs the Stripe-enabled harness (E2E_STRIPE=1).
 */
skipExternal();
test.beforeEach(() => mock.reset());

type Rate = { id: string; displayName: string; amount: number };
type QuotedMethod = { code: string; name: string; rate: number };
const express = (page: Page) => page.getByTestId('checkout-express');
const emit = <T = unknown>(page: Page, event: string, payload: Record<string, unknown> = {}) =>
	page.evaluate(async ([e, p]) => {
		const w = window as unknown as { __stripeEmitFor: (t: string, e: string, p: unknown) => Promise<unknown[]> };
		// resolve / reject / paymentFailed are recorded so the spec sees what the checkout answered the wallet.
		const answer: { resolved?: unknown; rejected?: boolean; failed?: unknown } = {};
		await w.__stripeEmitFor('expressCheckout', e as string, { ...(p as object),
			resolve: (d: unknown) => { answer.resolved = d ?? null; },
			reject: () => { answer.rejected = true; },
			paymentFailed: (f: unknown) => { answer.failed = f ?? null; },
		});
		return answer as T;
	}, [event, payload] as const);
const quotes = (page: Page) => {
	const seen: Array<{ status: number; body: { methods: QuotedMethod[]; cart: { grandTotal: number; quoteHash: string } } }> = [];
	page.on('response', async (r) => {
		if (/\/v1\/shop\/cart\/[^/]+\/express-quote$/.test(new URL(r.url()).pathname)) seen.push({ status: r.status(), body: await r.json().catch(() => null) });
	});
	return seen;
};

test.describe('express checkout (wallet)', () => {
	test.skip(!STRIPE_ENABLED, 'needs E2E_STRIPE=1 (Stripe seeded as the checkout card method): did not run, missing coverage');

	test('no wallet on this device: nothing is shown', async ({ apiProxyPage: page }) => {
		const stub = await installStripeStub(page);
		await addToCart(page, PRODUCT.mug.slug);
		await goToCheckout(page);
		await expect.poll(async () => (await stub.calls()).some((c) => c.fn === 'elements.create' && c.type === 'expressCheckout')).toBe(true);
		await expect(express(page)).toHaveAttribute('aria-hidden', 'true');
		await expect(express(page)).toBeHidden();
	});

	test('wallet total comes from server quotes; confirm creates one order at that total and confirms its intent', async ({ apiProxyPage: page, api }) => {
		let checkoutPosts = 0;
		page.on('request', (r) => { if (new URL(r.url()).pathname === '/v1/shop/checkout' && r.method() === 'POST') checkoutPosts++; });
		const stub = await installStripeStub(page);
		const seenQuotes = quotes(page);
		await page.addInitScript(() => { (window as unknown as { __STRIPE_WALLETS: object }).__STRIPE_WALLETS = { applePay: true }; });

		await addToCart(page, PRODUCT.mug.slug);
		await goToCheckout(page);
		await expect(express(page)).toBeVisible({ timeout: 15_000 });
		const elementsCall = (await stub.calls()).find((c) => c.fn === 'elements' && (c.opts as { mode?: string } | null)?.mode === 'payment');
		expect(elementsCall, 'deferred-intent Elements for the wallet').toBeTruthy();
		expect((await stub.calls()).find((c) => c.fn === 'elements.create' && c.type === 'expressCheckout')?.options)
			.toMatchObject({ emailRequired: true, phoneNumberRequired: true, shippingAddressRequired: true, paymentMethods: { applePay: 'auto', googlePay: 'auto', link: 'never', paypal: 'never' } });

		// Sheet opens with the pre-quoted rates; the wallet's address then gets its own server quote.
		const opened = await emit<{ resolved: { shippingRates: Rate[] } }>(page, 'click', { expressPaymentType: 'apple_pay' });
		expect(opened.resolved.shippingRates.length).toBeGreaterThan(0);
		const changed = await emit<{ resolved: { shippingRates: Rate[] } }>(page, 'shippingaddresschange', { name: 'Wallet Buyer', address: { city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' } });
		const quote = seenQuotes.at(-1)!;
		expect(quote.status).toBe(200);
		// The server's methods, the priced (cheapest) one first: nothing is added, dropped or repriced by the client.
		expect(changed.resolved.shippingRates).toEqual(quote.body.methods.map((m) => ({ id: m.code, displayName: m.name, amount: m.rate })));
		const updates = (await stub.calls()).filter((c) => c.fn === 'elements.update');
		expect((updates.at(-1)!.opts as { amount: number }).amount, 'wallet amount = server quote total').toBe(quote.body.cart.grandTotal);

		const rate = changed.resolved.shippingRates[0]!;
		const confirmed = await emit<{ failed?: unknown }>(page, 'confirm', {
			expressPaymentType: 'apple_pay',
			billingDetails: { name: 'Wallet Buyer', email: 'wallet-buyer@example.net', phone: '+15125550111', address: { line1: '1 Congress Ave', line2: null, city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' } },
			shippingAddress: { name: 'Wallet Buyer', address: { line1: '1 Congress Ave', line2: null, city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' } },
			shippingRate: rate,
		});
		expect(confirmed.failed, 'the wallet payment was not refused').toBeUndefined();
		expect(checkoutPosts, 'exactly one order').toBe(1);

		const confirm = (await stub.calls()).filter((c) => c.fn === 'confirmPayment');
		expect(confirm).toHaveLength(1);
		const intent = (await mock.stripeIntents()).find((i) => i.client_secret === confirm[0]!.clientSecret);
		expect(intent, 'the confirmed intent is the order\'s server-minted intent').toBeTruthy();
		expect(intent!.amount, 'charged amount = the total the wallet showed').toBe(quote.body.cart.grandTotal);
		expect((confirm[0]!.confirmParams as { return_url: string }).return_url).toMatch(new RegExp(`/checkout/confirmation/${intent!.metadata.orderCode}\\?rt=`));
		const order = await api.order(intent!.metadata.orderCode!);
		expect(order.grandTotal).toBe(quote.body.cart.grandTotal);
		await expect.poll(async () => (await mock.stripeIntents()).find((i) => i.id === intent!.id)?.status).toBe('succeeded');
		stub.assertReached();
	});
});
