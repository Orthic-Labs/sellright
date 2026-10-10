// @vitest-environment node
/**
 * Reader/publisher contract (plan A4): the publisher writes `format: 2` markers (packages/api/src/manifest/publish.ts:
 * `JSON.stringify({ format: 2, source: 'sellright', storeSlug, generation, generatedAt })`), and readCatalogSnapshot must
 * read a generation laid out exactly that way, however old its `generatedAt` is (no age-based expiry; the publisher
 * regenerates on every stock change). Marker format, tenant, path and generation-name validation are covered in
 * catalog-snapshot.test.ts.
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { readCatalogSnapshot } from './catalog-snapshot';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

/** A generation laid out exactly as publish.ts writes it (v1 + v2 files, format-2 marker, `current` symlink). */
async function publishedGeneration(storeSlug: string, generatedAt = new Date().toISOString()) {
	const directory = await mkdtemp(join(tmpdir(), 'sr-reader-format-'));
	roots.push(directory);
	const generation = randomUUID();
	const folder = join(directory, 'generations', generation);
	await mkdir(join(folder, 'products'), { recursive: true });
	await mkdir(join(folder, 'products-v2'), { recursive: true });
	await writeFile(join(folder, 'shop-catalog.json'), JSON.stringify({ products: [{ slug: 'native' }] }));
	await writeFile(join(folder, 'shop-catalog.v2.json'), JSON.stringify({ products: [{ slug: 'native' }] }));
	await writeFile(join(folder, 'products', 'native.json'), JSON.stringify({ slug: 'native' }));
	await writeFile(join(folder, 'marker.json'), JSON.stringify({ format: 2, source: 'sellright', storeSlug, generation, generatedAt }));
	await writeFile(join(directory, 'owner.json'), JSON.stringify({ source: 'sellright', storeSlug }));
	await symlink(`generations/${generation}`, join(directory, 'current'));
	return { directory, storeSlug };
}

describe('A4 reader vs publisher marker format', () => {
	it('reads a generation exactly as the publisher writes it (format 2)', async () => {
		const config = await publishedGeneration('fixture');
		await expect(readCatalogSnapshot('shop-catalog.json', config)).resolves.toEqual({ products: [{ slug: 'native' }] });
	});
	it('still reads it when the publication is hours old (no age-based expiry)', async () => {
		const config = await publishedGeneration('fixture', new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString());
		await expect(readCatalogSnapshot('products/native.json', config)).resolves.toEqual({ slug: 'native' });
	});
});
