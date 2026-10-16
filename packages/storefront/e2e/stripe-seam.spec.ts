import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test, expect } from './fixtures';
import { STORE_SLUG, STOREFRONT_DIR, STRIPE, STRIPE_ENABLED } from './support/env.mjs';
import { uniq, shopCheckout } from './support/api';
import { mock, postStripeWebhook } from './support/mock';
import { installStripeStub, installedSdkScriptUrl } from './support/stripe-stub';

/**
 * A6 — the Stripe seam. Runs against the SCRATCH-ONLY fixture route /__stripe-seam-fixture/ (e2e/scratch/
 * stripe-seam-fixture.tsx, copied in by e2e/support/scratch-layout.sh), which drives the installed `loadStripe` the way
 * Rotten's StripePaymentElement does. Proves: the real request for Stripe.js reached the stub (and nothing to
 * js.stripe.com failed), the URL equals the installed SDK's, an intent is minted at the mock, approve and decline paths,
 * the signed webhook is accepted by the API's real verification, and no request leaves the machine.
 *
 * Skipped (= missing coverage, reported as such) unless E2E_STRIPE=1 (settings seeded) AND E2E_STRIPE_SEAM=1 (the
 * fixture route exists in the tree under test). E2E_STRIPE_SDK_ENTRY overrides which installed SDK to compare against.
 */
test.skip(!STRIPE_ENABLED || process.env.E2E_STRIPE_SEAM !== '1', 'needs E2E_STRIPE=1 and E2E_STRIPE_SEAM=1 (scratch fixture route installed): did not run, missing coverage');

const sdkEntry = process.env.E2E_STRIPE_SDK_ENTRY
	?? join(dirname(createRequire(join(STOREFRONT_DIR, 'package.json')).resolve('@stripe/stripe-js')), 'index.mjs');

async function openFixture(page: import('@playwright/test').Page, code: string, token: string) {
	const external = new Set<string>();
	page.on('request', (r) => { const h = new URL(r.url()).hostname; if (!['127.0.0.1', 'localhost'].includes(h)) external.add(h); });
	const stub = await installStripeStub(page);
	await page.goto(`/__stripe-seam-fixture/?code=${encodeURIComponent(code)}&token=${encodeURIComponent(token)}&pk=${STRIPE.publishableKey}`);
	await expect(page.getByTestId('seam-state')).toHaveText('ready', { timeout: 20_000 });
	return { stub, external };
}

test.describe('Stripe seam', () => {
	test('approve path: stub reached, URL matches the installed SDK, intent minted, paid, webhook accepted, nothing leaves the machine', async ({ apiProxyPage: page, api }) => {
		await mock.reset();
		const placed = await shopCheckout({ email: `${uniq('seam')}@e2e.example.net` });
		const { stub, external } = await openFixture(page, placed.code, placed.receiptToken);

		stub.assertReached(installedSdkScriptUrl(sdkEntry));
		expect(await stub.calls(), 'elements({mode}) and a payment element were created and mounted').toEqual(expect.arrayContaining([
			expect.objectContaining({ fn: 'elements', opts: expect.objectContaining({ mode: 'payment' }) }),
			expect.objectContaining({ fn: 'elements.create', type: 'payment' }),
			expect.objectContaining({ fn: 'mount' }),
		]));

		const intents = await mock.stripeIntents();
		const intent = intents.find((i) => i.metadata.orderCode === placed.code);
		expect(intent, 'a PaymentIntent for this order exists at the mock').toBeTruthy();
		expect(intent!.amount).toBe(placed.grandTotal);

		await page.evaluate(() => (window as unknown as { __seamPay: () => Promise<void> }).__seamPay());
		await expect(page.getByTestId('seam-state')).toHaveText('paid', { timeout: 20_000 });
		expect(await stub.calls()).toEqual(expect.arrayContaining([
			expect.objectContaining({ fn: 'elements.submit' }),
			expect.objectContaining({ fn: 'confirmPayment', hasElements: true, clientSecret: intent!.client_secret }),
		]));
		expect((await api.order(placed.code)).state).toBe('Paid');

		// The signed webhook runs the API's real constructEvent; re-delivery after /pay is an idempotent no-op.
		expect(await postStripeWebhook({
			id: `evt_seam_${placed.code}`, object: 'event', api_version: '2024-06-20', created: Math.floor(Date.now() / 1000), type: 'payment_intent.succeeded',
			data: { object: { id: intent!.id, object: 'payment_intent', amount: placed.grandTotal, currency: 'usd', status: 'succeeded', metadata: { orderCode: placed.code, storeId: intent!.metadata.storeId } } },
		}, STORE_SLUG)).toBe(200);

		expect([...external], 'only the (stubbed) Stripe.js host was ever requested off-machine').toEqual(['js.stripe.com']);
		expect(stub.failed).toEqual([]);
	});

	test('decline path: confirmPayment errors, the order stays PendingPayment', async ({ apiProxyPage: page, api }) => {
		await mock.reset();
		const placed = await shopCheckout({ email: `${uniq('seam')}@e2e.example.net` });
		const { stub } = await openFixture(page, placed.code, placed.receiptToken);
		stub.assertReached(installedSdkScriptUrl(sdkEntry));
		await page.evaluate(() => { (window as unknown as { __STRIPE_OUTCOME: string }).__STRIPE_OUTCOME = 'declined'; });
		await page.evaluate(() => (window as unknown as { __seamPay: () => Promise<void> }).__seamPay());
		await expect(page.getByTestId('seam-state')).toHaveText('declined', { timeout: 20_000 });
		await expect(page.getByTestId('seam-detail')).toContainText(/declined/i);
		expect((await api.order(placed.code)).state).toBe('PendingPayment');
	});

	test('a request to a js.stripe.com URL the pattern does not cover fails the proof instead of passing silently', async ({ apiProxyPage: page }) => {
		const stub = await installStripeStub(page);
		await page.goto('/');
		await page.evaluate(() => { const s = document.createElement('script'); s.src = 'https://js.stripe.com/not-a-release-train'; document.head.appendChild(s); });
		await expect.poll(() => stub.failed.length).toBeGreaterThan(0);
		expect(() => stub.assertReached()).toThrow(/failed|no request reached/);
	});
});
