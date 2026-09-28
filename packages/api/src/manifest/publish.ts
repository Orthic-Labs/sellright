import { mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

const GENERATION = /^[0-9a-f-]{36}$/;
const SAFE_SLUG = /^[a-z0-9][a-z0-9_-]*$/;
type Input = { outDir: string; storeSlug: string; manifest: unknown; details: { slug: string }[] };

export interface CatalogManifestShape {
  lastUpdated: string;
  totalItems: number;
  defaultSort: string;
  products: Array<{ slug: string; [k: string]: unknown }>;
}

/**
 * Read the CURRENT published generation's manifest + every per-product detail
 * file, verifying the same marker (`source`/`storeSlug`) publishGeneration
 * itself checks before ever trusting `current`. Used by catalog.ts's
 * per-product regeneration path to reuse unaffected products' entries
 * instead of re-querying and re-serializing the whole catalog on every
 * stock change. Returns null when there's no current generation yet, or it
 * fails the same foreign-pointer/marker checks publishGeneration enforces
 * (first publish, corrupted state, wrong store) — the caller's only
 * correct fallback in that case is a full regeneration.
 */
export async function readCurrentGeneration(outDir: string, storeSlug: string): Promise<{ manifest: CatalogManifestShape; details: Array<{ slug: string; [k: string]: unknown }> } | null> {
  const root = resolve(outDir);
  try {
    const previous = await readlink(join(root, 'current'));
    if (!/^generations\/[0-9a-f-]{36}$/.test(previous)) return null;
    const dir = join(root, previous);
    const marker = JSON.parse(await readFile(join(dir, 'marker.json'), 'utf8')) as { source?: string; storeSlug?: string };
    if (marker.source !== 'sellright' || marker.storeSlug !== storeSlug) return null;
    const manifest = JSON.parse(await readFile(join(dir, 'shop-catalog.json'), 'utf8')) as CatalogManifestShape;
    const details: Array<{ slug: string; [k: string]: unknown }> = [];
    for (const p of manifest.products) {
      if (!SAFE_SLUG.test(p.slug)) continue; // never trust an unsafe slug even from our own prior output
      try {
        details.push(JSON.parse(await readFile(join(dir, 'products', `${p.slug}.json`), 'utf8')) as { slug: string; [k: string]: unknown });
      } catch {
        return null; // a missing/corrupt detail file means the snapshot isn't trustworthy — fall back to full regen
      }
    }
    return { manifest, details };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null; // any other read failure (bad JSON, etc.) — same fallback
  }
}

// Call under the catalog leader lock. Readers resolve current once per request.
export async function publishGeneration(input: Input) {
  if (!input.outDir.trim() || !SAFE_SLUG.test(input.storeSlug)) throw new Error('Invalid catalog destination or store');
  if (input.details.some(d => !SAFE_SLUG.test(d.slug)) || new Set(input.details.map(d => d.slug)).size !== input.details.length) throw new Error('Invalid or duplicate product slug');
  const root = resolve(input.outDir);
  const generations = join(root, 'generations');
  await mkdir(generations, { recursive: true });
  let previous: string | undefined;
  try {
    previous = await readlink(join(root, 'current'));
    if (!/^generations\/[0-9a-f-]{36}$/.test(previous)) throw new Error('Refusing foreign catalog pointer');
    const marker = JSON.parse(await readFile(join(root, previous, 'marker.json'), 'utf8')) as { source?: string; storeSlug?: string };
    if (marker.source !== 'sellright' || marker.storeSlug !== input.storeSlug) throw new Error('Refusing foreign catalog destination');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (previous) throw new Error('Current catalog marker is missing');
  }
  // Claim a new directory exclusively, including simultaneous first publication.
  const ownerPath = join(root, 'owner.json');
  try {
    await writeFile(ownerPath, JSON.stringify({ source: 'sellright', storeSlug: input.storeSlug }), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { source?: string; storeSlug?: string };
    if (owner.source !== 'sellright' || owner.storeSlug !== input.storeSlug) throw new Error('Refusing foreign catalog destination');
  }
  const generation = randomUUID();
  const target = join(generations, generation);
  const pointer = join(root, `.current-${generation}`);
  let published = false;
  try {
    await mkdir(join(target, 'products'), { recursive: true });
    await writeFile(join(target, 'shop-catalog.json'), JSON.stringify(input.manifest));
    for (const detail of input.details) await writeFile(join(target, 'products', `${detail.slug}.json`), JSON.stringify(detail));
    await writeFile(join(target, 'marker.json'), JSON.stringify({ format: 1, source: 'sellright', storeSlug: input.storeSlug, generation, generatedAt: new Date().toISOString() }));
    await symlink(`generations/${generation}`, pointer);
    await rename(pointer, join(root, 'current'));
    published = true;
    // Only remove generations marked as ours. Keep the previous complete snapshot.
    for (const name of await readdir(generations)) {
      if (!GENERATION.test(name) || name === generation || previous === `generations/${name}`) continue;
      try {
        const marker = JSON.parse(await readFile(join(generations, name, 'marker.json'), 'utf8')) as { source?: string; storeSlug?: string; generation?: string; generatedAt?: string };
        // Grace period protects readers that pinned an older generation mid-request.
        if (marker.source === 'sellright' && marker.storeSlug === input.storeSlug && marker.generation === name && Date.now() - Date.parse(marker.generatedAt ?? '') > 600000) await rm(join(generations, name), { recursive: true });
      } catch { /* A foreign/incomplete directory is never a cleanup target. */ }
    }
    return { generation, products: input.details.length };
  } finally {
    await rm(pointer, { force: true });
    if (!published) await rm(target, { recursive: true, force: true });
  }
}
