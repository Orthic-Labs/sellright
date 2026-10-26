// @vitest-environment node
import { mkdtemp, mkdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { readCatalogGeneration, readCatalogSnapshot } from './catalog-snapshot';

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
  it.each([{ format: 1 }, { format: 2 }, { generatedAt: '2000-01-01T00:00:00.000Z' }])('accepts a supported marker %j (no age-based expiry)', async marker => {
    expect(await readCatalogSnapshot('shop-catalog.json', await fixture(marker))).toEqual({ products: [{ slug: 'native' }] });
  });
  it.each([{ source: 'legacy' }, { storeSlug: 'another' }, { format: 3 }, { format: 0 }, { format: '2' }, { format: undefined }, { generatedAt: 'invalid' }, { generatedAt: '2100-01-01' }, { generation: randomUUID() }])('rejects invalid marker %j', async marker => {
    await expect(readCatalogSnapshot('shop-catalog.json', await fixture(marker))).rejects.toThrow('Stale or foreign');
  });
  it('rejects a generation directory that is not a UUID-named generation', async () => {
    const config = await fixture();
    const bad = join(config.directory, 'generations', 'not-a-generation');
    await mkdir(bad, { recursive: true });
    await rm(join(config.directory, 'current'));
    await symlink('generations/not-a-generation', join(config.directory, 'current'));
    await expect(readCatalogSnapshot('shop-catalog.json', config)).rejects.toThrow('Invalid catalog generation');
  });
  it('rejects a current pointer that escapes the catalog root', async () => {
    const config = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'sr-reader-outside-'));
    roots.push(outside);
    await rm(join(config.directory, 'current'));
    await symlink(outside, join(config.directory, 'current'));
    await expect(readCatalogSnapshot('shop-catalog.json', config)).rejects.toThrow('Invalid catalog generation');
  });
  it('throws when there is no current generation', async () => {
    const config = await fixture();
    await rm(join(config.directory, 'current'));
    await expect(readCatalogSnapshot('shop-catalog.json', config)).rejects.toThrow();
  });
  it('throws when the marker is unparsable or missing', async () => {
    const config = await fixture();
    const generation = (await readlink(join(config.directory, 'current'))).replace('generations/', '');
    await writeFile(join(config.directory, 'generations', generation, 'marker.json'), '{not json');
    await expect(readCatalogSnapshot('shop-catalog.json', config)).rejects.toThrow();
    await rm(join(config.directory, 'generations', generation, 'marker.json'));
    await expect(readCatalogSnapshot('shop-catalog.json', config)).rejects.toThrow();
  });
  it('requires explicit configuration and prevents path traversal', async () => {
    await expect(readCatalogSnapshot('shop-catalog.json', { directory: undefined, storeSlug: 'fixture' })).rejects.toThrow('not configured');
    await expect(readCatalogSnapshot('../secret', await fixture())).rejects.toThrow('Invalid catalog file');
  });
});

describe('readCatalogGeneration (brand views PR2 §7)', () => {
  it('reads every file from the one generation pinned at the start, even when current is swapped between file reads', async () => {
    const config = await fixture();
    const second = randomUUID();
    const folder = join(config.directory, 'generations', second);
    await mkdir(join(folder, 'products'), { recursive: true });
    await writeFile(join(folder, 'marker.json'), JSON.stringify({ format: 1, source: 'sellright', storeSlug: 'fixture', generation: second, generatedAt: new Date().toISOString() }));
    await writeFile(join(folder, 'shop-catalog.json'), JSON.stringify({ products: [{ slug: 'second' }] }));
    await writeFile(join(folder, 'products/native.json'), JSON.stringify({ slug: 'second' }));
    const { readFile } = await import('node:fs/promises');
    let swapped = false;
    const io = {
      readFile: async (path: string, enc: 'utf8') => {
        const out = await readFile(path, enc);
        if (!swapped && path.endsWith('shop-catalog.json')) {
          swapped = true;
          await rm(join(config.directory, 'current'));
          await symlink(`generations/${second}`, join(config.directory, 'current'));
        }
        return out;
      },
    };
    const { files } = await readCatalogGeneration(['shop-catalog.json', 'products/native.json'], config, io);
    expect(swapped).toBe(true);
    expect(files['shop-catalog.json']).toEqual({ products: [{ slug: 'native' }] });
    expect(files['products/native.json']).toEqual({ slug: 'native' });
    expect((await readCatalogSnapshot<{ slug: string }>('products/native.json', config)).slug).toBe('second');
  });
  it('a missing file is null; an invalid name throws before any read', async () => {
    const config = await fixture();
    const { files } = await readCatalogGeneration(['products/native.json', 'products/absent.json'], config);
    expect(files['products/absent.json']).toBeNull();
    await expect(readCatalogGeneration(['products/../x.json'], config)).rejects.toThrow('Invalid catalog file');
    await expect(readCatalogSnapshot('products/absent.json', config)).rejects.toThrow();
  });
  it('#382: reads products-v2 detail files of the same generation; traversal there is still refused', async () => {
    const config = await fixture();
    const { files: before } = await readCatalogGeneration(['products-v2/native.json'], config);
    expect(before['products-v2/native.json']).toBeNull();
    const generation = (await readlink(join(config.directory, 'current'))).split('/').pop()!;
    await mkdir(join(config.directory, 'generations', generation, 'products-v2'));
    await writeFile(join(config.directory, 'generations', generation, 'products-v2/native.json'), JSON.stringify({ inStock: true }));
    const { files } = await readCatalogGeneration(['products/native.json', 'products-v2/native.json'], config);
    expect(files['products-v2/native.json']).toEqual({ inStock: true });
    await expect(readCatalogGeneration(['products-v2/../x.json'], config)).rejects.toThrow('Invalid catalog file');
    await expect(readCatalogGeneration(['products-v3/native.json'], config)).rejects.toThrow('Invalid catalog file');
  });
});
