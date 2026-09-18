import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, writeFile, mkdir, type FileHandle } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';

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

const LIMIT = 67_108_864;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW;

/** Resolve children through pinned directory handles. A renamed parent or
 * swapped symlink cannot redirect subsequent reads/writes to another tree.
 * The migration runtime runs on Linux (including the supplied containers). */
async function withinRoot<T>(root: string, path: string, create: boolean,
  action: (pathThroughHandle: string) => Promise<T>): Promise<T> {
  if (process.platform !== 'linux') throw new Error('Asset migration requires the Linux container runtime');
  const parts = path.split('/');
  if (isAbsolute(path) || path.includes('\\') || path.includes('\0') ||
      parts.some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe asset path');
  const handles: FileHandle[] = [];
  try {
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    let directory = await open(resolve(root), directoryFlags);
    handles.push(directory);
    for (const part of parts.slice(0, -1)) {
      const child = '/proc/self/fd/' + directory.fd + '/' + part;
      if (create) await mkdir(child, { mode: 0o700 }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
      directory = await open(child, directoryFlags);
      handles.push(directory);
    }
    return await action('/proc/self/fd/' + directory.fd + '/' + parts.at(-1)!);
  } finally {
    for (const handle of handles.reverse()) await handle.close();
  }
}

/** Validate and read the same open file, with a hard bound even if it grows. */
async function readBounded(handle: FileHandle): Promise<Buffer> {
  const before = await handle.stat();
  if (!before.isFile() || before.size > LIMIT) throw new Error('Invalid asset size or type');
  const chunks: Buffer[] = [];
  let count = 0;
  while (true) {
    const chunk = Buffer.allocUnsafe(65_536);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (!bytesRead) break;
    count += bytesRead;
    if (count > LIMIT) throw new Error('Asset exceeds the size limit');
    chunks.push(chunk.subarray(0, bytesRead));
  }
  const after = await handle.stat();
  if (before.size !== count || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Asset changed during read');
  return Buffer.concat(chunks, count);
}

export async function stageVendureAssets(
  sourceRoot: string, targetRoot: string, storeId: string,
  assets: Array<{ id: unknown; source: string; preview: string | null }>, apply: boolean,
) {
  if (!/^[0-9a-f-]{36}$/i.test(storeId)) throw new Error('Invalid target store identity');
  const manifest: Array<{ sourcePath: string; targetPath: string; sha256: string; bytes: number }> = [];
  const paths = new Set(assets.flatMap(a => [a.source, a.preview].filter((p): p is string => !!p)));
  for (const path of [...paths].sort()) {
    const bytes = await withinRoot(sourceRoot, path, false, async source => {
      const handle = await open(source, fileFlags);
      try { return await readBounded(handle); } finally { await handle.close(); }
    });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const targetPath = storeId + '/vendure/' + path;
    if (apply) await withinRoot(targetRoot, targetPath, true, async target => {
      let handle: FileHandle;
      try {
        handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await open(target, fileFlags);
        try {
          if (createHash('sha256').update(await readBounded(existing)).digest('hex') !== sha256) throw new Error('Existing asset differs');
        } finally { await existing.close(); }
        return;
      }
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    });
    manifest.push({ sourcePath: path, targetPath, sha256, bytes: bytes.length });
  }
  return manifest;
}
