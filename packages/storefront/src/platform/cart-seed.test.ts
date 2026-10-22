// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseSeedProducts, runCartSeed, type SeedPorts } from './cart-seed';
import type { AddOutcome } from '~/contexts/CartContext';

const ports = (outcomes: Record<string, AddOutcome>, total = 1) => {
	const log: string[] = [];
	const p: SeedPorts = {
		discard: async () => { log.push('discard'); },
		add: async (sku, q) => { log.push(`add ${sku}:${q}`); return outcomes[sku] ?? { kind: 'error', message: 'x' }; },
		resolveCountry: async (c) => { log.push(`country ${c}`); },
		totalQuantity: () => total,
	};
	return { p, log };
};
const ok = (q = 1): AddOutcome => ({ kind: 'applied', line: { quantity: q, available: true, availableQuantity: null } });

describe('cart-link seed', () => {
	it('parses SKUs, quantities (missing 1, clamped to 10), drops duplicates and anything past ten', () => {
		expect(parseSeedProducts('A:2, B ,C:99')).toEqual([{ sku: 'A', quantity: 2 }, { sku: 'B', quantity: 1 }, { sku: 'C', quantity: 10 }]);
		expect(parseSeedProducts('A,A:3')).toEqual([{ sku: 'A', quantity: 1 }]);
		expect(parseSeedProducts(Array.from({ length: 12 }, (_, i) => `S${i}`).join(','))).toHaveLength(10);
		for (const bad of ['A:0', 'A:-1', 'A:1.5', 'A:x', 'A:1:2', '<b>', 'a b']) expect(parseSeedProducts(bad)).toBeNull();
	});

	it('replaces the cart, keeps other params, reports skipped SKUs (dropped, unavailable, errors)', async () => {
		const { p, log } = ports({ A: ok(), B: { kind: 'applied', line: { quantity: 2, available: false, availableQuantity: 1 } }, C: { kind: 'not-applied' } });
		const to = await runCartSeed(new URLSearchParams('products=A,B:2,C,D&utm_source=fb&country=gb'), p);
		expect(log).toEqual(['country GB', 'discard', 'add A:1', 'add B:2', 'add C:1', 'add D:1']);
		expect(to).toBe('/checkout/?utm_source=fb&skipped=B%2CC%2CD');
	});

	it('errors: malformed link, nothing added, a thrown failure; no products param passes everything through', async () => {
		expect(await runCartSeed(new URLSearchParams('products=A:0'), ports({}).p)).toBe('/checkout/?error=invalid_cart_link');
		expect(await runCartSeed(new URLSearchParams('products=A'), ports({ A: { kind: 'error', message: null } }, 0).p)).toBe('/checkout/?error=no_valid_products');
		const throwing = { ...ports({}).p, discard: async () => { throw new Error('locks'); } };
		expect(await runCartSeed(new URLSearchParams('products=A'), throwing)).toBe('/checkout/?error=cart_link_failed');
		expect(await runCartSeed(new URLSearchParams('utm=1'), ports({}).p)).toBe('/checkout/?utm=1');
		const { p, log } = ports({ A: ok() });
		await runCartSeed(new URLSearchParams('products=A&country=united'), p);
		expect(log[0]).toBe('country undefined'); // only an ISO-2 code is an override
	});

	it('every error redirect keeps the landing UTM + oppref parameters (and nothing else)', async () => {
		const q = '&utm_source=chatgpt&utm_medium=cpc&utm_campaign=rh_us_shirts_202610&utm_content=test&oppref=abc&other=1';
		const keep = 'utm_source=chatgpt&utm_medium=cpc&utm_campaign=rh_us_shirts_202610&utm_content=test&oppref=abc';
		expect(await runCartSeed(new URLSearchParams(`products=A:0${q}`), ports({}).p)).toBe(`/checkout/?error=invalid_cart_link&${keep}`);
		expect(await runCartSeed(new URLSearchParams(`products=A${q}`), ports({ A: { kind: 'error', message: null } }, 0).p)).toBe(`/checkout/?error=no_valid_products&${keep}`);
		const throwing = { ...ports({}).p, discard: async () => { throw new Error('locks'); } };
		expect(await runCartSeed(new URLSearchParams(`products=A${q}`), throwing)).toBe(`/checkout/?error=cart_link_failed&${keep}`);
	});
});
