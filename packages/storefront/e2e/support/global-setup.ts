import { AdminApi, SHIPPING, SKU } from './api';
import { NMI, SEZZLE, STORE_URL, EXTERNAL_API, HOOK_URL } from './env.mjs';

/**
 * Runs once per `playwright test` after the webServers are up (the API was just rebuilt from a fresh database by
 * start-api.mjs): seed the baseline over the real admin API — catalog (incl. the OOS/in-stock pair the original specs
 * read), shipping, gateway credentials. Skipped entirely against an external API.
 */
export const CATALOG = [
	// The OOS / in-stock pair the original storefront specs read (same slugs/SKUs as the API's seed-e2e-catalog script,
	// which needs a BYPASSRLS role; here they go through the admin API like everything else).
	{ name: 'E2E In-Stock Tee', slug: 'e2e-in-stock-tee', sku: SKU.inStock, price: 2500, onHand: 25 },
	{ name: 'E2E Out-of-Stock Tee', slug: 'e2e-out-of-stock-tee', sku: SKU.oos, price: 2500, onHand: 0 },
	{ name: 'E2E Shirt', slug: 'e2e-shirt', sku: SKU.shirt, price: 2500, onHand: 500 },
	{ name: 'E2E Mug', slug: 'e2e-mug', sku: SKU.mug, price: 1200, onHand: 500 },
	{ name: 'E2E Book', slug: 'e2e-book', sku: SKU.book, price: 1800, onHand: 500 },
];

export default async function globalSetup() {
	if (EXTERNAL_API) return;
	const api = await AdminApi.login();

	const existing = new Set((await api.get<{ items: { sku: string }[] }>('/inventory?pageSize=100')).items.map((i) => i.sku));
	for (const p of CATALOG) {
		if (existing.has(p.sku)) continue;
		const { id } = await api.post<{ id: string }>('/products', { name: p.name, slug: p.slug, status: 'active' });
		await api.post(`/products/${id}/variants`, { sku: p.sku, name: p.name, price: p.price, onHand: p.onHand });
	}

	const methods = new Set((await api.get<{ items: { code: string }[] }>('/shipping-methods')).items.map((m) => m.code));
	if (!methods.has(SHIPPING.flat)) await api.post('/shipping-methods', { code: SHIPPING.flat, name: 'E2E Flat Rate', calculator: { flat: 500 }, enabled: true });
	if (!methods.has(SHIPPING.free)) await api.post('/shipping-methods', { code: SHIPPING.free, name: 'E2E Free Shipping', calculator: { flat: 0, min: 100000 }, enabled: true });

	// Gateways, the way an operator sets them up: enable the method in test mode, then store the credentials encrypted.
	// The keys are fake; the API process only ever reaches the local mock (see support/preload.mjs).
	await api.patch('/settings/payments', { nmi: { enabled: true, mode: 'test' }, sezzle: { enabled: true, mode: 'test' } });
	await api.put('/payments/settings/nmi/test', { fields: NMI });
	await api.put('/payments/settings/sezzle/sandbox', { fields: SEZZLE });
	// Sezzle's return URLs are built from the store's public storefront URL (admin Settings > Store).
	await api.patch('/settings/store', { storefrontUrl: STORE_URL });

	// The merchant's webhook receiver (order.* events). A signing secret is shown once at creation, so setup owns the
	// endpoint and hands the secret to the specs through the environment (workers start after global setup).
	for (const old of (await api.get<{ items: { id: string; url: string }[] }>('/webhooks')).items) {
		if (old.url === HOOK_URL) await api.del(`/webhooks/${old.id}`);
	}
	const hook = await api.post<{ id: string; secret: string }>('/webhooks', { url: HOOK_URL, topics: ['order.shipped'] });
	process.env.E2E_HOOK_SECRET = hook.secret;

	// Warm the storefront's server-side renders (first render of each route is slow on a cold process) so the first
	// specs do not race hydration against a cold server.
	for (const path of ['/', '/shop/', `/products/${CATALOG[2]!.slug}/`, '/checkout/']) await fetch(STORE_URL + path).catch(() => undefined);
}
