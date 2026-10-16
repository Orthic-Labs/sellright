export interface CatalogSnapshotConfig {
  directory: string | undefined;
  storeSlug: string;
}

function defaultConfig(): CatalogSnapshotConfig {
  return { directory: process.env.CATALOG_DIR, storeSlug: import.meta.env.VITE_SELLRIGHT_STORE_SLUG || 'demo' };
}

function isCatalogFile(file: string): boolean {
  return file === 'shop-catalog.json' || /^products\/[a-z0-9][a-z0-9_-]*\.json$/.test(file);
}

/**
 * Brand views PR2 §7: several files from ONE generation. `current` is pinned once and its marker validated once (the checks
 * `readCatalogSnapshot` always made); every file is then read from that generation directory, so a swap of `current` between two
 * reads can never mix generations. A missing file is `null`; an invalid generation, marker or file name throws.
 */
export async function readCatalogGeneration<T>(
  files: readonly string[],
  config: CatalogSnapshotConfig = defaultConfig(),
  /** Test seam: the file reader (default node:fs/promises readFile). */
  io?: { readFile: (path: string, enc: 'utf8') => Promise<string> },
): Promise<{ generation: string; files: Record<string, T | null> }> {
  if (!config.directory?.trim()) throw new Error('SellRight catalog directory is not configured');
  for (const file of files) if (!isCatalogFile(file)) throw new Error('Invalid catalog file');
  const fsp = await import('node:fs/promises');
  const realpath = fsp.realpath;
  const readFile = io?.readFile ?? ((path: string, enc: 'utf8') => fsp.readFile(path, enc));
  const { resolve, join, relative } = await import('node:path');
  const root = await realpath(resolve(config.directory));
  // Pin one generation before reading its marker and data; current can swap meanwhile.
  const generation = await realpath(join(root, 'current'));
  const name = relative(root, generation);
  if (!/^generations\/[0-9a-f-]{36}$/.test(name)) throw new Error('Invalid catalog generation');
  const marker = JSON.parse(await readFile(join(generation, 'marker.json'), 'utf8'));
  // No age-based expiry: the publisher regenerates on every stock change, so an old but intact generation is still current.
  // generatedAt must still parse and not lie in the future (clock-skew guard, not an expiry).
  // Marker formats the publisher has written (api/src/manifest/publish.ts writes 2; 1 is the earlier layout).
  const supportedFormats = [1, 2];
  const age = Date.now() - Date.parse(marker.generatedAt);
  if (!supportedFormats.includes(marker.format) || marker.source !== 'sellright' || marker.storeSlug !== config.storeSlug || name !== `generations/${marker.generation}` || !Number.isFinite(age) || age < -60000) throw new Error('Stale or foreign catalog generation');
  const out: Record<string, T | null> = {};
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(join(generation, file), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') { out[file] = null; continue; }
      throw e;
    }
    out[file] = JSON.parse(text) as T;
  }
  return { generation: String(marker.generation), files: out };
}

/** One file of the current generation (throws when it is missing). */
export async function readCatalogSnapshot<T>(file: string, config: CatalogSnapshotConfig = defaultConfig()): Promise<T> {
  const { files } = await readCatalogGeneration<T>([file], config);
  const value = files[file];
  if (value === null || value === undefined) throw new Error('Catalog file missing');
  return value;
}
