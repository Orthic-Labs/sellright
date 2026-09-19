import { mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

const GENERATION = /^[0-9a-f-]{36}$/;
const SAFE_SLUG = /^[a-z0-9][a-z0-9_-]*$/;
type Input = { outDir: string; storeSlug: string; manifest: unknown; details: { slug: string }[] };

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
