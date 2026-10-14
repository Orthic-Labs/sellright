import http from 'node:http';
import { test, expect } from './fixtures';
import { AdminApi, readRows, uniq, writeSetup } from './support/api';
import { STORE_URL } from './support/env.mjs';

/**
 * The license commerce flow (VITE_SR_COMMERCE_FLOW=license), rendered. Runs only against a license build with the fixture brand data:
 *
 *   VITE_SR_COMMERCE_FLOW=license SELLRIGHT_BRAND_DATA_DIR=src/platform/license/__fixtures__/brand-data VITE_SELLRIGHT_STORE_SLUG=e2e pnpm run e2e:build
 *   E2E_LICENSE_FLOW=1 E2E_STORE_READY_PATH=/account/ npx playwright test e2e/license-flow.spec.ts
 *
 * Fixture hosts: alpha.test (default, collection e2e-alpha, legal contract configured) and beta.test (its app's checkout paused).
 * Stripe stays unconfigured, so a checkout ends at the inert "payment not switched on" state with the order reserved.
 */
const ON = process.env.E2E_LICENSE_FLOW === '1';
const SKU_ALPHA = 'E2E-ALPHA-PRO';
const SKU_BETA = 'E2E-BETA-PRO';

function manifest(appKey: string) {
	const doc = (role: string, treatment: string, material: boolean) => ({
		id: `${appKey}-${role}`, role, title: `${appKey} ${role}`, version: '1.0', sha256: 'a'.repeat(64), path: `${role.toUpperCase()}.md`,
		publicUrl: `https://${appKey}.example.com/legal/${role}/`, treatment, material,
	});
	return {
		schema: 2, suite: 'right-suite-desktop', appKey, productName: 'AlphaApp', licensor: 'E2E Co', effectiveDate: '2026-08-01',
		acceptanceVersion: `${appKey}-2026-08-01-v1`,
		documents: [doc('license', 'agree', true), doc('eula', 'agree', true), doc('acceptable_use', 'agree', true), doc('product_schedule', 'agree', true), doc('privacy_notice', 'acknowledge', false), doc('third_party_notices', 'notice', false)],
	};
}

/** SSR with an explicit Host (the browser cannot set one): the variant is picked from it. */
function ssr(path: string, host: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
	const u = new URL(path, STORE_URL);
	return new Promise((resolve, reject) => {
		http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { host } }, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (c) => (body += c));
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
		}).on('error', reject);
	});
}

