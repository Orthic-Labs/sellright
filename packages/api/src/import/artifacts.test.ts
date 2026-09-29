import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSET_KEY_SEGMENT, stageVendureAssets } from './artifacts.js';

const roots: string[] = [];
const storeId = '11111111-1111-4111-8111-111111111111';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sellright-assets-'));
  roots.push(root);
  const source = join(root, 'source'), target = join(root, 'target');
  await mkdir(source); await mkdir(target);
  await writeFile(join(source, 'image.txt'), 'original bytes');
  return { root, source, target, assets: [{ id: 1, source: 'image.txt', preview: null }] };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe.skipIf(process.platform !== 'linux')('confined asset migration', () => {
  it('reuses identical files and never overwrites a different destination', async () => {
    const f = await fixture();
    const first = await stageVendureAssets(f.source, f.target, storeId, f.assets, true);
    expect(first.counts).toEqual({ copied: 1, skipped: 0, missing: 0 });
    const second = await stageVendureAssets(f.source, f.target, storeId, f.assets, true);
    expect(second.manifest).toEqual(first.manifest);
    // idempotent: the second apply run finds the file already staged and
    // skips the write instead of recopying it.
    expect(second.counts).toEqual({ copied: 0, skipped: 1, missing: 0 });
    const destination = join(f.target, first.manifest[0]!.targetPath);
    await writeFile(destination, 'existing different bytes');
    await expect(stageVendureAssets(f.source, f.target, storeId, f.assets, true)).rejects.toThrow('Existing asset differs');
    expect(await readFile(destination, 'utf8')).toBe('existing different bytes');
  });
  it('rejects source symlinks and traversal', async () => {
    const f = await fixture();
    await symlink(join(f.source, 'image.txt'), join(f.source, 'link.txt'));
    for (const source of ['link.txt', '../source/image.txt', '/etc/passwd']) {
      await expect(stageVendureAssets(f.source, f.target, storeId, [{ id: 2, source, preview: null }], false)).rejects.toThrow();
    }
  });
  it('rejects destination directory and file symlinks without touching their targets', async () => {
    const f = await fixture(), outside = join(f.root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(f.target, storeId));
    await expect(stageVendureAssets(f.source, f.target, storeId, f.assets, true)).rejects.toThrow();
    await rm(join(f.target, storeId));
    await mkdir(join(f.target, storeId, ASSET_KEY_SEGMENT), { recursive: true });
    const victim = join(outside, 'victim.txt');
    await writeFile(victim, 'untouched');
    await symlink(victim, join(f.target, storeId, ASSET_KEY_SEGMENT, 'image.txt'));
    await expect(stageVendureAssets(f.source, f.target, storeId, f.assets, true)).rejects.toThrow();
    expect(await readFile(victim, 'utf8')).toBe('untouched');
  });
  it('rejects a destination symlink during dry-run too, not just apply', async () => {
    const f = await fixture(), outside = join(f.root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(f.target, storeId));
    await expect(stageVendureAssets(f.source, f.target, storeId, f.assets, false)).rejects.toThrow();
  });
  it('storage keys never contain the source platform name', async () => {
    const f = await fixture();
    const { manifest: [entry] } = await stageVendureAssets(f.source, f.target, storeId, f.assets, true);
    expect(entry!.targetPath).toBe(`${storeId}/${ASSET_KEY_SEGMENT}/image.txt`);
    expect(entry!.targetPath).not.toMatch(/vendure/i);
  });
  it('falls back to the sibling preview when the source file is missing on disk, and reports it', async () => {
    const f = await fixture();
    await writeFile(join(f.source, 'preview.txt'), 'preview bytes');
    const assets = [{ id: 1, source: 'missing-source.txt', preview: 'preview.txt' }];
    const { manifest, missing, counts } = await stageVendureAssets(f.source, f.target, storeId, assets, true);
    expect(missing).toEqual([]);
    expect(counts).toEqual({ copied: 2, skipped: 0, missing: 0 });
    const sourceEntry = manifest.find(r => r.sourcePath === 'missing-source.txt');
    expect(sourceEntry).toBeDefined();
    expect(sourceEntry!.usedFallbackFrom).toBe('preview.txt');
    expect(sourceEntry!.sha256).toBe(createHash('sha256').update('preview bytes').digest('hex'));
    const staged = await readFile(join(f.target, sourceEntry!.targetPath), 'utf8');
    expect(staged).toBe('preview bytes');
    // the preview's own path is still staged too, independently
    const previewEntry = manifest.find(r => r.sourcePath === 'preview.txt');
    expect(previewEntry!.usedFallbackFrom).toBeUndefined();
  });
  it('reports a source missing with no preview fallback as a warning, not a crash', async () => {
    const f = await fixture();
    const assets = [{ id: 1, source: 'missing-source.txt', preview: null }];
    const { manifest, missing, counts } = await stageVendureAssets(f.source, f.target, storeId, assets, true);
    expect(manifest).toEqual([]);
    expect(missing).toEqual([{ path: 'missing-source.txt', targetPath: `${storeId}/${ASSET_KEY_SEGMENT}/missing-source.txt` }]);
    expect(counts).toEqual({ copied: 0, skipped: 0, missing: 1 });
  });
  it('reports a missing preview-only reference (no source) as a warning too', async () => {
    const f = await fixture();
    const assets = [{ id: 1, source: 'image.txt', preview: 'missing-preview.txt' }];
    const { missing, counts } = await stageVendureAssets(f.source, f.target, storeId, assets, true);
    expect(missing).toEqual([{ path: 'missing-preview.txt', targetPath: `${storeId}/${ASSET_KEY_SEGMENT}/missing-preview.txt` }]);
    expect(counts.missing).toBe(1);
    expect(counts.copied).toBe(1); // image.txt itself still stages fine
  });
  it('a genuinely missing fallback (source AND preview absent) still reports one warning, not a throw', async () => {
    const f = await fixture();
    const assets = [{ id: 1, source: 'missing-source.txt', preview: 'also-missing-preview.txt' }];
    const { missing, counts } = await stageVendureAssets(f.source, f.target, storeId, assets, true);
    expect(missing.map(m => m.path).sort()).toEqual(['also-missing-preview.txt', 'missing-source.txt']);
    expect(counts.missing).toBe(2);
  });
  it('dry-run reports what would be copied vs skipped without writing anything', async () => {
    const f = await fixture();
    const dryRun = await stageVendureAssets(f.source, f.target, storeId, f.assets, false);
    expect(dryRun.counts).toEqual({ copied: 1, skipped: 0, missing: 0 });
    await expect(readFile(join(f.target, dryRun.manifest[0]!.targetPath))).rejects.toThrow(); // nothing written
    const applied = await stageVendureAssets(f.source, f.target, storeId, f.assets, true);
    expect(applied.counts).toEqual({ copied: 1, skipped: 0, missing: 0 });
    const dryRunAgain = await stageVendureAssets(f.source, f.target, storeId, f.assets, false);
    expect(dryRunAgain.counts).toEqual({ copied: 0, skipped: 1, missing: 0 }); // already staged, dry-run sees it
    await expect(readFile(join(f.target, dryRunAgain.manifest[0]!.targetPath), 'utf8')).resolves.toBe('original bytes');
  });
});
