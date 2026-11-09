import { describe, expect, it } from 'vitest';
import { head } from './product';

const run = (value: unknown) => head({ resolveValue: () => value, url: new URL('https://x.test/products/zz/') }) as { title?: string; meta?: { name?: string; property?: string; content?: string }[]; links?: { rel?: string }[]; scripts?: unknown[] };

describe('product head, missing product (FC-1)', () => {
	for (const [label, value] of [['failed', { failed: true, status: 404, message: 'x' }], ['null', null]] as const) {
		it(`${label} loader result: noindex, no canonical, no og:type, no JSON-LD`, () => {
			const h = run(value);
			expect(h.title).toMatch(/Product not found/i);
			expect(h.meta?.find((m) => m.name === 'robots')?.content).toMatch(/noindex/);
			expect(h.links?.some((l) => l.rel === 'canonical') ?? false).toBe(false);
			expect(h.meta?.some((m) => m.property === 'og:type' && m.content === 'product')).toBe(false);
			expect(JSON.stringify(h)).not.toMatch(/ld\+json|application\/ld/);
		});
	}
});
