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

/** Physical asset storage keys are namespaced storeId + '/' + ASSET_KEY_SEGMENT
 * + '/' + <original relative path> — a neutral segment, not the source
 * platform's name, since these keys are also the runtime-served storage
 * path (never leak the origin system into a durable, externally-referenced
 * identifier). Shared by catalog.ts's asset.path column value so the DB row
 * and the physically staged file always agree. */
export const ASSET_KEY_SEGMENT = 'media';

async function readAt(root: string, relPath: string): Promise<Buffer> {
  return withinRoot(root, relPath, false, async source => {
    const handle = await open(source, fileFlags);
    try { return await readBounded(handle); } finally { await handle.close(); }
  });
}

export interface AssetManifestEntry {
  sourcePath: string; targetPath: string; sha256: string; bytes: number; usedFallbackFrom?: string;
}
/** A source (and, where applicable, its sibling preview) that could not be
 * read from disk at all — the asset row will exist in the target DB but
 * point at a file that was never staged. Reported so the operator reviews it
 * before go-live (run.ts turns each entry into an `asset-missing` manifest
 * exclusion); it never aborts the whole migration by itself. */
export interface AssetMissingEntry { path: string; targetPath: string }
export interface AssetStageResult {
  manifest: AssetManifestEntry[];
  missing: AssetMissingEntry[];
  counts: { copied: number; skipped: number; missing: number };
}

/** Apply mode: create-first, exactly like the pre-existing write path — the
 * O_CREAT|O_EXCL open is attempted BEFORE any read, so there is no
 * check-then-act window between "does it exist" and "create it": either this
 * open wins the race and creates the file, or it loses with EEXIST and only
 * then do we read the (now known-to-exist) file back to verify it's
 * byte-identical. Reordering that (read-first, create-on-ENOENT) would open
 * a real TOCTOU gap between the two opens, which is why this keeps the
 * original ordering rather than sharing one code path with dry-run. */
async function applyTargetStatus(targetRoot: string, targetPath: string, bytes: Buffer, sha256: string): Promise<'copied' | 'skipped'> {
  return await withinRoot(targetRoot, targetPath, true, async target => {
    let handle: FileHandle;
    try {
      handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await open(target, fileFlags);
      try {
        if (createHash('sha256').update(await readBounded(existing)).digest('hex') !== sha256) throw new Error('Existing asset differs');
      } finally { await existing.close(); }
      return 'skipped' as const;
    }
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    return 'copied' as const;
  });
}

/** Dry-run mode: read-only report, never creates anything — not even the
 * intermediate directories (`withinRoot`'s `create: false`), so a target
 * tree that doesn't exist yet at all (first-ever run for a new store) hits
 * ENOENT while opening a missing intermediate directory, treated the same as
 * the leaf file itself being missing: both mean "would copy". Nothing is
 * ever written here, so there is no race to avoid — a stale read only makes
 * the printed report stale, never corrupts a file. A rejected symlink
 * (ELOOP/EPERM from the O_NOFOLLOW opens) still propagates rather than being
 * swallowed as ENOENT — that's a traversal attempt, not an absent file. */
async function dryRunTargetStatus(targetRoot: string, targetPath: string, sha256: string): Promise<'copied' | 'skipped'> {
  try {
    return await withinRoot(targetRoot, targetPath, false, async target => {
      const existing = await open(target, fileFlags);
      try {
        if (createHash('sha256').update(await readBounded(existing)).digest('hex') !== sha256) throw new Error('Existing asset differs');
        return 'skipped' as const;
      } finally { await existing.close(); }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'copied';
    throw error;
  }
}

export async function stageVendureAssets(
  sourceRoot: string, targetRoot: string, storeId: string,
  assets: Array<{ id: unknown; source: string; preview: string | null }>, apply: boolean,
): Promise<AssetStageResult> {
  if (!/^[0-9a-f-]{36}$/i.test(storeId)) throw new Error('Invalid target store identity');
  const manifest: AssetManifestEntry[] = [];
  const missing: AssetMissingEntry[] = [];
  let copied = 0, skipped = 0;
  const paths = new Set(assets.flatMap(a => [a.source, a.preview].filter((p): p is string => !!p)));
  // A source-quality file can be pruned from disk (cleanup, CDN migration,
  // etc.) while its preview survives and is still what the storefront/admin
  // actually renders. Never drop the asset for that — fall back to the
  // sibling preview's bytes and report the substitution (manifest
  // `usedFallbackFrom`), which run.ts turns into an `asset-source-fallback`
  // exclusion entry. Only ENOENT triggers the fallback; any other read
  // failure (corrupt file, size limit, symlink rejection) still throws.
  const previewForSource = new Map<string, string>();
  for (const a of assets) if (a.source && a.preview) previewForSource.set(a.source, a.preview);
  for (const path of [...paths].sort()) {
    const targetPath = storeId + '/' + ASSET_KEY_SEGMENT + '/' + path;
    let bytes: Buffer;
    let usedFallbackFrom: string | undefined;
    try {
      bytes = await readAt(sourceRoot, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const fallbackPath = previewForSource.get(path);
      if (fallbackPath) {
        try {
          bytes = await readAt(sourceRoot, fallbackPath);
          usedFallbackFrom = fallbackPath;
        } catch (fallbackError) {
          if ((fallbackError as NodeJS.ErrnoException).code !== 'ENOENT') throw fallbackError;
          missing.push({ path, targetPath });
          continue;
        }
      } else {
        // No source file, no sibling preview to fall back to: a warning, not
        // a crash — the caller (run.ts) surfaces it as a reviewed
        // `asset-missing` exclusion instead of aborting the entire import for
        // one broken file. The asset DB row is still created elsewhere
        // (catalog.ts) and will point at a path nothing ever staged.
        missing.push({ path, targetPath });
        continue;
      }
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const status = apply ? await applyTargetStatus(targetRoot, targetPath, bytes, sha256) : await dryRunTargetStatus(targetRoot, targetPath, sha256);
    if (status === 'copied') copied++; else skipped++;
    manifest.push({ sourcePath: path, targetPath, sha256, bytes: bytes.length, ...(usedFallbackFrom ? { usedFallbackFrom } : {}) });
  }
  return { manifest, missing, counts: { copied, skipped, missing: missing.length } };
}
