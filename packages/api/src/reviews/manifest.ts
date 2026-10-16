/** After a moderation commit, refresh the catalog manifest so the rating
 *  aggregate on the PDP data (schema.org AggregateRating) is current. Reuses
 *  the stock-change regeneration path (immediate, scoped to the product's
 *  variants, no debounce); a no-op where the manifest isn't configured. */
import { eq } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { onStockChanged } from '../manifest/stock-hook.js';
import { err as logErr } from '../lib/logger.js';

export async function refreshManifestForProducts(storeId: string, storeSlug: string, productIds: string[]): Promise<void> {
  try {
    const ids: string[] = [];
    for (const productId of new Set(productIds)) {
      const rows = await withStore(storeId, (tx) => tx.select({ id: s.productVariant.id }).from(s.productVariant).where(eq(s.productVariant.productId, productId)));
      ids.push(...rows.map((r) => r.id));
    }
    onStockChanged(storeSlug, ids.length ? ids : undefined);
  } catch (e) {
    logErr.error('review manifest refresh failed', e, { storeSlug });
  }
}
