import { constants, type BigIntStats } from 'node:fs';
import { link, lstat, mkdir, open, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

const GENERATION = /^[0-9a-f-]{36}$/;
const SAFE_SLUG = /^[a-z0-9][a-z0-9_-]*$/;
type Input = {
  outDir: string; storeSlug: string; manifest: unknown; details: { slug: string }[];
  // SR-CLIENT-1: the native (v2) manifest, published alongside v1 in the SAME
  // generation so a reader of either format sees a snapshot from the same
  // instant — never a v1/v2 pair computed at different times. Optional so
  // existing callers/tests that only know about v1 keep compiling; catalog.ts
  // (the only real caller) always supplies it.
  manifestV2?: unknown; detailsV2?: { slug: string }[];
  /** Only immutable, validated files from this pinned current generation. */
  reuse?: CatalogReuse;
};

type FileIdentity = Record<'dev' | 'ino' | 'mode' | 'uid' | 'gid' | 'size' | 'mtimeNs' | 'ctimeNs' | 'nlink', string>;
type ReuseFile = { digest: string; identity: FileIdentity };
type ReuseInventory = { version: 1; v1: Record<string, ReuseFile>; v2: Record<string, ReuseFile> };
export type CatalogReuse = { generation: string; slugs: string[]; inventory?: ReuseInventory };

/** Signals that a staged scoped publish was discarded; rebuild from DB once. */
export class CatalogReuseError extends Error {}

const identityKeys = ['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs', 'nlink'] as const;
const contentKeys = identityKeys.filter(key => key !== 'ctimeNs' && key !== 'nlink');
const identity = (metadata: BigIntStats): FileIdentity => Object.fromEntries(identityKeys.map(key => [key, String(metadata[key])])) as FileIdentity;
const matchesIdentity = (a: FileIdentity, b: FileIdentity, afterLink = false) => (afterLink ? contentKeys : identityKeys).every(key => a[key] === b[key]);
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

// V66: atomic rename gives readers all-or-nothing visibility; crash durability also needs the bytes and the directory
// entries on disk before `current` points at them. Freshly written files are fsynced in bounded parallel batches
// after staging (hardlinked reuse files were synced when their own generation was published), then the generation's
// directories, then — after the pointer rename — the catalog root, so a power loss can never leave `current`
// naming a generation whose files are empty or missing.
const FSYNC_BATCH = 16;
async function syncPath(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function syncAll(paths: readonly string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += FSYNC_BATCH) await Promise.all(paths.slice(i, i + FSYNC_BATCH).map(syncPath));
}

async function openTrustedFile(path: string) {
  if (typeof constants.O_NOFOLLOW !== 'number') throw new Error('Catalog no-follow reads unavailable');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat({ bigint: true });
    const uid = process.geteuid?.();
    if (!metadata.isFile() || uid === undefined || (metadata.uid !== BigInt(uid) && metadata.uid !== 0n) || (metadata.mode & 0o022n) !== 0n) throw new Error('Catalog file is not a trusted regular file');
    return { file, identity: identity(metadata) };
  } catch (error) { await file.close(); throw error; }
}

export interface CatalogManifestShape {
  lastUpdated: string;
  totalItems: number;
  defaultSort: string;
  products: Array<{ slug: string; [k: string]: unknown }>;
}

type Detail = { slug: string; [k: string]: unknown };
type Snapshot = { manifest: CatalogManifestShape; details: Detail[] };

// Catalog generations are immutable application-owned files. Admit optimized
// reads/reuse only inside non-symlink directories that unrelated local users
// cannot replace. Same-UID/root writers already control API files & credentials.
async function trustedCatalogDirectory(path: string): Promise<void> {
  const directory = await lstat(path);
  const uid = process.geteuid?.();
  if (!directory.isDirectory() || uid === undefined || (directory.uid !== uid && directory.uid !== 0) || (directory.mode & 0o022) !== 0) throw new Error('Untrusted catalog directory');
}

async function readRegularJson(path: string): Promise<unknown> {
  const { file } = await openTrustedFile(path);
  try { return JSON.parse(await file.readFile('utf8')); }
  finally { await file.close(); }
}

async function readManifest(dir: string, native: boolean): Promise<CatalogManifestShape> {
  const manifest = await readRegularJson(join(dir, native ? 'shop-catalog.v2.json' : 'shop-catalog.json')) as CatalogManifestShape;
  if (!Array.isArray(manifest?.products) || manifest.totalItems !== manifest.products.length) throw new Error('Invalid catalog manifest');
  const slugs = manifest.products.map(p => p.slug);
  if (slugs.some(slug => typeof slug !== 'string' || !SAFE_SLUG.test(slug)) || new Set(slugs).size !== slugs.length) throw new Error('Invalid catalog slugs');
  return manifest;
}

