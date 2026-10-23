import type { Page } from '@playwright/test';
import { test, expect, skipExternal } from './fixtures';
import { STRIPE_ENABLED } from './support/env.mjs';
import { PRODUCT, SKU } from './support/api';
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
const WALLET_ADDRESS = { line1: '1 Congress Ave', line2: null, city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' };
const confirmPayload = (rate: Rate) => ({
	expressPaymentType: 'google_pay',
	billingDetails: { name: 'Wallet Buyer', email: 'wallet-buyer@example.net', phone: '+15125550111', address: WALLET_ADDRESS },
	shippingAddress: { name: 'Wallet Buyer', address: WALLET_ADDRESS },
	shippingRate: rate,
});
/** Sheet opens, the wallet reports a US address, the shopper authorizes: returns the last server quote and the answers. */
const driveWallet = async (page: Page, seenQuotes: ReturnType<typeof quotes>) => {
	const opened = await emit<{ resolved?: { shippingRates: Rate[] }; rejected?: boolean }>(page, 'click', { expressPaymentType: 'google_pay' });
	expect(opened.rejected, 'the sheet opens on a server quote').toBeUndefined();
	const changed = await emit<{ resolved: { shippingRates: Rate[] } }>(page, 'shippingaddresschange', { name: 'Wallet Buyer', address: { city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' } });
	const quote = seenQuotes.at(-1)!;
	expect(quote.status).toBe(200);
	expect(changed.resolved.shippingRates).toEqual(quote.body.methods.map((m) => ({ id: m.code, displayName: m.name, amount: m.rate })));
	const confirmed = await emit<{ failed?: unknown }>(page, 'confirm', confirmPayload(changed.resolved.shippingRates[0]!));
	return { quote, confirmed };
};
const checkoutPostCounter = (page: Page) => {
	const posts: Array<{ cartToken?: string }> = [];
	page.on('request', (r) => { if (new URL(r.url()).pathname === '/v1/shop/checkout' && r.method() === 'POST') posts.push(r.postDataJSON() as { cartToken?: string }); });
	return posts;
};
const mainCart = (page: Page) => page.evaluate(async () => {
	const token = decodeURIComponent(/(?:^|; )sr_cart=([^;]*)/.exec(document.cookie)?.[1] ?? '');
	const res = await fetch(`/v1/shop/cart/${encodeURIComponent(token)}`);
	return { token, ...(await res.json()) } as { token: string; status: string; lines: Array<{ sku: string; quantity: number }> };
});
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
			.toMatchObject({ emailRequired: true, phoneNumberRequired: true, shippingAddressRequired: true, paymentMethods: { applePay: 'auto', googlePay: 'auto', link: 'never', paypal: 'never' }, buttonType: { applePay: 'buy', googlePay: 'buy' } });
		await expect(express(page).getByText(/or continue below/i), 'the continue line belongs to checkout').toBeVisible();

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
	test('cart drawer: wallets above CHECKOUT pay for the shopper\'s cart at the server quote', async ({ apiProxyPage: page, api }) => {
		const posts = checkoutPostCounter(page);
		const stub = await installStripeStub(page);
		const seenQuotes = quotes(page);
		await page.addInitScript(() => { (window as unknown as { __STRIPE_WALLETS: object }).__STRIPE_WALLETS = { googlePay: true }; });

		await addToCart(page, PRODUCT.mug.slug);
		const drawer = page.getByTestId('cart-express-buttons');
		// The stub draws no button iframe, so "shown" is the component's own state (it is display-hidden until quoted).
		await expect(drawer).toHaveAttribute('aria-hidden', 'false', { timeout: 15_000 });
		await expect(drawer.getByText(/or continue below/i), 'no continue line outside checkout').toHaveCount(0);
		const cart = await mainCart(page);

		const { quote, confirmed } = await driveWallet(page, seenQuotes);
		expect(confirmed.failed, 'the wallet payment was not refused').toBeUndefined();
		expect(posts, 'exactly one order, from the shopper\'s own cart').toHaveLength(1);
		expect(posts[0]!.cartToken).toBe(cart.token);
		const confirm = (await stub.calls()).filter((c) => c.fn === 'confirmPayment');
		expect(confirm).toHaveLength(1);
		const intent = (await mock.stripeIntents()).find((i) => i.client_secret === confirm[0]!.clientSecret)!;
		expect(intent.amount, 'charged amount = the total the wallet showed').toBe(quote.body.cart.grandTotal);
		expect((await api.order(intent.metadata.orderCode!)).grandTotal).toBe(quote.body.cart.grandTotal);
		stub.assertReached();
	});

	test('PDP buy-now: hidden without a variant, one unit of the selected variant through its own cart', async ({ apiProxyPage: page, api }) => {
		test.skip(process.env.E2E_PLATFORM_PROBE !== '1', 'needs E2E_PLATFORM_PROBE=1 (the buy-now probe route): did not run, missing coverage');
		const posts = checkoutPostCounter(page);
		const stub = await installStripeStub(page);
		const seenQuotes = quotes(page);
		await page.addInitScript(() => { (window as unknown as { __STRIPE_WALLETS: object }).__STRIPE_WALLETS = { googlePay: true }; });

		// The shopper already has a cart; buy-now must leave it exactly as it is.
		await addToCart(page, PRODUCT.shirt.slug);
		const before = await mainCart(page);
		// Every cart created from here on (the shopper's cart already exists).
		const cartCreates: Array<{ body: unknown; cookie: string | undefined }> = [];
		page.on('request', async (r) => {
			if (new URL(r.url()).pathname === '/v1/shop/cart' && r.method() === 'POST') cartCreates.push({ body: r.postDataJSON(), cookie: (await r.allHeaders()).cookie });
		});

		await page.goto('/__express-buy-now-probe/');
		await expect.poll(async () => (await stub.calls()).some((c) => c.fn === 'elements.create' && c.type === 'expressCheckout')).toBe(true);
		const buttons = page.getByTestId('express-buy-now-buttons');
		await expect(buttons).toHaveAttribute('aria-hidden', 'true');
		const noVariant = await emit<{ rejected?: boolean }>(page, 'click', { expressPaymentType: 'google_pay' });
		expect(noVariant.rejected, 'no wallet sheet without a variant').toBe(true);
		expect(cartCreates, 'no buy-now cart without a variant').toHaveLength(0);

		await page.goto(`/__express-buy-now-probe/?sku=${SKU.mug}`);
		await expect(buttons).toHaveAttribute('aria-hidden', 'false', { timeout: 15_000 });
		expect((await stub.calls()).filter((c) => c.fn === 'elements.create' && c.type === 'expressCheckout').at(-1)?.options).toMatchObject({ buttonHeight: 48, buttonType: { applePay: 'buy', googlePay: 'buy' } });
		await expect(buttons.getByText(/or continue below/i)).toHaveCount(0);
		expect(cartCreates).toHaveLength(1);
		expect(cartCreates[0]!.body).toEqual({ items: [{ sku: SKU.mug, quantity: 1 }] });
		expect(cartCreates[0]!.cookie ?? '', 'created without credentials: no session or cart cookie').not.toMatch(/sr_cart=|sr_cust/);

		const { quote, confirmed } = await driveWallet(page, seenQuotes);
		expect(confirmed.failed, 'the wallet payment was not refused').toBeUndefined();
		expect(posts, 'exactly one order').toHaveLength(1);
		expect(posts[0]!.cartToken, 'the order comes from the buy-now cart').not.toBe(before.token);
		const confirm = (await stub.calls()).filter((c) => c.fn === 'confirmPayment');
		expect(confirm).toHaveLength(1);
		const intent = (await mock.stripeIntents()).find((i) => i.client_secret === confirm[0]!.clientSecret)!;
		expect(intent.amount).toBe(quote.body.cart.grandTotal);
		const order = await api.order(intent.metadata.orderCode!);
		expect((order.lines as Array<{ sku: string; quantity: number }>).map((l) => [l.sku, l.quantity])).toEqual([[SKU.mug, 1]]);

		const after = await mainCart(page);
		expect(after.token, 'the shopper cart is untouched').toBe(before.token);
		expect(after.status).toBe('active');
		expect(after.lines.map((l) => [l.sku, l.quantity])).toEqual(before.lines.map((l) => [l.sku, l.quantity]));
		stub.assertReached();
	});
});
