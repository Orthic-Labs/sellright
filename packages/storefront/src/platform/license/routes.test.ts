// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROUTES = fileURLToPath(new URL('./routes', import.meta.url));
const files = (dir: string, out: string[] = []): string[] => {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) files(p, out);
		else out.push(path.relative(ROUTES, p).split(path.sep).join('/'));
	}
	return out;
};

describe('license flow route tree', () => {
	it('serves exactly the buy-flow pages (the email links /account/magic-link and /password-reset are API contracts)', () => {
		expect(files(ROUTES).sort()).toEqual([
			'account/delete/index.tsx',
			'account/devices/index.tsx',
			'account/index.tsx',
			'account/magic-link/index.tsx',
			'checkout/confirmation/[code]/index.tsx',
			'checkout/index.tsx',
			'index.tsx',
			'layout.tsx',
			'password-reset/index.tsx',
			'pricing/index.tsx',
		]);
	});

	it('every loader reading a search param declares it (the router hides undeclared params from loaders)', () => {
		const checkout = fs.readFileSync(path.join(ROUTES, 'checkout/index.tsx'), 'utf8');
		expect(checkout).toMatch(/searchParams\.get\('sku'\)[\s\S]*?\{ search: \['sku'\] \}\)/);
		expect(checkout).toMatch(/searchParams\.get\('upgrade'\)[^\n]*\{ search: \['upgrade'\] \}\)/);
	});

	it('no route names a brand: brand facts come from src/brand/hosts.json and license.json', () => {
		for (const f of files(ROUTES)) {
			const text = fs.readFileSync(path.join(ROUTES, f), 'utf8');
			expect(text, f).not.toMatch(/heardright|viewright|mailright|coderight|scraperight|Damned|Mobile Pro|Full Pro|HR-PRO/i);
		}
	});
});
