/** Signed-in shopper helpers for the account specs: register through the real sign-in UI, verify by the emailed link,
 *  and sign in by password or by the emailed magic link — every step exactly as a customer does it. */
import { expect, type Page } from '@playwright/test';
import { mailTo } from './api';
import { linkInMail } from './mock';

export const PASSWORD = 'Correct-horse-battery-9';

/** /sign-in: fills the email on the one combined screen (email + password + sign in); the password field is always there. */
export async function startSignIn(page: Page, email: string): Promise<void> {
	await page.goto('/sign-in');
	await page.waitForLoadState('networkidle');
	const field = page.getByPlaceholder('you@example.com').first();
	await expect(async () => {
		await field.fill(email);
		await expect(field).toHaveValue(email, { timeout: 1_000 });
		await expect(page.locator('input[autocomplete="current-password"]')).toBeVisible({ timeout: 4_000 });
	}).toPass({ timeout: 20_000 });
}

/** Create an account through the sign-up form, then follow the verification link from the SMTP sink. */
export async function registerAndVerify(page: Page, email: string, who = { first: 'Ada', last: 'Account' }): Promise<void> {
	await startSignIn(page, email);
	await page.getByRole('button', { name: /^create an account$/i }).click();
	await expect(page.getByRole('heading', { name: /create your account/i })).toBeVisible();
	await page.locator('input[autocomplete="given-name"]').fill(who.first);
	await page.locator('input[autocomplete="family-name"]').fill(who.last);
	await page.locator('input[autocomplete="new-password"]').nth(0).fill(PASSWORD);
	await page.locator('input[autocomplete="new-password"]').nth(1).fill(PASSWORD);
	await page.getByRole('button', { name: /create account/i }).click();
	await expect(page.getByText(/we sent a verification link/i)).toBeVisible({ timeout: 15_000 });

	const mail = await mailTo(email, (m) => !!linkInMail(m, '/verify?token='), 'verification email');
	await page.goto(linkInMail(mail, '/verify?token=')!);
	await expect(page.getByText(/email verified successfully/i)).toBeVisible({ timeout: 15_000 });
}

/** Password sign-in through the UI; resolves once the account area has loaded. */
export async function signInWithPassword(page: Page, email: string, password = PASSWORD): Promise<void> {
	await startSignIn(page, email);
	await page.locator('input[autocomplete="current-password"]').fill(password);
	await page.getByRole('button', { name: /^sign in$/i }).click();
	await page.waitForURL('**/account**', { timeout: 20_000 });
}
