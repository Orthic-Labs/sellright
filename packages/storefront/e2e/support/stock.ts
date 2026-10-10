/**
 * Stock helpers for the parity suite. They change stock only through the real admin API (never SQL) and read the
 * catalog directory only to observe what the real publisher wrote. Nothing here caches: every read hits the endpoint
 * or the filesystem at the moment it is called (locked stock rules).
 */
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { uniq, type AdminApi } from './api';
import { CATALOG_DIR } from './env.mjs';

/** A throwaway physical product with one variant, so parity specs never disturb the seeded fixtures. */
export async function createStockProduct(api: AdminApi, prefix: string, onHand: number) {
	const tag = uniq(prefix).toLowerCase();
	const slug = `par-${tag}`;
	const sku = `E2E-PAR-${tag}`.toUpperCase();
	const { id } = await api.post<{ id: string }>('/products', { name: `Parity ${tag}`, slug, status: 'active' });
	await api.post(`/products/${id}/variants`, { sku, name: `Parity ${tag}`, price: 2500, onHand });
	return { slug, sku };
}

/** Set on-hand through the admin API (PATCH /variants/{id}/stock — the same route the admin UI uses; it calls onStockChanged). */
export async function setOnHand(api: AdminApi, sku: string, onHand: number): Promise<void> {
	const { variantId } = await api.stock(sku);
	await api.patch(`/variants/${variantId}/stock`, { onHand });
}

export interface PublishedGeneration { name: string; marker: { format: number; source: string; storeSlug: string; generation: string; generatedAt: string }; dir: string }

/** What `current` resolves to right now in the harness catalog dir, or null before the first publication. */
export function currentGeneration(dir = CATALOG_DIR): PublishedGeneration | null {
	if (!dir) throw new Error('E2E_CATALOG_DIR is not set: the real publisher is off, there is no catalog directory to observe');
	let target: string;
	try { target = readlinkSync(join(dir, 'current')); } catch { return null; }
	const gen = join(dir, target);
	return { name: target, dir: gen, marker: JSON.parse(readFileSync(join(gen, 'marker.json'), 'utf8')) };
}

export const generationNames = (dir = CATALOG_DIR): string[] => {
	if (!dir) throw new Error('E2E_CATALOG_DIR is not set');
	try { return readdirSync(join(dir, 'generations')); } catch { return []; }
};

/** Poll until `current` resolves to a generation different from `previous` (a real publication happened). */
export async function waitForNewGeneration(previous: string | null, timeoutMs = 30_000): Promise<PublishedGeneration> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const now = currentGeneration();
		if (now && now.name !== previous) return now;
		if (Date.now() > deadline) throw new Error(`no new catalog generation within ${timeoutMs}ms (was ${previous})`);
		await new Promise((r) => setTimeout(r, 100));
	}
}
