import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath, stat, lstat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';

export function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => JSON.stringify(key) + ':' + canonical(child)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

export async function writePrivateJson(path: string, value: unknown) {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
export async function readPrivateJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function stageVendureAssets(
  sourceRoot: string, targetRoot: string, storeId: string,
  assets: Array<{ id: unknown; source: string; preview: string | null }>, apply: boolean,
) {
  const root = await realpath(sourceRoot);
  const manifest: Array<{ sourcePath: string; targetPath: string; sha256: string; bytes: number }> = [];
  const paths = new Set(assets.flatMap(a => [a.source, a.preview].filter((p): p is string => !!p)));
  for (const path of [...paths].sort()) {
    if (isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.split('/').includes('..')) throw new Error('Unsafe source asset path');
    const source = await realpath(resolve(root, path));
    const rel = relative(root, source);
    if (rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Asset escapes source root');
    const info = await stat(source);
    if (!info.isFile() || info.size > 67108864) throw new Error('Invalid asset size or type');
    const bytes = await readFile(source);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const targetPath = storeId + '/vendure/' + path;
    const target = resolve(targetRoot, targetPath);
    if (apply) {
      await mkdir(targetRoot, { recursive: true });
      const destinationRoot = await realpath(targetRoot);
      let parent = destinationRoot;
      for (const component of targetPath.split('/').slice(0, -1)) {
        parent = resolve(parent, component);
        await mkdir(parent).catch(error => { if (error.code !== 'EEXIST') throw error; });
        if ((await lstat(parent)).isSymbolicLink()) throw new Error('Destination asset directory is a symlink');
      }
      const destination = await lstat(target).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (destination && (!destination.isFile() || destination.isSymbolicLink())) throw new Error('Unsafe destination asset');
      try {
        const existing = await readFile(target);
        if (createHash('sha256').update(existing).digest('hex') !== sha256) throw new Error('Existing asset differs');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await writeFile(target, bytes, { flag: 'wx' });
      }
      if (createHash('sha256').update(await readFile(target)).digest('hex') !== sha256) throw new Error('Copied asset checksum mismatch');
    }
    manifest.push({ sourcePath: path, targetPath, sha256, bytes: bytes.length });
  }
  return manifest;
}
