import { test, expect, field, toast } from './fixtures';

/**
 * Store profile: the storefront URL (config.storefrontUrl) is settable from Settings > Store. Payment return links
 * and email links are built from it, and nothing else on the admin surface writes it.
 */
test.describe('store settings: storefront URL', () => {
	test('saves a normalised https URL, rejects a non-https one, and can clear it', async ({ page, api }) => {
		await page.goto('/settings');
		await page.getByRole('button', { name: 'Edit profile' }).click();

		await field(page, 'Storefront URL').fill('http://shop.example.com');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(toast(page, 'Could not save store profile')).toBeVisible();
		expect((await api.get('/settings/store')).storefrontUrl).toBeNull();

		await field(page, 'Storefront URL').fill('https://shop.example.com/');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(page.getByText('https://shop.example.com', { exact: true })).toBeVisible();
		expect((await api.get('/settings/store')).storefrontUrl).toBe('https://shop.example.com');

		await page.getByRole('button', { name: 'Edit profile' }).click();
		await field(page, 'Storefront URL').fill('');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(page.getByText('Not set')).toBeVisible();
		expect((await api.get('/settings/store')).storefrontUrl).toBeNull();
	});
});
