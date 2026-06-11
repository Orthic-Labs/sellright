import { pool } from './db/client.js';

export interface StoreCtx {
  id: string;
  slug: string;
  name: string;
  currency: string;
  taxRate: number;
  taxInclusive: boolean;
  shippingTaxable: boolean;
  config: unknown | null;
}

/** Slug shape: lowercase, 1-64 chars, alnum + dash/underscore, must start+end alnum. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

/** Throws a 404 (HttpError) for invalid or unknown slugs. Use this in route
 *  handlers so callers see 404 instead of a thrown 500. WP1.6. */
export function assertValidSlug(slug: string): string {
  if (!SLUG_RE.test(slug)) throw new StoreSlugError('invalid slug format');
  return slug;
}

export class StoreSlugError extends Error {
  readonly httpStatus = 404 as const;
  constructor(message: string) { super(message); this.name = 'StoreSlugError'; }
}

/**
 * Resolve a store from the registry (the `store` table is not RLS'd — it's the
 * tenant registry). In production this maps an incoming host/subdomain to a
 * store; in dev we accept an `x-store-slug` header. After resolving, all data
 * access runs inside withStore(store.id) so RLS confines it to that store.
 * Throws StoreSlugError (404) on invalid or unknown slugs. WP1.6.
 */
export async function resolveStore(slug: string): Promise<StoreCtx> {
  assertValidSlug(slug);
  const r = await pool.query<StoreCtx>(
    'SELECT id, slug, name, currency, tax_rate AS "taxRate", tax_inclusive AS "taxInclusive", shipping_taxable AS "shippingTaxable", config FROM store WHERE slug = $1 LIMIT 1',
    [slug],
  );
  if (!r.rows[0]) throw new StoreSlugError(`unknown store: ${slug}`);
  return r.rows[0];
}

export const DEV_DEFAULT_STORE = 'damned';