async function readSnapshot(dir: string, native: boolean): Promise<Snapshot> {
  const folder = join(dir, native ? 'products-v2' : 'products');
  await trustedCatalogDirectory(folder);
  const manifest = await readManifest(dir, native);
  const slugs = manifest.products.map(p => p.slug);
  const details: Detail[] = [];
  for (const slug of slugs) {
    const detail = await readRegularJson(join(folder, `${slug}.json`)) as Detail;
    if (detail?.slug !== slug) throw new Error('Catalog detail slug mismatch');
    details.push(detail);
  }
  return { manifest, details };
}

async function pinCatalogGeneration(outDir: string, storeSlug: string): Promise<{ generation: string; dir: string; marker: { inventory?: ReuseInventory } }> {
  const root = resolve(outDir);
  await trustedCatalogDirectory(root);
  const previous = await readlink(join(root, 'current'));
  if (!/^generations\/[0-9a-f-]{36}$/.test(previous)) throw new Error('Foreign catalog pointer');
  await trustedCatalogDirectory(join(root, 'generations'));
  const dir = join(root, previous);
  await trustedCatalogDirectory(dir);
  const generation = previous.slice('generations/'.length);
  const marker = await readRegularJson(join(dir, 'marker.json')) as { source?: string; storeSlug?: string; generation?: string; inventory?: ReuseInventory };
  if (marker.source !== 'sellright' || marker.storeSlug !== storeSlug || marker.generation !== generation) throw new Error('Foreign catalog marker');
  return { generation, dir, marker };
}

/** Pin both formats once before opening a DB transaction. Any missing/corrupt
 *  file or symlinked generation/detail forces a complete database rebuild. */
export async function readCurrentCatalogSnapshot(outDir: string, storeSlug: string): Promise<{ generation: string; v1: Snapshot; v2: Snapshot } | null> {
  try {
    const { generation, dir } = await pinCatalogGeneration(outDir, storeSlug);
    const v1 = await readSnapshot(dir, false);
    const v2 = await readSnapshot(dir, true);
    const nativeSlugs = new Set(v2.manifest.products.map(p => p.slug));
    if (v1.manifest.products.length !== nativeSlugs.size || v1.manifest.products.some(p => !nativeSlugs.has(p.slug))) return null;
    return { generation, v1, v2 };
  } catch {
    return null;
  }
}

/** Scoped writers read manifests & inventory only. Detail bytes stay on disk. */
export async function readCurrentCatalogReuseSnapshot(outDir: string, storeSlug: string) {
  try {
    const { generation, dir, marker } = await pinCatalogGeneration(outDir, storeSlug);
    for (const folder of ['products', 'products-v2']) await trustedCatalogDirectory(join(dir, folder));
    const v1 = await readManifest(dir, false);
    const v2 = await readManifest(dir, true);
    const inventory = marker.inventory;
    if (inventory?.version !== 1) return null;
    const slugs = new Set(v1.products.map(p => p.slug));
    if (slugs.size !== v2.products.length || v2.products.some(p => !slugs.has(p.slug) || typeof p.id !== 'string')) return null;
    for (const [manifest, files] of [[v1, inventory.v1], [v2, inventory.v2]] as const) {
      if (!files || Object.keys(files).length !== slugs.size) return null;
      for (let i = 0; i < manifest.products.length; i++) {
        const product = manifest.products[i]!;
        const entry = files[product.slug];
        if (!entry || !/^[0-9a-f]{64}$/.test(entry.digest) || !entry.identity || identityKeys.some(key => typeof entry.identity[key] !== 'string' || !/^\d+$/.test(entry.identity[key]))) return null;
        if (typeof product.name !== 'string' || (i > 0 && (manifest.products[i - 1]!.name as string).localeCompare(product.name) > 0)) return null;
      }
    }
    return { generation, v1: { manifest: v1 }, v2: { manifest: v2 }, inventory };
  } catch { return null; }
}

export async function readCurrentGeneration(outDir: string, storeSlug: string): Promise<Snapshot | null> {
  try { return await readSnapshot((await pinCatalogGeneration(outDir, storeSlug)).dir, false); }
  catch { return null; }
}

export async function readCurrentGenerationV2(outDir: string, storeSlug: string): Promise<Snapshot | null> {
  try { return await readSnapshot((await pinCatalogGeneration(outDir, storeSlug)).dir, true); }
  catch { return null; }
}

