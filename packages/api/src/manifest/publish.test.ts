import { chmod, link, mkdir, mkdtemp, open, readFile, readlink, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishGeneration, readCurrentCatalogSnapshot } from './publish.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), link: vi.fn(actual.link) };
});
const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

const roots: string[] = [];
async function root() {
  const dir = await mkdtemp(join(tmpdir(), 'sr-catalog-'));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  vi.mocked(open).mockImplementation(realFs.open);
  vi.mocked(link).mockImplementation(realFs.link);
  await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('catalog generation publication', () => {
  it('prevents two stores claiming the same new destination concurrently', async () => {
    const outDir = await root();
    const results = await Promise.allSettled(['store-a', 'store-b'].map(storeSlug => publishGeneration({ outDir, storeSlug, manifest: { storeSlug }, details: [] })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const owner = JSON.parse(await readFile(join(outDir, 'owner.json'), 'utf8'));
    const marker = JSON.parse(await readFile(join(outDir, 'current/marker.json'), 'utf8'));
    expect(marker.storeSlug).toBe(owner.storeSlug);
  });
  it('swaps complete generations and removes deleted products from the current view', async () => {
    const outDir = await root();
    const first = await publishGeneration({ outDir, storeSlug: 'fixture', manifest: { products: ['old'] }, details: [{ slug: 'old' }] });
    const second = await publishGeneration({ outDir, storeSlug: 'fixture', manifest: { products: ['new'] }, details: [{ slug: 'new' }] });
    expect(await readlink(join(outDir, 'current'))).toBe(`generations/${second.generation}`);
    // format bumped to 2 (SR-CLIENT-1): this generation also carries the
    // native v2 manifest alongside v1 — see publishGeneration's marker.json comment.
    expect(JSON.parse(await readFile(join(outDir, 'current/marker.json'), 'utf8'))).toMatchObject({ format: 2, source: 'sellright', storeSlug: 'fixture', generation: second.generation });
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

  it('pins both formats, reuses immutable details, & rejects corrupted or symlinked snapshots', async () => {
    const outDir = await root();
    const detail = { slug: 'kept', name: 'Kept' };
    const manifest = { lastUpdated: '2026-01-01', totalItems: 1, defaultSort: 'name', products: [detail] };
    const input = { outDir, storeSlug: 'fixture', manifest, details: [detail], manifestV2: manifest, detailsV2: [detail] };
    const first = await publishGeneration(input);
    const snapshot = await readCurrentCatalogSnapshot(outDir, 'fixture');
    expect(snapshot?.generation).toBe(first.generation);
    expect(snapshot?.v2.details).toEqual([detail]);
    await publishGeneration({ ...input, reuse: { generation: first.generation, slugs: ['kept'] } });
    const kept = await stat(join(outDir, 'current/products-v2/kept.json'));
    if (kept.nlink > 1) expect(kept.ino).toBe((await stat(join(outDir, 'generations', first.generation, 'products-v2/kept.json'))).ino);
    await expect(publishGeneration({ ...input, reuse: { generation: first.generation, slugs: ['kept'] } })).rejects.toThrow('stale');
    const current = await readlink(join(outDir, 'current'));
    const nativeDetail = join(outDir, current, 'products-v2/kept.json');
    await rm(nativeDetail);
    await symlink(join(outDir, 'generations', first.generation, 'products-v2/kept.json'), nativeDetail);
    expect(await readCurrentCatalogSnapshot(outDir, 'fixture')).toBeNull();
    await rm(nativeDetail);
    await writeFile(nativeDetail, '{bad json');
    expect(await readCurrentCatalogSnapshot(outDir, 'fixture')).toBeNull();
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

  async function snapshotFixture() {
    const outDir = await root();
    const detail = { slug: 'kept', name: 'Original' };
    const manifest = { lastUpdated: '2026-01-01', totalItems: 1, defaultSort: 'name', products: [detail] };
    const input = { outDir, storeSlug: 'fixture', manifest, details: [detail], manifestV2: manifest, detailsV2: [detail] };
    const first = await publishGeneration(input);
    return { outDir, detail, input, first, path: join(outDir, 'generations', first.generation, 'products/kept.json') };
  }

  it('reads opened descriptor if pathname is replaced after open', async () => {
    const fixture = await snapshotFixture();
    const foreign = join(await root(), 'foreign.json');
    await writeFile(foreign, JSON.stringify({ slug: 'kept', name: 'Foreign' }));
    let closeCount = () => 0;
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      const file = await realFs.open(path, flags, mode);
      if (path === fixture.path) {
        const close = vi.spyOn(file, 'close');
        closeCount = () => close.mock.calls.length;
        await rename(fixture.path, `${fixture.path}.saved`);
        await symlink(foreign, fixture.path);
      }
      return file;
    });
    const snapshot = await readCurrentCatalogSnapshot(fixture.outDir, 'fixture');
    expect(snapshot?.v1.details).toEqual([fixture.detail]);
    expect(closeCount()).toBe(1);
  });

  it.each(['symlink', 'directory'] as const)('rejects %s replacement immediately before open', async kind => {
    const fixture = await snapshotFixture();
    let closeCount = () => 0;
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      if (path === fixture.path) {
        await rm(fixture.path);
        if (kind === 'symlink') await symlink(join(fixture.outDir, 'owner.json'), fixture.path);
        else await mkdir(fixture.path);
      }
      const file = await realFs.open(path, flags, mode);
      if (path === fixture.path) {
        const close = vi.spyOn(file, 'close');
        closeCount = () => close.mock.calls.length;
      }
      return file;
    });
    expect(await readCurrentCatalogSnapshot(fixture.outDir, 'fixture')).toBeNull();
    if (kind === 'directory') expect(closeCount()).toBe(1);
  });

  it.each(['read', 'parse', 'stat'] as const)('closes descriptor on %s error before full-rebuild fallback', async failure => {
    const fixture = await snapshotFixture();
    let closeCount = () => 0;
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      const file = await realFs.open(path, flags, mode);
      if (path === fixture.path) {
        const close = vi.spyOn(file, 'close');
        closeCount = () => close.mock.calls.length;
        if (failure === 'read') vi.spyOn(file, 'readFile').mockRejectedValueOnce(new Error('injected read failure'));
        else if (failure === 'stat') vi.spyOn(file, 'stat').mockRejectedValueOnce(new Error('injected stat failure'));
        else await writeFile(fixture.path, '{invalid');
      }
      return file;
    });
    expect(await readCurrentCatalogSnapshot(fixture.outDir, 'fixture')).toBeNull();
    expect(closeCount()).toBe(1);
  });

  it.each(['root', 'generations', 'generation', 'details', 'file'] as const)('declines unsafe %s permissions & serializes instead of reusing', async unsafe => {
    const fixture = await snapshotFixture();
    const directory = unsafe === 'root' ? fixture.outDir : unsafe === 'generations' ? join(fixture.outDir, 'generations') : unsafe === 'generation' ? join(fixture.outDir, 'generations', fixture.first.generation) : unsafe === 'details' ? join(fixture.outDir, 'generations', fixture.first.generation, 'products') : fixture.path;
    await chmod(directory, unsafe === 'file' ? 0o666 : 0o777);
    expect(await readCurrentCatalogSnapshot(fixture.outDir, 'fixture')).toBeNull();
    await publishGeneration({ ...fixture.input, reuse: { generation: fixture.first.generation, slugs: ['kept'] } });
    expect((await stat(join(fixture.outDir, 'current/products/kept.json'))).ino).not.toBe((await stat(fixture.path)).ino);
    expect(JSON.parse(await readFile(join(fixture.outDir, 'current/products/kept.json'), 'utf8'))).toEqual(fixture.detail);
  });

  it('declines symlinked detail parents', async () => {
    const fixture = await snapshotFixture();
    const directory = join(fixture.outDir, 'generations', fixture.first.generation, 'products');
    await rename(directory, `${directory}.saved`);
    await symlink(`${directory}.saved`, directory);
    expect(await readCurrentCatalogSnapshot(fixture.outDir, 'fixture')).toBeNull();
  });

  it.each(['symlink', 'regular'] as const)('validates linked destination after %s source replacement & serializes expected bytes', async kind => {
    const fixture = await snapshotFixture();
    const foreign = join(await root(), 'foreign.json');
    await writeFile(foreign, JSON.stringify({ slug: 'kept', name: 'Foreign' }));
    vi.mocked(link).mockImplementation(async (source, destination) => {
      if (source === fixture.path) {
        await rm(fixture.path);
        if (kind === 'symlink') await symlink(foreign, fixture.path);
        else await writeFile(fixture.path, await readFile(foreign));
      }
      return realFs.link(source, destination);
    });
    await publishGeneration({ ...fixture.input, reuse: { generation: fixture.first.generation, slugs: ['kept'] } });
    const destination = join(fixture.outDir, 'current/products/kept.json');
    expect((await realFs.lstat(destination)).isFile()).toBe(true);
    expect(JSON.parse(await readFile(destination, 'utf8'))).toEqual(fixture.detail);
  });

  it.each(['EXDEV', 'EPERM'] as const)('serializes validated snapshot when hardlinks fail with %s', async code => {
    const fixture = await snapshotFixture();
    vi.mocked(link).mockRejectedValue(Object.assign(new Error('injected link failure'), { code }));
    await publishGeneration({ ...fixture.input, reuse: { generation: fixture.first.generation, slugs: ['kept'] } });
    expect(JSON.parse(await readFile(join(fixture.outDir, 'current/products/kept.json'), 'utf8'))).toEqual(fixture.detail);
    expect((await stat(join(fixture.outDir, 'current/products/kept.json'))).ino).not.toBe((await stat(fixture.path)).ino);
  });

});
