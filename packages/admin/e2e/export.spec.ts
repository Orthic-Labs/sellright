import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test, expect, toast } from './fixtures';
import { createOrder, createPendingOrder, uniq, SKU } from './support/api';
import { API_DIR } from './support/env.mjs';

const ExcelJS = createRequire(join(API_DIR, 'package.json'))('exceljs');

/** The default column set the API ships (ORDER_EXPORT_COLUMNS in admin-order-ops.ts) — the export contract. */
const DEFAULT_COLUMNS = ['code', 'date', 'email', 'state', 'preOrder', 'fulfillment', 'tracking', 'subtotal', 'discount', 'shipping', 'tax', 'total', 'currency'];

function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let cur: string[] = []; let cell = ''; let q = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
		else if (ch === '"') q = true;
		else if (ch === ',') { cur.push(cell); cell = ''; }
		else if (ch === '\n') { cur.push(cell); rows.push(cur); cur = []; cell = ''; }
		else cell += ch;
	}
	if (cell !== '' || cur.length) { cur.push(cell); rows.push(cur); }
	return rows;
}

/**
 * Plan 1.3 #12 — Order export: CSV + XLSX downloads from the dialog; columns match the API contract and
 * the filters (status, search, date range, one-row-per-line) are respected.
 * Supersedes: admin-order-ops.export.db.test.ts, the export-filter half of admin-order-ops.parity.db.test.ts, export-presets/OrderExportDialog unit tests.
 */
