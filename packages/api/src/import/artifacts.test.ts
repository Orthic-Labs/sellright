import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageVendureAssets } from './artifacts.js';

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
    expect(await stageVendureAssets(f.source, f.target, storeId, f.assets, true)).toEqual(first);
    const destination = join(f.target, first[0]!.targetPath);
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
    await mkdir(join(f.target, storeId, 'vendure'), { recursive: true });
    const victim = join(outside, 'victim.txt');
    await writeFile(victim, 'untouched');
    await symlink(victim, join(f.target, storeId, 'vendure', 'image.txt'));
    await expect(stageVendureAssets(f.source, f.target, storeId, f.assets, true)).rejects.toThrow();
    expect(await readFile(victim, 'utf8')).toBe('untouched');
  });
});
