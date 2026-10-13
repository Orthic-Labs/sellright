// Plan v3.1 §3.5 (brand views PR2): the cart-link seed. `/checkout/cart-link/?products=SKU[:qty],...` (and a brand's configured alias,
// routes.json operational.cartSeedPath) replaces the cart with the listed SKUs and sends the shopper to checkout. Ported from Rotten's
// /checkout/facebook/. Stock is never trusted from the link: each add is classified from its own server response, and checkout entry
// revalidates live as always.
import { addResultFrom } from '~/platform/controllers/product-model';
import type { AddOutcome } from '~/contexts/CartContext';

export const SEED_SKU = /^[A-Za-z0-9._-]{1,64}$/;
export const SEED_MAX_SKUS = 10;
export const SEED_MAX_QUANTITY = 10;

/** `products` parsed: distinct SKUs in order (at most 10, extras dropped), quantity 1..10 (missing 1, above 10 clamped). Null = malformed. */
export function parseSeedProducts(raw: string): { sku: string; quantity: number }[] | null {
	const out: { sku: string; quantity: number }[] = [];
	for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
		const parts = entry.split(':');
		if (parts.length > 2) return null;
		const [sku, qty] = parts;
		if (!SEED_SKU.test(sku)) return null;
		let quantity = 1;
		if (qty !== undefined) {
			if (!/^\d{1,4}$/.test(qty)) return null;
			quantity = Number(qty);
			if (quantity < 1) return null;
			quantity = Math.min(quantity, SEED_MAX_QUANTITY);
		}
		if (out.some((e) => e.sku === sku)) continue;
		if (out.length >= SEED_MAX_SKUS) continue;
		out.push({ sku, quantity });
	}
	return out;
}

export interface SeedPorts {
	discard: () => Promise<void>;
	add: (sku: string, quantity: number) => Promise<AddOutcome>;
	resolveCountry: (override: string | undefined) => Promise<unknown>;
	totalQuantity: () => number;
}

const ISO2 = /^[A-Za-z]{2}$/;

/** Runs the seed and returns the checkout URL to go to. Every failure path lands on checkout with an error code, never a broken page. */
export async function runCartSeed(search: URLSearchParams, ports: SeedPorts): Promise<string> {
	const params = new URLSearchParams(search);
	const productsParam = params.get('products');
	const countryRaw = params.get('country') ?? params.get('countryCode');
	params.delete('products');
	params.delete('country');
	params.delete('countryCode');
	if (productsParam === null) {
		const qs = new URLSearchParams(search).toString();
		return qs ? `/checkout/?${qs}` : '/checkout/';
	}
	const entries = parseSeedProducts(productsParam);
	if (!entries || entries.length === 0) return '/checkout/?error=invalid_cart_link';
	try {
		await ports.resolveCountry(countryRaw && ISO2.test(countryRaw) ? countryRaw.toUpperCase() : undefined);
		await ports.discard();
		const skipped: string[] = [];
		for (const { sku, quantity } of entries) {
			const result = addResultFrom(await ports.add(sku, quantity), sku, quantity);
			if (result.status !== 'added') skipped.push(sku);
		}
		if (ports.totalQuantity() === 0) return '/checkout/?error=no_valid_products';
		if (skipped.length) params.set('skipped', skipped.join(','));
		const qs = params.toString();
		return qs ? `/checkout/?${qs}` : '/checkout/';
	} catch {
		return '/checkout/?error=cart_link_failed';
	}
}