test.describe('order export', () => {
	const u = uniq('ex');
	let paidFulfilled: string, paidOpen: string, unpaid: string;
	const email = (t: string) => `${u}-${t}@example.net`;

	test.beforeAll(async ({ api }) => {
		paidFulfilled = (await createOrder(api, { email: email('f'), items: [{ sku: SKU.tee, quantity: 2 }, { sku: SKU.mug, quantity: 1 }] })).code;
		await api.post(`/orders/${paidFulfilled}/fulfill`, { state: 'Shipped', trackingCode: '1Z999AA10123456784', carrier: 'UPS' });
		paidOpen = (await createOrder(api, { email: email('o') })).code;
		unpaid = (await createPendingOrder(api, { email: email('p') })).code;
	});

	async function openDialog(page: import('@playwright/test').Page) {
		await page.goto('/orders');
		await page.getByRole('button', { name: 'Actions' }).click();
		await page.getByRole('menuitem', { name: 'Export orders…' }).click();
		const dialog = page.getByRole('dialog', { name: 'Export orders' });
		await expect(dialog).toBeVisible();
		await dialog.locator('#ex-q').fill(u);
		return dialog;
	}
	async function download(page: import('@playwright/test').Page, label: string) {
		const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: label }).click()]);
		const path = await dl.path();
		return { name: dl.suggestedFilename(), path };
	}

	test('CSV: default columns, all three orders, money to 2dp, tracking on the shipped one', async ({ page }) => {
		const dialog = await openDialog(page);
		const file = await download(page, 'Download CSV');
		expect(file.name).toBe('orders-e2e.csv');
		const [header, ...rows] = parseCsv(readFileSync(file.path, 'utf8').trim());
		expect(header).toEqual(DEFAULT_COLUMNS);
		expect(rows.map((r) => r[0]).sort()).toEqual([paidFulfilled, paidOpen, unpaid].sort());
		const col = (r: string[], k: string) => r[DEFAULT_COLUMNS.indexOf(k)];
		const f = rows.find((r) => r[0] === paidFulfilled)!;
		expect(col(f, 'email')).toBe(email('f'));
		expect(col(f, 'tracking')).toBe('1Z999AA10123456784');
		expect(col(f, 'subtotal')).toBe('62.00');   // 2 x 25.00 + 12.00
		expect(col(f, 'shipping')).toBe('5.00');
		expect(col(f, 'total')).toBe('67.00');
		expect(col(f, 'currency')).toBe('USD');
		expect(col(rows.find((r) => r[0] === unpaid)!, 'state')).toBe('PendingPayment');
		await expect(toast(page, 'Export started')).toBeVisible();
		await expect(dialog).toBeHidden();
	});

	test('CSV: payment / fulfillment / date filters are respected', async ({ page }) => {
		let dialog = await openDialog(page);
		await dialog.locator('#ex-pay').selectOption('paid');
		await dialog.locator('#ex-ful').selectOption('unfulfilled');
		let rows = parseCsv(readFileSync((await download(page, 'Download CSV')).path, 'utf8').trim()).slice(1);
		expect(rows.map((r) => r[0])).toEqual([paidOpen]);

		dialog = await openDialog(page);
		await dialog.locator('#ex-pay').selectOption('pending');
		rows = parseCsv(readFileSync((await download(page, 'Download CSV')).path, 'utf8').trim()).slice(1);
		expect(rows.map((r) => r[0])).toEqual([unpaid]);

		// a date window entirely in the future matches nothing -> header only
		dialog = await openDialog(page);
		const tomorrow = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
		await dialog.locator('#ex-from').fill(tomorrow);
		const parsed = parseCsv(readFileSync((await download(page, 'Download CSV')).path, 'utf8').trim());
		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toEqual(DEFAULT_COLUMNS);
	});

	test('CSV: one row per line item with a custom column picked', async ({ page }) => {
		const dialog = await openDialog(page);
		await dialog.getByLabel('Customer name').check();
		await dialog.getByLabel('line item').check();
		await dialog.locator('#ex-pay').selectOption('paid');
		const file = await download(page, 'Download CSV');
		expect(file.name).toBe('orders-e2e-lines.csv');
		const [header, ...rows] = parseCsv(readFileSync(file.path, 'utf8').trim());
		expect(header).toEqual([...DEFAULT_COLUMNS, 'customerName', 'sku', 'item', 'quantity', 'unitPrice', 'lineTotal']);
		const mine = rows.filter((r) => r[0] === paidFulfilled);
		expect(mine.map((r) => [r[header!.indexOf('sku')], r[header!.indexOf('quantity')], r[header!.indexOf('lineTotal')]]).sort())
			.toEqual([[SKU.mug, '1', '12.00'], [SKU.tee, '2', '50.00']].sort());
		expect(rows.some((r) => r[0] === unpaid)).toBe(false); // payment filter applied to line rows too
	});

	test('XLSX: real workbook with the same columns and rows, filters respected', async ({ page }) => {
		const dialog = await openDialog(page);
		await dialog.getByLabel('XLSX').check();
		await dialog.locator('#ex-pay').selectOption('paid');
		const file = await download(page, 'Download XLSX');
		expect(file.name).toBe('orders-e2e.xlsx');

		const wb = new ExcelJS.Workbook();
		await wb.xlsx.readFile(file.path);
		const ws = wb.getWorksheet('Orders');
		expect(ws).toBeTruthy();
		const header = (ws.getRow(1).values as unknown[]).slice(1);
		expect(header).toEqual(DEFAULT_COLUMNS);
		const codes: string[] = [];
		ws.eachRow((r: { getCell: (n: number) => { value: unknown } }, n: number) => { if (n > 1) codes.push(String(r.getCell(1).value)); });
		expect(codes.sort()).toEqual([paidFulfilled, paidOpen].sort());
		const fRow = ws.getRows(2, ws.rowCount - 1).find((r: { getCell: (n: number) => { value: unknown } }) => r.getCell(1).value === paidFulfilled);
		expect(Number(fRow.getCell(DEFAULT_COLUMNS.indexOf('total') + 1).value)).toBeCloseTo(67, 2);
	});

	test('export endpoint reports the row count, cap value and capped flag (50k truncation itself is not exercised: it needs 50k rows)', async ({ api }) => {
		const res = await api.raw('GET', `/export/orders?q=${u}`);
		expect(res.status).toBe(200);
		expect(res.headers.get('x-export-rows')).toBe('3');
		expect(res.headers.get('x-export-capped')).toBe('0');
		const cols = await api.get<{ cap: number; defaults: string[] }>('/export/orders/columns');
		expect(cols.cap).toBe(50_000);
		expect(cols.defaults).toEqual(DEFAULT_COLUMNS);
	});
});
