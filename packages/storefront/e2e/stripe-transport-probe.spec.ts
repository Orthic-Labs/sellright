import { test, expect } from './fixtures';
import { API_URL, STRIPE_ENABLED } from './support/env.mjs';
import { clientIp, shopCheckout, uniq } from './support/api';
import { mock } from './support/mock';

/**
 * A6 item 1 — the transport probe. Which path does stripe-node in the API use to reach api.stripe.com: globalThis.fetch
 * or node:https? preload.mjs reroutes BOTH to the mock and tags each call `x-e2e-via`, so one real PaymentIntent mint
 * answers it. The result is attached to the test as the `stripe-transport` annotation and must be copied into the
 * task report. Needs E2E_STRIPE=1 (Stripe test-mode settings seeded by global-setup.ts); without it the probe is
 * SKIPPED, which counts as missing coverage, not a pass.
 */
test.skip(!STRIPE_ENABLED, 'E2E_STRIPE=1 not set: Stripe is not seeded, so the transport probe did not run (missing coverage)');

test('stripe-node reaches the mock through fetch or https, and the mint is idempotent per order', async () => {
	await mock.reset();
	const placed = await shopCheckout({ email: `${uniq('probe')}@e2e.example.net` });
	const mint = () => fetch(`${API_URL}/v1/shop/orders/${placed.code}/payment-intent`, { method: 'POST', headers: { 'x-receipt-token': placed.receiptToken, 'x-real-ip': clientIp() } });
	const first = await mint();
	expect(first.status, 'POST payment-intent').toBe(200);
	const a = (await first.json()) as { clientSecret: string; intentId: string };
	expect(a.intentId).toMatch(/^pi_e2e_/);

	const calls = (await mock.stripeCalls()).filter((c) => c.path === '/v1/payment_intents' && c.method === 'POST');
	expect(calls.length, 'the API must have called the mock /stripe, not the real api.stripe.com').toBeGreaterThanOrEqual(1);
	const via = calls[0]!.via;
	test.info().annotations.push({ type: 'stripe-transport', description: via });
	expect(['fetch', 'https'], 'unknown = request arrived without the preload tag').toContain(via);

	// A second mint for the same order+amount replays the same intent (the API keys the create on the order).
	const b = (await (await mint()).json()) as { intentId: string };
	expect(b.intentId).toBe(a.intentId);
});
