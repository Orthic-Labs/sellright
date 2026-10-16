import { test, expect } from './fixtures';

/**
 * A12 — loader AND action re-export probe. Routes src/routes/__platform-reexport-probe/{index,second}/ re-export the
 * routeLoader$ and routeAction$ (zod$) DEFINED in src/platform/probe.ts. Asserts: SSR renders the loader value; client
 * navigation renders it; a Form submit with a valid value returns the action result; an invalid value returns the zod
 * failure shape (failed + fieldErrors); a thrown server error is a failed action, not a crashed page; the action works
 * after resume; a second route file re-exporting the same loader and action works.
 *
 * If ANY assertion fails the plan says stop: L3 pages keep their own loader/action definitions and Adrian decides the
 * layer model. Skipped (= missing coverage, reported as such) unless E2E_PLATFORM_PROBE=1 is set for BOTH the runner and
 * the storefront server (the probe answers 404 otherwise; Playwright's webServer inherits the runner's environment).
 * NEVER RUN when this file was written.
 */
test.skip(process.env.E2E_PLATFORM_PROBE !== '1', 'needs E2E_PLATFORM_PROBE=1: did not run, missing coverage');

const PROBE = '/__platform-reexport-probe/';
const SECOND = '/__platform-reexport-probe/second/';

test.describe('platform re-export probe', () => {
	test('SSR renders the re-exported loader value, with scripts disabled', async ({ browser }) => {
		const ctx = await browser.newContext({ javaScriptEnabled: false });
		const page = await ctx.newPage();
		const res = await page.goto(PROBE);
		expect(res?.status()).toBe(200);
		await expect(page.getByTestId('probe-loader')).toHaveText('probe-loader-value');
		await ctx.close();
	});

	test('client navigation to a second route that re-exports the same loader renders it', async ({ page }) => {
		await page.goto(PROBE);
		await expect(page.getByTestId('probe-resumed')).toHaveText('yes', { timeout: 20_000 });
		await page.getByTestId('probe-link-second').click();
		await expect(page).toHaveURL(new RegExp(`${SECOND}$`));
		await expect(page.getByTestId('probe-loader')).toHaveText('probe-loader-value');
	});

	test('valid Form submit returns the action result, after resume', async ({ page }) => {
		await page.goto(PROBE);
		await expect(page.getByTestId('probe-resumed')).toHaveText('yes', { timeout: 20_000 });
		await page.getByTestId('probe-word').fill('hello');
		await page.getByTestId('probe-submit').click();
		await expect(page.getByTestId('probe-result')).toHaveText('hello');
		await expect(page.getByTestId('probe-failed')).toHaveCount(0);
	});

	test('invalid value returns the zod failure shape (failed + fieldErrors.word)', async ({ page }) => {
		await page.goto(PROBE);
		await expect(page.getByTestId('probe-resumed')).toHaveText('yes', { timeout: 20_000 });
		await page.getByTestId('probe-word').fill('ab');
		await page.getByTestId('probe-submit').click();
		const failed = page.getByTestId('probe-failed');
		await expect(failed).toBeVisible();
		const shape = JSON.parse((await failed.textContent()) ?? '{}') as { word?: string | string[] };
		expect(JSON.stringify(shape.word)).toContain('at least 3');
		await expect(page.getByTestId('probe-result')).toHaveCount(0);
	});

	test('a thrown server error is a failed action, not a crashed page', async ({ page }) => {
		await page.goto(PROBE);
		await expect(page.getByTestId('probe-resumed')).toHaveText('yes', { timeout: 20_000 });
		await page.getByTestId('probe-word').fill('explode');
		const actionResponse = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/__platform-reexport-probe/'));
		await page.getByTestId('probe-submit').click();
		expect((await actionResponse).status()).toBeGreaterThanOrEqual(500);
		await expect(page.getByRole('heading', { name: 'platform re-export probe' })).toBeVisible();
		await expect(page.getByTestId('probe-loader')).toHaveText('probe-loader-value');
		await expect(page.getByTestId('probe-result')).toHaveCount(0);
		// the page still works afterwards
		await page.getByTestId('probe-word').fill('recovered');
		await page.getByTestId('probe-submit').click();
		await expect(page.getByTestId('probe-result')).toHaveText('recovered');
	});

	test('the second route file re-exporting the same action works', async ({ page }) => {
		await page.goto(SECOND);
		await expect(page.getByTestId('probe-loader')).toHaveText('probe-loader-value');
		await page.getByTestId('probe-word').fill('second');
		await page.getByTestId('probe-submit').click();
		await expect(page.getByTestId('probe-result')).toHaveText('second');
	});
});
