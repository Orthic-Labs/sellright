import { test as base, expect, type Page } from '@playwright/test';
import { AdminApi } from './support/api';

/**
 * `api` is a signed-in owner API client (bearer, worker-scoped) for arranging state and reading the
 * live truth back. The browser itself is already signed in via storageState (see global-setup.ts).
 */
export const test = base.extend<object, { api: AdminApi }>({
	api: [async ({}, use) => { await use(await AdminApi.login()); }, { scope: 'worker' }],
});
export { expect };

/** Table row containing `text` (order code, email, SKU…). */
export const row = (page: Page, text: string | RegExp) => page.getByRole('row').filter({ hasText: text });

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Toast text is rendered twice (visible stack + polite live region) — always take the first match. */
export const toast = (page: Page, text: string | RegExp) => page.getByText(text).first();

/** The input/select/textarea that follows a <label> whose text is exactly `label` (labels in this app are not always bound with htmlFor). */
export const field = (scope: Page | import('@playwright/test').Locator, label: string) =>
	scope.locator(`xpath=.//label[normalize-space(.)=${JSON.stringify(label)}]/following-sibling::*[self::input or self::select or self::textarea][1]`);

/**
 * goto() that survives the SPA's post-login `location.assign('/')`: right after a UI sign-in the router has already
 * moved to '/', so a following goto() can be aborted by that still-pending full navigation. Retry on exactly that error.
 */
export async function gotoStable(page: Page, url: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try { await page.goto(url); return; } catch (e) {
			if (attempt >= 3 || !/interrupted by another navigation/.test(String(e))) throw e;
			await page.waitForLoadState('load').catch(() => undefined);
		}
	}
}
