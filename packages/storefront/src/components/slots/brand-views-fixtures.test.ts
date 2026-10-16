// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadBrandData } from '~/platform/brand-data/vite-plugin';
import { SLOT_NAMES } from './registry';
import { discoverSlots } from './vite-plugin';

// The compiled fixture views (e2e/brand-views.spec.ts and e2e/slots.spec.ts build with them; legal.copy, pdp.payment-widget and pdp.waitlist are the slot fixtures slots.spec asserts) must stay valid: every file is a registry slot with
// the right props type, and the fixture head.json / routes.json pass the build-time validator against the real route tree.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '../../..');
const VIEWS = path.join(HERE, '__fixtures__/brand-views');
const DATA = path.join(HERE, '__fixtures__/brand-views-data');

describe('brand-view fixtures', () => {
	it('every fixture file is a valid slot for the view slots', () => {
		const names = discoverSlots(VIEWS).map((e) => e.name).sort();
		expect(names).toEqual(['cart.free-shipping-progress', 'checkout.loyalty-redemption', 'legal.copy', 'pdp.payment-widget', 'pdp.waitlist', 'route.blog', 'route.blog-post', 'route.contact', 'route.content', 'route.home', 'shell.footer', 'shell.header']);
		for (const n of names) expect((SLOT_NAMES as readonly string[]).includes(n)).toBe(true);
	});

	it('the fixture head.json and routes.json validate against the real route tree', () => {
		const data = loadBrandData(PACKAGE_ROOT, DATA, VIEWS);
		expect(data.head).toMatchObject({ titleTemplate: '%s | {store}' });
		expect((data.routes as { content: unknown[] }).content).toHaveLength(3);
	});

	it('the fixture data directory has no executable or unknown file', () => {
		expect(fs.readdirSync(DATA).sort()).toEqual(['head.json', 'routes.json']);
	});

	it('the PR2 fixture (e2e/brand-views-shop.spec.ts builds with it) holds only the shop and product views, and its routes.json validates', () => {
		const views = path.join(HERE, '__fixtures__/brand-views-pr2');
		const data = path.join(HERE, '__fixtures__/brand-views-pr2-data');
		expect(discoverSlots(views).map((e) => e.name).sort()).toEqual(['route.product', 'route.shop']);
		const loaded = loadBrandData(PACKAGE_ROOT, data, views);
		expect((loaded.routes as { shop: { detailProducts: unknown[] } }).shop.detailProducts).toHaveLength(2);
		expect(fs.readdirSync(data)).toEqual(['routes.json']);
	});
});
