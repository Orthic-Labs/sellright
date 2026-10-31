// ADR-0001 DP-1 (license flow): the cached license home carries no price. The loader's shell catalog is redacted and the grid
// renders the reserved space; after the browser's read the grid shows the live prices. Positive control: prices render when present.
import { QwikRouterMockProvider } from '@qwik.dev/router';
import { ssrRenderToDom } from '@qwik.dev/core/testing';
import { describe, expect, it } from 'vitest';
import { redactCatalogPrices, type PricedProduct } from './catalog';
import { PricingGrid } from './PricingGrid';

const CATALOG: PricedProduct[] = [{
	slug: 'heardright', name: 'HeardRight', description: 'Dictation',
	variants: [
		{ sku: 'HR-PRO', name: 'Pro', price: 14900, salePrice: null, compareAtPrice: 19900, isPreOrder: false, enabled: true, fulfillmentType: 'license', appKey: 'heardright' },
		{ sku: 'HR-HOME', name: 'Home', price: 4567, salePrice: 4467, compareAtPrice: null, isPreOrder: false, enabled: true, fulfillmentType: 'license', appKey: 'heardright' },
	],
}];
const AMOUNTS = ['149', '199', '45.67', '44.67', '4567', '14900', '19900'];
const found = (text: string) => AMOUNTS.filter((s) => text.includes(s));

async function html(catalog: PricedProduct[], pricePending: boolean): Promise<string> {
	const { document } = await ssrRenderToDom(<QwikRouterMockProvider><PricingGrid catalog={catalog} pricePending={pricePending} /></QwikRouterMockProvider>, { debug: false });
	return document.body.innerHTML;
}

describe('license PricingGrid shell', () => {
	it('redactCatalogPrices removes every price and keeps names and SKUs', () => {
		const shell = redactCatalogPrices(CATALOG);
		expect(found(JSON.stringify(shell))).toEqual([]);
		expect(shell[0]!.variants.map((v) => v.sku)).toEqual(['HR-PRO', 'HR-HOME']);
		expect(shell[0]!.name).toBe('HeardRight');
	});

	it('the pending shell grid renders no amount and keeps the buy links', async () => {
		const out = await html(redactCatalogPrices(CATALOG), true);
		expect(found(out)).toEqual([]);
		expect(out).not.toMatch(/\$\s?\d/);
		expect(out).toContain('/checkout/?sku=HR-PRO');
		expect(out).toContain('aria-busy="true"');
	});

	it('positive control: the live grid renders the prices', async () => {
		const out = await html(CATALOG, false);
		expect(out).toMatch(/\$149/);
		expect(out).toMatch(/\$199/);
	});
});