test.describe('license commerce flow (license build)', () => {
	test.skip(!ON, 'needs E2E_LICENSE_FLOW=1 and a license build with the fixture brand data: did not run, missing coverage');

	test.beforeAll(async () => {
		const api = await AdminApi.login();
		const have = new Set((await api.get<{ items: { slug: string }[] }>('/collections')).items.map((c) => c.slug));
		for (const [app, sku, price] of [['alpha', SKU_ALPHA, 4900], ['beta', SKU_BETA, 2900]] as const) {
			if (have.has(`e2e-${app}`)) continue;
			const { id } = await api.post<{ id: string }>('/products', { name: `E2E ${app} Pro`, slug: `e2e-${app}-pro`, status: 'active' });
			await api.post(`/products/${id}/variants`, { sku, name: 'Pro', price, fulfillmentType: 'license', appKey: app });
			const col = await api.post<{ id: string }>('/collections', { name: `E2E ${app}`, slug: `e2e-${app}` });
			await api.post(`/collections/${col.id}/products`, { productId: id });
		}
		await writeSetup(api, `UPDATE store SET config = jsonb_set(coalesce(config, '{}'::jsonb), '{legalManifests}', $1::jsonb) WHERE id = current_setting('app.current_store')::uuid`, [JSON.stringify({ alpha: manifest('alpha') })]);
		// A settings save drops the API's 60s store-resolution cache, so checkout sees the manifest now (same value global setup saves).
		await api.patch('/settings/store', { storefrontUrl: STORE_URL });
	});

	test('the Host picks the variant: name, wordmark, canonical domain, tokens; a stripped prefix and an unknown host', async () => {
		const alpha = await ssr('/pricing/', 'store.alpha.test');
		expect(alpha.status).toBe(200);
		expect(alpha.body).toMatch(/<title[^>]*>AlphaApp — pricing &amp; licenses<\/title>/);
		expect(alpha.body).toMatch(/data-app="alpha"/);
		expect(alpha.body).toMatch(/style="--accent:#0C6AA5;--accent-hover:#095785;/);
		expect(alpha.body).toContain('href="https://alpha.test/"');
		expect(alpha.body).toContain(`/checkout/?sku=${SKU_ALPHA}`);
		const beta = await ssr('/pricing/', 'buy.beta.test');
		expect(beta.body).toMatch(/data-app="beta"/);
		expect(beta.body).toMatch(/style="--accent:#DF3400;--bg:#FBF7EF;"/);
		expect(beta.body).toContain(`/checkout/?sku=${SKU_BETA}`);
		expect(beta.body).not.toContain(SKU_ALPHA);
		expect((await ssr('/pricing/', 'unknown.example')).body).toMatch(/data-app="alpha"/);
		expect(alpha.headers['cache-control']).toMatch(/no-store/);
	});

	test('the cart storefront routes do not exist in a license build', async () => {
		for (const path of ['/shop/', '/products/e2e-shirt/', '/cart/', '/sign-in/']) expect((await ssr(path, 'alpha.test')).status, path).toBe(404);
	});

	test('pricing -> checkout: legal acceptance gates the order; the API stores the receipt; unconfigured Stripe is inert', async ({ apiProxyPage: page }) => {
		await page.goto('/pricing/');
		await page.getByRole('link', { name: 'Buy license' }).click();
		await expect(page).toHaveURL(new RegExp(`/checkout/\\?sku=${SKU_ALPHA}$`));
		await expect(page.locator('.ck-total')).toHaveText('$49');
		await expect(page.locator('.ck-legal')).toContainText('E2E legal notice.');
		const email = `${uniq('lic')}@example.com`;
		const fields: Array<[string, string]> = [['Email address', email], ['First name', 'Ada'], ['Last name', 'Lovelace'], ['Billing address', '1 Main St'], ['City', 'Springfield'], ['Postal code', '62701']];
		for (const [ph, v] of fields) await page.getByPlaceholder(ph, { exact: true }).fill(v);
		await page.getByPlaceholder('Postal code').blur();
		// Billing complete but no acceptance yet: nothing is ordered.
		await expect(page.locator('.ck-placeholder')).toHaveText('Enter your details above to continue to payment.');
		await page.locator('#legal-eligibility').selectOption('individual');
		await page.locator('.ck-legal input[type=checkbox]').check();
		await expect(page.locator('.ck-placeholder')).toContainText("Online payment isn't switched on yet");
		const code = /Order (\S+) is reserved/.exec((await page.locator('.ck-placeholder').innerText()) ?? '')?.[1];
		expect(code).toBeTruthy();
		await expect(page.locator('.ck-cta')).toBeDisabled();
		const api = await AdminApi.login();
		const rows = await readRows<{ v: string; app: string; n: number }>(api, `SELECT metadata->'legal_acceptance'->>'acceptance_version' AS v, metadata->'legal_acceptance'->>'app_key' AS app, jsonb_array_length(metadata->'legal_acceptance'->'documents') AS n FROM "order" WHERE code = $1`, [code]);
		expect(rows).toEqual([{ v: 'alpha-2026-08-01-v1', app: 'alpha', n: 5 }]);
	});

	test('a paused app and an unknown SKU have nothing to check out', async ({ apiProxyPage: page }) => {
		for (const sku of [SKU_BETA, 'NOPE-0']) {
			await page.goto(`/checkout/?sku=${sku}`);
			await expect(page.locator('main h1')).toHaveText('Nothing to check out');
		}
		expect((await ssr(`/checkout/?sku=${SKU_BETA}`, 'beta.test')).body).toContain('Nothing to check out');
	});

	test('account: register, the (empty) license list, sign out, a failed sign-in shows the generic error; magic link request', async ({ apiProxyPage: page }) => {
		const email = `${uniq('acct')}@example.com`;
		await page.goto('/account/');
		await expect(page.locator('main h1')).toHaveText('Sign in');
		await page.getByRole('link', { name: 'Create an account' }).click();
		await page.locator('#acct-reg-email').fill(email);
		await page.locator('#acct-reg-password').fill('e2e-license-password');
		await page.getByRole('button', { name: 'Create account' }).click();
		await expect(page.locator('main h1')).toHaveText('My account');
		await expect(page.getByText('No licenses yet.')).toBeVisible();
		await expect(page.getByRole('link', { name: 'Manage devices' })).toHaveCount(0);
		await page.getByRole('button', { name: 'Sign out' }).click();
		// Signing out keeps the view the shopper came from (here: create account).
		await expect(page.locator('main h1')).toHaveText('Create account');
		await page.getByRole('link', { name: 'Sign in' }).click();
		await expect(page.locator('main h1')).toHaveText('Sign in');
		await page.locator('#acct-email').fill(email);
		await page.locator('#acct-password').fill('wrong-password');
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page.locator('.err')).toHaveText('We couldn’t complete that. Check your details and try again.');
		await expect(page.locator('main h1')).toHaveText('Sign in');
		await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
		await expect(page.locator('main h1')).toHaveText('Check your email');
	});

	test('email landings: a bad magic link and a bad reset token answer the generic errors; devices is off without the feature', async ({ apiProxyPage: page }) => {
		await page.goto(`/account/magic-link/?token=${'b'.repeat(43)}`);
		await expect(page.locator('.err')).toHaveText('This link is invalid, expired, or has already been used. Request a new one below.');
		await page.goto(`/password-reset/?token=${'b'.repeat(43)}`);
		await page.locator('input[type=password]').fill('e2e-new-password');
		await page.getByRole('button', { name: 'Save new password' }).click();
		await expect(page.locator('.err')).toContainText('That reset link is invalid, expired, or already used.');
		expect((await ssr('/account/devices/', 'alpha.test')).status).toBe(404);
	});

	test('confirmation page: seller line, support address on the variant domain, the brand default legal links', async () => {
		const res = await ssr('/checkout/confirmation/E2E1/', 'alpha.test');
		expect(res.status).toBe(200);
		expect(res.body).toContain('E2E Seller LLC · 1 Test Street');
		expect(res.body).toContain('mailto:hello@alpha.test');
		expect(res.body).toContain('href="/refund"');
	});
});
