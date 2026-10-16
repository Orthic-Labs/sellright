import { test, expect, row, toast, field } from './fixtures';
import { createOrder, createPendingOrder, ensureCustomer, uniq } from './support/api';
import { readRows } from './support/db';

/**
 * Plan 1.3 #13 — Customers: list counts == detail (regression for the C1 list bug that showed 0 / $0),
 * create, edit profile, tags.
 * Supersedes: admin-reports.customers.db.test.ts.
 */
test.describe('customers', () => {
	test('list order count and spend equal the customer detail page (paid orders only)', async ({ page, api }) => {
		const tag = uniq('cc');
		const email = `${tag}@example.net`;
		await ensureCustomer(api, email, 'Cora', 'Counted');
		const a = await createOrder(api, { email });
		const b = await createOrder(api, { email });
		await createPendingOrder(api, { email }); // unpaid: must not count
		const spent = a.grandTotal + b.grandTotal;
		const idle = `${tag}-idle@example.net`;
		await ensureCustomer(api, idle, 'Ida', 'Idle');

		await page.goto('/customers');
		await page.getByLabel('Search name or email').fill(tag);
		const listRow = row(page, email);
		await expect(listRow).toHaveCount(1);
		const listOrders = Number(await listRow.getByRole('cell').nth(2).innerText());
		const listSpent = (await listRow.getByRole('cell').nth(3).innerText()).trim();
		expect(listOrders).toBe(2);
		expect(listSpent).toBe(`$${(spent / 100).toFixed(2)}`);

		// the customer with no orders reads 0 / $0.00, not stale or blank
		const idleRow = row(page, idle);
		await expect(idleRow.getByRole('cell').nth(2)).toHaveText('0');
		await expect(idleRow.getByRole('cell').nth(3)).toHaveText('$0.00');

		await listRow.click();
		await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}$/);
		await expect(page.getByRole('heading', { name: 'Cora Counted' })).toBeVisible();
		await expect(page.getByText(/^2 orders$/)).toBeVisible();
		await expect(page.getByText('Total spent').locator('xpath=../following-sibling::*[1]')).toHaveText(listSpent);
		// order history shows all three orders (including the unpaid one), counts exclude it
		await expect(page.getByText('3 most recent orders')).toBeVisible();

		// and the API agrees with both screens
		const apiList = await api.get<{ items: { email: string; orders: number; spent: number }[] }>(`/customers?q=${tag}`);
		const mine = apiList.items.find((c) => c.email === email)!;
		expect(mine).toMatchObject({ orders: 2, spent });
	});

	test('edit profile saves name, phone and tags', async ({ page, api }) => {
		const email = `${uniq('ce')}@example.net`;
		await ensureCustomer(api, email, 'Edie', 'Before');
		const list = await api.get<{ items: { id: string; email: string }[] }>(`/customers?q=${encodeURIComponent(email)}`);
		const id = list.items.find((c) => c.email === email)!.id;

		await page.goto(`/customers/${id}`);
		await page.getByRole('button', { name: 'Edit' }).click();
		await field(page, 'First name').fill('Edith');
		await field(page, 'Last name').fill('After');
		await field(page, 'Phone').fill('+15555550123');
		await field(page, 'Tags (comma-separated)').fill('vip, wholesale');
		const patch = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().includes(`/customers/${id}`));
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		expect((await patch).postDataJSON()).toMatchObject({ firstName: 'Edith', lastName: 'After', phone: '+15555550123', tags: ['vip', 'wholesale'] });
		await expect(toast(page, 'Customer saved')).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Edith After' })).toBeVisible();
		await expect(page.getByText('+15555550123')).toBeVisible();

		const [stored] = await readRows<{ first_name: string; phone: string; tags: string[] }>(api, 'select first_name, phone, tags from customer where id = $1', [id]);
		expect(stored).toMatchObject({ first_name: 'Edith', phone: '+15555550123', tags: ['vip', 'wholesale'] });

		// clearing the tags field removes them
		await page.getByRole('button', { name: 'Edit' }).click();
		await field(page, 'Tags (comma-separated)').fill('');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(toast(page, 'Customer saved')).toBeVisible();
		const [cleared] = await readRows<{ tags: string[] | null }>(api, 'select tags from customer where id = $1', [id]);
		expect(cleared!.tags).toBeNull();
	});

	test('new customer: created from the list, then a duplicate email is rejected', async ({ page }) => {
		const email = `${uniq('cn')}@example.net`;
		await page.goto('/customers');
		await page.getByRole('button', { name: 'New customer' }).click();
		await page.getByLabel('Email', { exact: true }).fill(email);
		await page.getByLabel('First name').fill('Nina');
		await page.getByLabel('Last name').fill('Newcomer');
		await page.getByRole('button', { name: 'Create customer' }).click();
		await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}$/);
		await expect(page.getByRole('heading', { name: 'Nina Newcomer' })).toBeVisible();

		await page.goto('/customers');
		await page.getByRole('button', { name: 'New customer' }).click();
		await page.getByLabel('Email', { exact: true }).fill(email);
		await page.getByRole('button', { name: 'Create customer' }).click();
		await expect(page.getByText('a customer with that email already exists')).toBeVisible();
		await expect(page).toHaveURL(/\/customers$/);
	});

	// Regression: GET /v1/admin/customers/{id} used to omit `tags`, so the Edit form opened with an empty Tags field and
	// any other save (say, a corrected surname) sent tags: null and wiped them. The API now returns tags and the form
	// only sends tags it loaded and the user changed.
	test('editing a name keeps the customer\'s existing tags', async ({ page, api }) => {
		const email = `${uniq('ct')}@example.net`;
		const created = await api.post<{ id: string }>('/customers', { email, firstName: 'Tara', lastName: 'Tagged', tags: ['vip'] });
		await page.goto(`/customers/${created.id}`);
		await page.getByRole('button', { name: 'Edit' }).click();
		await field(page, 'Last name').fill('Renamed');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(toast(page, 'Customer saved')).toBeVisible();
		const [stored] = await readRows<{ tags: string[] | null }>(api, 'select tags from customer where id = $1', [created.id]);
		expect(stored!.tags).toEqual(['vip']);
	});
});
