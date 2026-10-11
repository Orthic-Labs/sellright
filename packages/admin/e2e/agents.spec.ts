import { expect, field, test } from './fixtures';
import { AdminApi, uniq } from './support/api';
import { ADMIN_URL, API_URL } from './support/env.mjs';

test.describe('agent access', () => {
	test('owner creates a staff-role agent; the admin UI runs as the agent (edit allowed, delete refused); remove revokes', async ({ page, browser, api }) => {
		const slug = uniq('agent-prod');
		const created = await (api as AdminApi).post<{ id: string }>('/products', { name: 'Agent fixture', slug, status: 'draft' });

		await page.goto('/staff');
		await page.getByLabel('Agent name').fill(uniq('E2E bot '));
		await page.getByLabel('Agent role').selectOption('staff');
		await page.getByRole('button', { name: 'Create agent' }).click();
		const token = (await page.getByTestId('agent-token').textContent())?.trim() ?? '';
		expect(token.startsWith('sra_')).toBe(true);
		await page.getByRole('button', { name: 'Done' }).click();

		const me = await fetch(`${API_URL}/v1/admin/me`, { headers: { authorization: `Bearer ${token}` } });
		const meBody = (await me.json()) as { email: string };
		expect(meBody).toMatchObject({ kind: 'agent', auth: 'api_token', stores: [{ role: 'staff' }] });
		// the Staff list row shows the synthetic e-mail (not the name) plus the Agent badge; the AgentAccess card row shows the name
		const staffRow = page.getByRole('row', { name: new RegExp(meBody.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).filter({ has: page.getByRole('button', { name: 'Remove' }) });
		await expect(staffRow.getByText('Agent', { exact: true })).toBeVisible();
		await expect(page.getByRole('row', { name: /E2E bot /, exact: false }).first().getByRole('button', { name: 'Rotate' })).toBeVisible();
		expect((await fetch(`${API_URL}/v1/admin/products/${created.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })).status).toBe(403);

		const ctx = await browser.newContext({ baseURL: ADMIN_URL, storageState: { cookies: [], origins: [] } });
		const agentPage = await ctx.newPage();
		await agentPage.goto('/login');
		expect(await agentPage.evaluate(async (t) => (await fetch('/v1/admin/agents/browser-session', { method: 'POST', headers: { authorization: `Bearer ${t}` } })).status, token)).toBe(200);
		await agentPage.goto(`/products/${created.id}`);
		await field(agentPage, 'Description').fill('edited by the agent');
		await agentPage.getByRole('button', { name: /^Save/ }).click();
		await expect.poll(async () => ((await (api as AdminApi).get<{ description: string | null }>(`/products/${created.id}`)).description)).toBe('edited by the agent');
		await ctx.close();

		await staffRow.getByRole('button', { name: 'Remove' }).click();
		await page.getByRole('alertdialog').getByRole('button', { name: /Remove/ }).click();
		await expect(staffRow).toHaveCount(0);
		await expect(page.getByRole('row', { name: /E2E bot/ })).toHaveCount(0);
		expect((await fetch(`${API_URL}/v1/admin/me`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
	});
});
