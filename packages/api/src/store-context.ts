import { pool } from './db/client.js';

export interface StoreCtx {
  id: string;
  slug: string;
  name: string;
  currency: string;
  taxRate: number;
}

/**
 * Resolve a store from the registry (the `store` table is not RLS'd — it's the
 * tenant registry). In production this maps an incoming host/subdomain to a
 * store; in dev we accept an `x-store-slug` header. After resolving, all data
 * access runs inside withStore(store.id) so RLS confines it to that store.
 */
export async function resolveStore(slug: string): Promise<StoreCtx | null> {
  const r = await pool.query<StoreCtx>(
    'SELECT id, slug, name, currency, tax_rate AS "taxRate" FROM store WHERE slug = $1 LIMIT 1',
    [slug],
  );
  return r.rows[0] ?? null;
}

export const DEV_DEFAULT_STORE = 'damned';
