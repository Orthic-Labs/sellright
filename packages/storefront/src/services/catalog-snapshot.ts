export async function readCatalogSnapshot<T>(file: string, config = {
  directory: process.env.CATALOG_DIR,
  storeSlug: import.meta.env.VITE_SELLRIGHT_STORE_SLUG || 'demo',
}): Promise<T> {
  if (!config.directory?.trim()) throw new Error('SellRight catalog directory is not configured');
  if (file !== 'shop-catalog.json' && !/^products\/[a-z0-9][a-z0-9_-]*\.json$/.test(file)) throw new Error('Invalid catalog file');
  const { readFile, realpath } = await import('node:fs/promises');
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
  return JSON.parse(await readFile(join(generation, file), 'utf8')) as T;
}
