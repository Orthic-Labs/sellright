import { mkdtemp, readFile, readlink, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { publishGeneration } from './publish.js';

const roots: string[] = [];
async function root() {
  const dir = await mkdtemp(join(tmpdir(), 'sr-catalog-'));
  roots.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('catalog generation publication', () => {
  it('swaps complete generations and removes deleted products from the current view', async () => {
    const outDir = await root();
    const first = await publishGeneration({ outDir, storeSlug: 'fixture', manifest: { products: ['old'] }, details: [{ slug: 'old' }] });
    const second = await publishGeneration({ outDir, storeSlug: 'fixture', manifest: { products: ['new'] }, details: [{ slug: 'new' }] });
    expect(await readlink(join(outDir, 'current'))).toBe(`generations/${second.generation}`);
    expect(JSON.parse(await readFile(join(outDir, 'current/marker.json'), 'utf8'))).toMatchObject({ format: 1, source: 'sellright', storeSlug: 'fixture', generation: second.generation });
    expect(await readdir(join(outDir, 'current/products'))).toEqual(['new.json']);
    expect(await readFile(join(outDir, 'generations', first.generation, 'products/old.json'), 'utf8')).toBe('{"slug":"old"}');
  });

  it('preserves the last complete generation when serialization fails', async () => {
    const outDir = await root();
    const first = await publishGeneration({ outDir, storeSlug: 'fixture', manifest: {}, details: [] });
    await expect(publishGeneration({ outDir, storeSlug: 'fixture', manifest: { unsupported: 1n }, details: [] })).rejects.toThrow();
    expect(await readlink(join(outDir, 'current'))).toBe(`generations/${first.generation}`);
    expect(await readdir(join(outDir, 'generations'))).toEqual([first.generation]);
  });

  it('rejects foreign stores, legacy directories, traversal and duplicate slugs', async () => {
    const outDir = await root();
    await publishGeneration({ outDir, storeSlug: 'fixture', manifest: {}, details: [] });
    await expect(publishGeneration({ outDir, storeSlug: 'another', manifest: {}, details: [] })).rejects.toThrow('foreign');
    for (const details of [[{ slug: '../escape' }], [{ slug: 'same' }, { slug: 'same' }]]) {
      await expect(publishGeneration({ outDir, storeSlug: 'fixture', manifest: {}, details })).rejects.toThrow('slug');
    }
    const legacy = await root();
    await writeFile(join(legacy, 'current'), 'not a SellRight pointer');
    await expect(publishGeneration({ outDir: legacy, storeSlug: 'fixture', manifest: {}, details: [] })).rejects.toThrow();
  });

  it('cleans only old owned generations, keeping previous and recent readers safe', async () => {
    const outDir = await root();
    const input = { outDir, storeSlug: 'fixture', manifest: {}, details: [] };
    const old = await publishGeneration(input);
    const marker = join(outDir, 'generations', old.generation, 'marker.json');
    await writeFile(marker, JSON.stringify({ source: 'sellright', storeSlug: 'fixture', generation: old.generation, generatedAt: '2000-01-01' }));
    const recent = await publishGeneration(input);
    const previous = await publishGeneration(input);
    const current = await publishGeneration(input);
    expect((await readdir(join(outDir, 'generations'))).sort()).toEqual([recent.generation, previous.generation, current.generation].sort());
  });
});
