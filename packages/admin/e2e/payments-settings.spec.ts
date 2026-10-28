import { test, expect, toast } from './fixtures';
import { uniq } from './support/api';

/**
 * Plan 1.3 #17 — Payments settings: the page renders every provider with separate test/live (sandbox/production)
 * credential sets, saving one mode never touches the other, secrets are never echoed back, and "Test connection"
 * is exercised WITHOUT any real gateway call (the verify request is fulfilled in the browser).
 * Supersedes: admin-payment-settings.db.test.ts (status/PUT shape), lib/payment-providers.test.ts.
 */
test.describe('payments settings', () => {
	type Pg = import('@playwright/test').Page;
	/** One provider card (a section labelled by its h2). */
	const section = (page: Pg, provider: string) =>
		page.locator('section.card').filter({ has: page.getByRole('heading', { name: provider, exact: true }) });
	/** Switch which key set a card DISPLAYS (the "Showing" control; it never changes the mode checkout uses). */
	const showKeys = (page: Pg, provider: string, label: string) => section(page, provider).getByRole('radio', { name: `${label} keys` }).click();
	const keyRow = (page: Pg, provider: string, label: string) => section(page, provider).locator('.setrow').filter({ has: page.getByText(label, { exact: true }) });

	test('renders Stripe, NMI and Sezzle with isolated test/live blocks', async ({ page }) => {
		await page.goto('/settings/payments');
		await expect(page.getByRole('heading', { name: 'Payments', level: 1 })).toBeVisible();
		await expect(page.getByText('Test and live keys are kept apart')).toBeVisible();
		for (const p of ['Stripe', 'NMI', 'Sezzle']) await expect(section(page, p)).toBeVisible();
		for (const [p, a, b] of [['Stripe', 'Test', 'Live'], ['NMI', 'Test', 'Live'], ['Sezzle', 'Sandbox', 'Production']] as const) {
			await expect(section(page, p).getByRole('radio', { name: `${a} keys` })).toBeVisible();
			await expect(section(page, p).getByRole('radio', { name: `${b} keys` })).toBeVisible();
			await expect(section(page, p).getByText(/Testing is read-only/)).toBeVisible();
		}
	});

	test('saving a test-mode key marks only test configured; the secret never comes back', async ({ page, api }) => {
		const key = `pk_test_${uniq('k')}9f3a`;
		await page.goto('/settings/payments');
		const before = await api.get('/payments/settings');
		expect(before['stripe']['live:publishableKey']).toMatchObject({ configured: false });

		await showKeys(page, 'Stripe', 'Test');
		await keyRow(page, 'Stripe', 'Publishable key').getByRole('button', { name: /^(Add key|Replace)$/ }).click();
		const dialog = page.getByRole('dialog');
		await dialog.getByLabel('New publishable key').fill(key);
		await dialog.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(toast(page, 'Publishable key saved')).toBeVisible();
		await expect(keyRow(page, 'Stripe', 'Publishable key')).toContainText('9f3a');
		// isolation: the live key set is untouched
		await showKeys(page, 'Stripe', 'Live');
		await expect(keyRow(page, 'Stripe', 'Publishable key')).toContainText('Not set');

		const after = await api.get('/payments/settings');
		expect(after['stripe']['test:publishableKey']).toMatchObject({ configured: true, last4: '9f3a' });
		expect(after['stripe']['live:publishableKey']).toMatchObject({ configured: false });
		expect(JSON.stringify(after)).not.toContain(key); // status endpoint never returns secret values

		// persists across a reload; the key is never shown again and the replace input starts empty (write-only)
		await page.reload();
		await expect(keyRow(page, 'Stripe', 'Publishable key')).toContainText('9f3a');
		await expect(page.locator('body')).not.toContainText(key);
		await keyRow(page, 'Stripe', 'Publishable key').getByRole('button', { name: 'Replace' }).click();
		await expect(page.getByRole('dialog').locator('input[type="password"]')).toHaveValue('');
		await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
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
		page.on('request', (r) => { if (!r.url().startsWith('http://127.0.0.1') && !r.url().startsWith('http://localhost')) external.push(r.url()); });

		await page.goto('/settings/payments');
		await showKeys(page, 'Stripe', 'Test');
		await section(page, 'Stripe').getByRole('button', { name: 'Test connection' }).click();
		await expect(section(page, 'Stripe').getByRole('status').filter({ hasText: 'Connection failed' })).toContainText('stubbed by e2e');
		await showKeys(page, 'NMI', 'Live');
		await section(page, 'NMI').getByRole('button', { name: 'Test connection' }).click();
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
		// the refusal is shown to the operator (not swallowed), and the select snaps back to the stored mode
		await expect(toast(page, 'Could not switch Stripe mode')).toBeVisible();
		await expect(page.getByText('Stripe live credentials are not configured').first()).toBeVisible();
		await expect(modeSelect).toHaveValue('test');

		// still on test, and the live credential set is still empty even though the test set has a key
		expect((await api.get('/settings/store')).stripeMode).toBe('test');
		const status = await api.get('/payments/settings');
		expect(status['stripe']['live:secretKey']).toMatchObject({ configured: false });
		expect(status['stripe']['live:publishableKey']).toMatchObject({ configured: false });
	});
});
