import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
  reuse?: { generation: string; slugs: string[] };
};

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
  // O_NONBLOCK also prevents a replaced FIFO from hanging before fstat.
  // Without O_NOFOLLOW this optimization cannot safely consume local files.
  if (typeof constants.O_NOFOLLOW !== 'number') throw new Error('Catalog no-follow reads unavailable');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    const uid = process.geteuid?.();
    if (!metadata.isFile() || uid === undefined || (metadata.uid !== uid && metadata.uid !== 0) || (metadata.mode & 0o022) !== 0) throw new Error('Catalog file is not a trusted regular file');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}

async function readSnapshot(dir: string, native: boolean): Promise<Snapshot> {
  const folder = join(dir, native ? 'products-v2' : 'products');
  await trustedCatalogDirectory(folder);
  const manifest = await readRegularJson(join(dir, native ? 'shop-catalog.v2.json' : 'shop-catalog.json')) as CatalogManifestShape;
  if (!Array.isArray(manifest?.products) || manifest.totalItems !== manifest.products.length) throw new Error('Invalid catalog manifest');
  const slugs = manifest.products.map(p => p.slug);
  if (slugs.some(slug => typeof slug !== 'string' || !SAFE_SLUG.test(slug)) || new Set(slugs).size !== slugs.length) throw new Error('Invalid catalog slugs');
  const details: Detail[] = [];
  for (const slug of slugs) {
    const detail = await readRegularJson(join(folder, `${slug}.json`)) as Detail;
    if (detail?.slug !== slug) throw new Error('Catalog detail slug mismatch');
    details.push(detail);
  }
  return { manifest, details };
}

async function pinCatalogGeneration(outDir: string, storeSlug: string): Promise<{ generation: string; dir: string }> {
  const root = resolve(outDir);
  await trustedCatalogDirectory(root);
  const previous = await readlink(join(root, 'current'));
  if (!/^generations\/[0-9a-f-]{36}$/.test(previous)) throw new Error('Foreign catalog pointer');
  await trustedCatalogDirectory(join(root, 'generations'));
  const dir = join(root, previous);
  await trustedCatalogDirectory(dir);
  const generation = previous.slice('generations/'.length);
  const marker = await readRegularJson(join(dir, 'marker.json')) as { source?: string; storeSlug?: string; generation?: string };
  if (marker.source !== 'sellright' || marker.storeSlug !== storeSlug || marker.generation !== generation) throw new Error('Foreign catalog marker');
  return { generation, dir };
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
  if (input.reuse && (!GENERATION.test(input.reuse.generation) || previous !== `generations/${input.reuse.generation}` || [...reuse].some(slug => !SAFE_SLUG.test(slug)))) throw new Error('Refusing stale or invalid catalog reuse');
  if (reuse.size) {
    try {
      for (const directory of [root, generations, join(root, previous!), join(root, previous!, 'products'), join(root, previous!, 'products-v2')]) await trustedCatalogDirectory(directory);
    } catch { reuse.clear(); /* Full serialization remains safe without reuse. */ }
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
  try {
    await mkdir(target);
    claimedTarget = true;
    await mkdir(join(target, 'products'));
    await mkdir(join(target, 'products-v2'));
    await writeFile(join(target, 'shop-catalog.json'), JSON.stringify(input.manifest));
    const writeDetails = async (folder: string, details: { slug: string }[]) => {
      for (const detail of details) {
        const destination = join(target, folder, `${detail.slug}.json`);
        if (reuse.has(detail.slug)) {
          const source = join(root, previous!, folder, `${detail.slug}.json`);
          // Generation files are immutable: only fresh directories receive writes.
          // If links are unavailable, use the already-validated snapshot bytes.
          try {
            await link(source, destination);
            // Validate the actual new directory entry, never check source then
            // follow a potentially replaced path in a later operation.
            if (JSON.stringify(await readRegularJson(destination)) === JSON.stringify(detail)) continue;
          } catch { /* Cross-device/unsupported links fall back to a separate file. */ }
          await rm(destination, { force: true });
        }
        await writeFile(destination, JSON.stringify(detail));
      }
    };
    await writeDetails('products', input.details);
    await writeFile(join(target, 'shop-catalog.v2.json'), JSON.stringify(input.manifestV2 ?? null));
    await writeDetails('products-v2', detailsV2);
    // format: 2 — this generation carries both v1 (Vendure-parity) and v2
    // (native) manifests. A reader keyed on `format` can tell whether v2
    // files exist without probing the filesystem.
    await writeFile(join(target, 'marker.json'), JSON.stringify({ format: 2, source: 'sellright', storeSlug: input.storeSlug, generation, generatedAt: new Date().toISOString() }));
    await symlink(`generations/${generation}`, pointer);
    await rename(pointer, join(root, 'current'));
    published = true;
    // Only remove generations marked as ours. Keep the previous complete snapshot.
    for (const name of await readdir(generations)) {
      if (!GENERATION.test(name) || name === generation || previous === `generations/${name}`) continue;
      try {
        await trustedCatalogDirectory(generations);
        await trustedCatalogDirectory(join(generations, name));
        const marker = await readRegularJson(join(generations, name, 'marker.json')) as { source?: string; storeSlug?: string; generation?: string; generatedAt?: string };
        // Grace period protects readers that pinned an older generation mid-request.
        if (marker.source === 'sellright' && marker.storeSlug === input.storeSlug && marker.generation === name && Date.now() - Date.parse(marker.generatedAt ?? '') > 600000) await rm(join(generations, name), { recursive: true });
      } catch { /* A foreign/incomplete directory is never a cleanup target. */ }
    }
    return { generation, products: input.details.length };
  } finally {
    await rm(pointer, { force: true });
    if (!published && claimedTarget) await rm(target, { recursive: true, force: true });
  }
}
