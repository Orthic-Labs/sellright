import { env } from '../env.js';
import { pool } from '../db/client.js';
import { withLeaderLock } from '../jobs/leader-lock.js';
import { publishCatalogManifest } from './catalog.js';

try {
  if (!env.CATALOG_DIR?.trim() || !env.STORE_SLUG?.trim()) throw new Error('Set explicit CATALOG_DIR and STORE_SLUG');
  const result = await withLeaderLock('catalog-manifest', () => publishCatalogManifest({ outDir: env.CATALOG_DIR!, storeSlug: env.STORE_SLUG! }), env.STORE_SLUG);
  // eslint-disable-next-line no-console
  console.log(result ?? { skipped: 'another catalog publisher holds the lock' });
} finally {
  await pool.end();
}
