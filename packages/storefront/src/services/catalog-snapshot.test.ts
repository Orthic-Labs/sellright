// @vitest-environment node
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { readCatalogSnapshot } from './catalog-snapshot';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sr-reader-'));
  roots.push(directory);
  const generation = randomUUID();
  const folder = join(directory, 'generations', generation);
  await mkdir(join(folder, 'products'), { recursive: true });
  await writeFile(join(folder, 'marker.json'), JSON.stringify({ format: 1, source: 'sellright', storeSlug: 'fixture', generation, generatedAt: new Date().toISOString(), ...overrides }));
  await writeFile(join(folder, 'shop-catalog.json'), JSON.stringify({ products: [{ slug: 'native' }] }));
  await writeFile(join(folder, 'products/native.json'), JSON.stringify({ slug: 'native' }));
  await symlink(`generations/${generation}`, join(directory, 'current'));
  return { directory, storeSlug: 'fixture' };
}
describe('SellRight catalog snapshot reader', () => {
  it('reads the complete marked generation, never legacy root files', async () => {
    const config = await fixture();
    await writeFile(join(config.directory, 'shop-catalog.json'), '{"products":["legacy"]}');
    expect(await readCatalogSnapshot('shop-catalog.json', config)).toEqual({ products: [{ slug: 'native' }] });
    expect(await readCatalogSnapshot('products/native.json', config)).toEqual({ slug: 'native' });
  });
  it.each([{ source: 'vendure' }, { storeSlug: 'another' }, { format: 2 }, { generatedAt: '2000-01-01' }, { generatedAt: 'invalid' }, { generatedAt: '2100-01-01' }, { generation: randomUUID() }])('rejects invalid marker %j', async marker => {
    await expect(readCatalogSnapshot('shop-catalog.json', await fixture(marker))).rejects.toThrow('Stale or foreign');
  });
  it('requires explicit configuration and prevents path traversal', async () => {
    await expect(readCatalogSnapshot('shop-catalog.json', { directory: undefined, storeSlug: 'fixture' })).rejects.toThrow('not configured');
    await expect(readCatalogSnapshot('../secret', await fixture())).rejects.toThrow('Invalid catalog file');
  });
});
