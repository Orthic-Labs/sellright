// @vitest-environment node
/**
 * CHARACTERIZATION — plan A4 (manifest reader contract), BLOCKED on owner decision O2. Do not "fix" this file by editing
 * the reader here: A4 owns catalog-snapshot.ts.
 *
 * The publisher writes `format: 2` markers (packages/api/src/manifest/publish.ts: `JSON.stringify({ format: 2, source:
 * 'sellright', storeSlug, generation, generatedAt })`), but readCatalogSnapshot accepts only `format === 1`, so a
 * correctly published generation is rejected as "Stale or foreign" and the base shop always falls back to the live API
 * (services/browse-catalog.ts catch branch). This test states the CORRECT behaviour — a generation exactly as the real
 * publisher writes it is readable — and is wrapped in `it.fails`: it passes today (the assertion inside fails, as the
 * defect predicts) and turns RED the moment A4 lands, which is the cue to replace `it.fails` with `it` and to flip the
 * `{ format: 2 }` row in catalog-snapshot.test.ts, which today asserts that format 2 is rejected.
 *
 * Not covered here (need O2): the age window (300000 ms cut-off / 60000 ms future skew) and the fallback policy.
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
async function publishedGeneration(storeSlug: string) {
	const directory = await mkdtemp(join(tmpdir(), 'sr-reader-format-'));
	roots.push(directory);
	const generation = randomUUID();
	const folder = join(directory, 'generations', generation);
	await mkdir(join(folder, 'products'), { recursive: true });
	await mkdir(join(folder, 'products-v2'), { recursive: true });
	await writeFile(join(folder, 'shop-catalog.json'), JSON.stringify({ products: [{ slug: 'native' }] }));
	await writeFile(join(folder, 'shop-catalog.v2.json'), JSON.stringify({ products: [{ slug: 'native' }] }));
	await writeFile(join(folder, 'products', 'native.json'), JSON.stringify({ slug: 'native' }));
	await writeFile(join(folder, 'marker.json'), JSON.stringify({ format: 2, source: 'sellright', storeSlug, generation, generatedAt: new Date().toISOString() }));
	await writeFile(join(directory, 'owner.json'), JSON.stringify({ source: 'sellright', storeSlug }));
	await symlink(`generations/${generation}`, join(directory, 'current'));
	return { directory, storeSlug };
}

describe('A4 characterization (BLOCKED: owner decision O2) — reader vs publisher marker format', () => {
	it.fails('reads a generation exactly as the publisher writes it (format 2) — fails today, so it.fails passes', async () => {
		const config = await publishedGeneration('fixture');
		await expect(readCatalogSnapshot('shop-catalog.json', config)).resolves.toEqual({ products: [{ slug: 'native' }] });
	});
});
