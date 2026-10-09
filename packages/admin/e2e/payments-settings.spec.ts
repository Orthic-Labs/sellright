import { test, expect, toast } from './fixtures';
import { uniq } from './support/api';

/**
 * Plan 1.3 #17 — Payments settings: the page renders every provider with separate test/live (sandbox/production)
 * credential sets, saving one mode never touches the other, secrets are never echoed back, and "Test connection"
 * is exercised WITHOUT any real gateway call (the verify request is fulfilled in the browser).
 * Supersedes: admin-payment-settings.db.test.ts (status/PUT shape), lib/payment-providers.test.ts.
 */
test.describe('payments settings', () => {
	const section = (page: import('@playwright/test').Page, provider: string) =>
		page.locator('section').filter({ has: page.getByRole('heading', { name: provider, exact: true }) });
	/** The test/live block inside a provider section (identified by its h3). */
	const mode = (page: import('@playwright/test').Page, provider: string, m: string) =>
		section(page, provider).locator('xpath=.//h3[normalize-space(.)=' + JSON.stringify(m) + ']/ancestor::div[contains(@class,"mb-4")][1]');

	test('renders Stripe, NMI and Sezzle with isolated test/live blocks', async ({ page }) => {
		await page.goto('/settings/payments');
		await expect(page.getByRole('heading', { name: 'Payments', level: 1 })).toBeVisible();
		await expect(page.getByText('Test and live credentials are separate')).toBeVisible();
		for (const p of ['Stripe', 'NMI', 'Sezzle']) await expect(section(page, p)).toBeVisible();
		await expect(mode(page, 'Stripe', 'test')).toBeVisible();
		await expect(mode(page, 'Stripe', 'live')).toBeVisible();
		await expect(mode(page, 'NMI', 'test')).toBeVisible();
		await expect(mode(page, 'NMI', 'live')).toBeVisible();
		await expect(mode(page, 'Sezzle', 'sandbox')).toBeVisible();
		await expect(mode(page, 'Sezzle', 'production')).toBeVisible();
		await expect(page.getByText('Every "Test connection" call is read-only')).toBeVisible();
	});

	test('saving a test-mode key marks only test configured; the secret never comes back', async ({ page, api }) => {
		const key = `pk_test_${uniq('k')}9f3a`;
		await page.goto('/settings/payments');
		const testBlock = mode(page, 'Stripe', 'test');
		const liveBlock = mode(page, 'Stripe', 'live');
		const before = await api.get('/payments/settings');
		expect(before['stripe']['live:publishableKey']).toMatchObject({ configured: false });

		const input = testBlock.getByText('Publishable key', { exact: true }).locator('xpath=following-sibling::*[1]//input');
		await input.fill(key);
		await testBlock.getByText('Publishable key', { exact: true }).locator('xpath=following-sibling::*[1]//button[normalize-space()="Save"]').click();
		await expect(toast(page, 'Saved')).toBeVisible();
		await expect(testBlock).toContainText('Configured (…9f3a)');
		// isolation: the live block is untouched
		await expect(liveBlock.getByText('Publishable key', { exact: true }).locator('xpath=following-sibling::p[1]')).toHaveText('Not configured');

		const after = await api.get('/payments/settings');
		expect(after['stripe']['test:publishableKey']).toMatchObject({ configured: true, last4: '9f3a' });
		expect(after['stripe']['live:publishableKey']).toMatchObject({ configured: false });
		expect(JSON.stringify(after)).not.toContain(key); // status endpoint never returns secret values

		// persists across a reload; the input itself stays empty (write-only)
		await page.reload();
		await expect(mode(page, 'Stripe', 'test')).toContainText('Configured (…9f3a)');
		await expect(mode(page, 'Stripe', 'test').locator('input[type="password"]').first()).toHaveValue('');
		await expect(page.locator('body')).not.toContainText(key);
	});

	test('Test connection runs per mode and makes no real gateway call (request is stubbed in the browser)', async ({ page }) => {
		const verifyCalls: string[] = [];
		await page.route('**/v1/admin/payments/settings/*/*/verify', async (route) => {
			verifyCalls.push(new URL(route.request().url()).pathname);
			await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'stubbed by e2e — no gateway contacted' }) });
		});
		// Anything the browser itself sends to a gateway origin would be a bug: fail loudly if it happens.
		const external: string[] = [];
		page.on('request', (r) => { if (!r.url().startsWith('http://127.0.0.1')) external.push(r.url()); });

		await page.goto('/settings/payments');
		await mode(page, 'Stripe', 'test').getByRole('button', { name: 'Test connection' }).click();
		await expect(toast(page, 'Connection failed')).toBeVisible();
		await expect(toast(page, 'stubbed by e2e')).toBeVisible();
		await mode(page, 'NMI', 'live').getByRole('button', { name: 'Test connection' }).click();
		await expect.poll(() => verifyCalls.length).toBe(2);
		expect(verifyCalls).toEqual([
			'/v1/admin/payments/settings/stripe/test/verify',
			'/v1/admin/payments/settings/nmi/live/verify',
		]);
		expect(external.filter((u) => !u.startsWith('data:'))).toEqual([]);
	});

	test('the Stripe mode cannot be flipped to live until live credentials exist (no copy from test)', async ({ page, api }) => {
		await page.goto('/settings');
		await page.getByRole('button', { name: 'Payments', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Payment providers' })).toBeVisible();
		const modeSelect = page.getByRole('combobox').filter({ has: page.locator('option[value="live"]') });
		await expect(modeSelect).toHaveValue('test');

		const attempt = page.waitForResponse((r) => r.url().endsWith('/settings/payments/stripe-mode') && r.request().method() === 'PATCH');
		await modeSelect.selectOption('live');
		const res = await attempt;
		expect(res.status()).toBe(409);
		expect((await res.json()).error.message).toContain('Stripe live credentials are not configured');

		// still on test, and the live credential set is still empty even though the test set has a key
		expect((await api.get('/settings/store')).stripeMode).toBe('test');
		const status = await api.get('/payments/settings');
		expect(status['stripe']['live:secretKey']).toMatchObject({ configured: false });
		expect(status['stripe']['live:publishableKey']).toMatchObject({ configured: false });
	});
});
