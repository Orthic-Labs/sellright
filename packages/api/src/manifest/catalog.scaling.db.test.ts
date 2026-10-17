import { link, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Client } from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { publishCatalogManifest } from './catalog.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), link: vi.fn(actual.link), writeFile: vi.fn(actual.writeFile) };
});
const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Catalog scaling fixture requires a *_test database');
afterAll(() => pool.end());

type Measurement = {
  catalogSize: number; affected: number; dbRows: number; detailBytesRead: number;
  detailBytesSerialized: number; manifestBytes: number; links: number;
  elapsedMs: number; peakRssBytes: number; peakHeapBytes: number;
};
const isDetail = (path: unknown) => /[/\\]products(?:-v2)?[/\\][^/\\]+\.json$/.test(String(path));

// Observe existing I/O & serializer seams. Production carries no test counters.
async function measure(catalogSize: number, affected: number, publish: () => Promise<unknown>): Promise<Measurement> {
  const result: Measurement = { catalogSize, affected, dbRows: 0, detailBytesRead: 0, detailBytesSerialized: 0, manifestBytes: 0, links: 0, elapsedMs: 0, peakRssBytes: 0, peakHeapBytes: 0 };
  const sample = () => {
    const memory = process.memoryUsage();
    result.peakRssBytes = Math.max(result.peakRssBytes, memory.rss);
    result.peakHeapBytes = Math.max(result.peakHeapBytes, memory.heapUsed);
  };
  const query = Client.prototype.query;
  vi.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: unknown[]) {
    const pending = Reflect.apply(query, this, args);
    const config = args[0];
    const text = typeof config === 'string' ? config : (config as { text?: string })?.text ?? '';
    if (pending && typeof pending.then === 'function') return pending.then((response: { rows?: unknown[] }) => {
      if (/^select\b/i.test(text) && !text.includes('set_config')) result.dbRows += response.rows?.length ?? 0;
      sample();
      return response;
    });
    return pending;
  } as typeof Client.prototype.query);
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    const file = await realFs.open(path, flags, mode);
    if (isDetail(path)) {
      const read = file.readFile.bind(file);
      vi.spyOn(file, 'readFile').mockImplementation(async (...args) => {
        const bytes = await Reflect.apply(read, file, args);
        result.detailBytesRead += Buffer.byteLength(bytes);
        sample();
        return bytes;
      });
    }
    sample();
    return file;
  });
  vi.mocked(link).mockImplementation(async (source, destination) => {
    await realFs.link(source, destination);
    result.links++;
    sample();
  });
  const stringify = JSON.stringify;
  vi.spyOn(JSON, 'stringify').mockImplementation((...args) => {
    const bytes = Reflect.apply(stringify, JSON, args);
    const value = args[0] as { slug?: unknown; variants?: unknown } | null;
    if (value && typeof value.slug === 'string' && Array.isArray(value.variants)) result.detailBytesSerialized += Buffer.byteLength(bytes);
    sample();
    return bytes;
  });
  vi.mocked(writeFile).mockImplementation(async (path, bytes, options) => {
    if (/shop-catalog(?:\.v2)?\.json$/.test(String(path))) result.manifestBytes += Buffer.byteLength(bytes as string);
    await realFs.writeFile(path, bytes, options);
    sample();
  });
  sample();
  const started = performance.now();
  try {
    await publish();
    result.elapsedMs = performance.now() - started;
    sample();
    return result;
  } finally {
    vi.restoreAllMocks();
    vi.mocked(open).mockImplementation(realFs.open);
    vi.mocked(link).mockImplementation(realFs.link);
    vi.mocked(writeFile).mockImplementation(realFs.writeFile);
  }
}

describe('scoped catalog detail work', () => {
  it('keeps DB rows & detail bytes fixed while complete manifest/link work grows', async () => {
    const measurements: Measurement[] = [];
    const affected = 2;
    for (const catalogSize of [24, 192]) {
      const store = randomUUID(), slug = `manifest-scale-${store}`;
      const products = Array.from({ length: catalogSize }, () => randomUUID());
      const variants = products.map(() => randomUUID());
      const outDir = await mkdtemp(join(tmpdir(), 'sr-manifest-scale-db-'));
      try {
        await withStore(store, async tx => {
          await tx.execute(sql`INSERT INTO store (id, slug, name, currency) VALUES (${store}, ${slug}, 'Scaling', 'USD')`);
          await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, description, status)
            SELECT id, ${store}, 'item-' || lpad(ordinality::text, 4, '0'), 'Item ' || lpad(ordinality::text, 4, '0'), repeat('detail-body-', 1024), 'active'
            FROM unnest(${products}::uuid[]) WITH ORDINALITY AS fixture(id, ordinality)`);
          await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price)
            SELECT id, ${store}, product_id, 'SKU-' || product_id::text, 'Variant', 1000
            FROM unnest(${variants}::uuid[], ${products}::uuid[]) AS fixture(id, product_id)`);
          await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated)
            SELECT id, ${store}, 10, 0 FROM product_variant WHERE store_id = ${store}`);
        });
        const first = await publishCatalogManifest({ outDir, storeSlug: slug });
        const priorUnchanged = await readFile(join(outDir, 'generations', first.generation, 'products-v2/item-0003.json'), 'utf8');
        measurements.push(await measure(catalogSize, affected, () => publishCatalogManifest({ outDir, storeSlug: slug, variantIds: variants.slice(0, affected) })));
        expect(await readFile(join(outDir, 'current/products-v2/item-0003.json'), 'utf8')).toBe(priorUnchanged);
        for (const file of ['shop-catalog.json', 'shop-catalog.v2.json']) {
          expect(JSON.parse(await readFile(join(outDir, 'current', file), 'utf8')).totalItems).toBe(catalogSize);
        }
        // Repeat proves inventories describe post-link ctime/nlink, not the
        // source metadata captured before publication changed its inode.
        const repeated = await measure(catalogSize, affected, () => publishCatalogManifest({ outDir, storeSlug: slug, variantIds: variants.slice(0, affected) }));
        expect(repeated.detailBytesRead).toBe(0);
        expect(repeated.detailBytesSerialized).toBe(measurements.at(-1)!.detailBytesSerialized);
        console.info('catalog-scoped-scaling-repeat', JSON.stringify(repeated));
      } finally { await rm(outDir, { recursive: true, force: true }); }
    }
    const [small, large] = measurements as [Measurement, Measurement];
    expect(small.dbRows).toBeGreaterThan(0);
    expect(large.dbRows).toBe(small.dbRows);
    expect(small.detailBytesRead).toBe(0);
    expect(large.detailBytesRead).toBe(0);
    expect(small.detailBytesSerialized).toBeGreaterThan(0);
    expect(large.detailBytesSerialized).toBe(small.detailBytesSerialized);
    for (const result of measurements) expect(result.links).toBe(2 * (result.catalogSize - affected));
    expect(large.manifestBytes).toBeGreaterThan(small.manifestBytes);
    // Timing & sampled memory are observations, not machine-dependent gates.
    console.info('catalog-scoped-scaling', JSON.stringify(measurements));
  }, 60000);
});
