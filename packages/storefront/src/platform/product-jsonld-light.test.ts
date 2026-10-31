// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { absoluteOn, fillJsonLdOffers, jsonLdTextWithOffers, withoutOffers } from './product-jsonld-light';

describe('product-jsonld-light (client-safe)', () => {
	it('imports nothing from the server-only builders or DOMPurify', () => {
		const src = readFileSync(fileURLToPath(new URL('./product-jsonld-light.ts', import.meta.url)), 'utf8');
		const specs = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
		expect(specs.filter((s) => !s.startsWith('~/types/'))).toEqual([]);
	});
	it('browser entry points stay on the light module', () => {
		for (const f of ['./controllers/jsonld-offers.ts', './product.ts']) {
			const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
			expect(src).not.toMatch(/from '~\/platform\/product-jsonld'/);
		}
	});
	it('fills offers into the Product script and nothing else', () => {
		const scripts = [{ textContent: '{"@type":"Product","name":"a<b"}' }, { textContent: '{"@type":"BreadcrumbList"}' }];
		const doc = { querySelectorAll: () => ({ forEach: (cb: (e: unknown) => void) => scripts.forEach(cb) }) } as never;
		expect(fillJsonLdOffers(doc, { price: '1.00' })).toBe(1);
		expect(scripts[0].textContent).toContain('"offers":{"price":"1.00"}');
		expect(scripts[0].textContent).not.toContain('<');
		expect(scripts[1].textContent).toBe('{"@type":"BreadcrumbList"}');
		expect(jsonLdTextWithOffers('nope', {})).toBeNull();
	});
	it('absoluteOn and withoutOffers', () => {
		expect(absoluteOn('https://x.test', 'a.webp')).toBe('https://x.test/assets/a.webp');
		expect(withoutOffers({ a: 1, offers: { p: 1 } })).toEqual({ a: 1 });
	});
});