// Call under the catalog leader lock. Readers resolve current once per request.
export async function publishGeneration(input: Input) {
  if (!input.outDir.trim() || !SAFE_SLUG.test(input.storeSlug)) throw new Error('Invalid catalog destination or store');
  if (input.details.some(d => !SAFE_SLUG.test(d.slug)) || new Set(input.details.map(d => d.slug)).size !== input.details.length) throw new Error('Invalid or duplicate product slug');
  const detailsV2 = input.detailsV2 ?? [];
  if (detailsV2.some(d => !SAFE_SLUG.test(d.slug)) || new Set(detailsV2.map(d => d.slug)).size !== detailsV2.length) throw new Error('Invalid or duplicate product slug (v2)');
  const root = resolve(input.outDir);
  const generations = join(root, 'generations');
  await mkdir(generations, { recursive: true });
  let previous: string | undefined;
  try {
    previous = await readlink(join(root, 'current'));
    if (!/^generations\/[0-9a-f-]{36}$/.test(previous)) throw new Error('Refusing foreign catalog pointer');
    const marker = await readRegularJson(join(root, previous, 'marker.json')) as { source?: string; storeSlug?: string };
    if (marker.source !== 'sellright' || marker.storeSlug !== input.storeSlug) throw new Error('Refusing foreign catalog destination');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (previous) throw new Error('Current catalog marker is missing');
  }
  const reuse = new Set(input.reuse?.slugs ?? []);
  if (input.reuse && (!GENERATION.test(input.reuse.generation) || previous !== `generations/${input.reuse.generation}` || [...reuse].some(slug => !SAFE_SLUG.test(slug)))) throw input.reuse?.inventory ? new CatalogReuseError('Refusing stale or invalid catalog reuse') : new Error('Refusing stale or invalid catalog reuse');
  if (reuse.size) {
    try {
      for (const directory of [root, generations, join(root, previous!), join(root, previous!, 'products'), join(root, previous!, 'products-v2')]) await trustedCatalogDirectory(directory);
    } catch {
      if (input.reuse?.inventory) throw new CatalogReuseError('Untrusted catalog reuse directory');
      reuse.clear(); /* Legacy callers supply every detail for serialization. */
    }
  }
  // Claim a new directory exclusively, including simultaneous first publication.
  const ownerPath = join(root, 'owner.json');
  try {
    await writeFile(ownerPath, JSON.stringify({ source: 'sellright', storeSlug: input.storeSlug }), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = await readRegularJson(ownerPath) as { source?: string; storeSlug?: string };
    if (owner.source !== 'sellright' || owner.storeSlug !== input.storeSlug) throw new Error('Refusing foreign catalog destination');
  }
  const generation = randomUUID();
  const target = join(generations, generation);
  const pointer = join(root, `.current-${generation}`);
  let published = false;
  let claimedTarget = false;
  const written: string[] = [];
  const stage = async (path: string, bytes: string | Buffer, flag?: 'wx') => { await writeFile(path, bytes, flag ? { flag } : undefined); written.push(path); };
  try {
    await mkdir(target);
    claimedTarget = true;
    await mkdir(join(target, 'products'));
    await mkdir(join(target, 'products-v2'));
    await stage(join(target, 'shop-catalog.json'), JSON.stringify(input.manifest));
    const inventory: ReuseInventory = { version: 1, v1: Object.create(null), v2: Object.create(null) };
    const writeDetails = async (folder: string, details: { slug: string }[], files: Record<string, ReuseFile>, pinned?: Record<string, ReuseFile>) => {
      const freshSlugs = new Set(details.map(detail => detail.slug));
      if (pinned && [...reuse].some(slug => freshSlugs.has(slug))) throw new CatalogReuseError('Fresh detail overlaps catalog reuse');
      for (const detail of details) {
        const destination = join(target, folder, `${detail.slug}.json`);
        // Legacy full-payload callers can still reuse files after comparing
        // their supplied detail. Scoped catalog writes never enter this path.
        if (!pinned && reuse.has(detail.slug)) {
          const source = join(root, previous!, folder, `${detail.slug}.json`);
          try {
            await link(source, destination);
            const opened = await openTrustedFile(destination);
            try {
              const bytes = await opened.file.readFile('utf8');
              if (JSON.stringify(JSON.parse(bytes)) === JSON.stringify(detail)) {
                files[detail.slug] = { digest: digest(bytes), identity: opened.identity };
                continue;
              }
            } finally { await opened.file.close(); }
          } catch { /* Full payload remains available to serialize. */ }
          await rm(destination, { force: true });
        }
        const bytes = JSON.stringify(detail);
        await stage(destination, bytes);
        const opened = await openTrustedFile(destination);
        try { files[detail.slug] = { digest: digest(bytes), identity: opened.identity }; }
        finally { await opened.file.close(); }
      }
      if (!pinned) return;
      for (const slug of reuse) {
        const source = join(root, previous!, folder, `${slug}.json`);
        const destination = join(target, folder, `${slug}.json`);
        try {
          const expected = pinned[slug];
          if (!expected) throw new Error('Missing catalog reuse entry');
          const opened = await openTrustedFile(source);
          try {
            if (!matchesIdentity(opened.identity, expected.identity)) throw new Error('Changed catalog reuse file');
            try { await link(source, destination); }
            catch (error) {
              // Only unsupported hardlinks admit a byte-copy fallback. Keep
              // source descriptor pinned throughout validation & copy.
              if (!['EXDEV', 'EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS', 'EMLINK'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
              const bytes = await opened.file.readFile();
              if (digest(bytes) !== expected.digest || !matchesIdentity(identity(await opened.file.stat({ bigint: true })), opened.identity)) throw new Error('Changed catalog reuse bytes');
              await stage(destination, bytes, 'wx');
              const copied = await openTrustedFile(destination);
              try { files[slug] = { digest: expected.digest, identity: copied.identity }; }
              finally { await copied.file.close(); }
              continue;
            }
            const linked = await openTrustedFile(destination);
            try {
              const sourceAfterLink = identity(await opened.file.stat({ bigint: true }));
              if (!matchesIdentity(sourceAfterLink, opened.identity, true) || !matchesIdentity(linked.identity, sourceAfterLink)) throw new Error('Catalog link identity mismatch');
              files[slug] = { digest: expected.digest, identity: linked.identity };
            } finally { await linked.file.close(); }
          } finally { await opened.file.close(); }
        } catch { throw new CatalogReuseError('Catalog reuse changed during publication'); }
      }
    };
    await writeDetails('products', input.details, inventory.v1, input.reuse?.inventory?.v1);
    await stage(join(target, 'shop-catalog.v2.json'), JSON.stringify(input.manifestV2 ?? null));
    await writeDetails('products-v2', detailsV2, inventory.v2, input.reuse?.inventory?.v2);
    // Cleanup changes shared inodes' ctime/nlink. Finish owned unlinks before
    // capturing metadata in the new marker; retain previous & recent readers.
    for (const name of await readdir(generations)) {
      if (!GENERATION.test(name) || name === generation || previous === `generations/${name}`) continue;
      try {
        await trustedCatalogDirectory(generations);
        await trustedCatalogDirectory(join(generations, name));
        const marker = await readRegularJson(join(generations, name, 'marker.json')) as { source?: string; storeSlug?: string; generation?: string; generatedAt?: string };
        if (marker.source === 'sellright' && marker.storeSlug === input.storeSlug && marker.generation === name && Date.now() - Date.parse(marker.generatedAt ?? '') > 600000) await rm(join(generations, name), { recursive: true });
      } catch { /* A foreign/incomplete directory is never a cleanup target. */ }
    }
    for (const [folder, files] of [['products', inventory.v1], ['products-v2', inventory.v2]] as const) {
      for (const [slug, entry] of Object.entries(files)) {
        const opened = await openTrustedFile(join(target, folder, `${slug}.json`));
        try {
          if (!matchesIdentity(entry.identity, opened.identity, true)) throw new CatalogReuseError('Staged catalog file changed');
          entry.identity = opened.identity;
        } finally { await opened.file.close(); }
      }
    }
    // format 2 carries both public formats; inventory is writer-private,
    // versioned metadata for immutable detail reuse.
    await stage(join(target, 'marker.json'), JSON.stringify({ format: 2, source: 'sellright', storeSlug: input.storeSlug, generation, generatedAt: new Date().toISOString(), inventory }));
    await syncAll(written);
    await syncAll([join(target, 'products'), join(target, 'products-v2'), target, generations]);
    await symlink(`generations/${generation}`, pointer);
    await rename(pointer, join(root, 'current'));
    published = true;
    await syncPath(root);
    return { generation, products: input.details.length + (input.reuse?.inventory ? reuse.size : 0) };
  } finally {
    await rm(pointer, { force: true });
    if (!published && claimedTarget) await rm(target, { recursive: true, force: true });
  }
}
