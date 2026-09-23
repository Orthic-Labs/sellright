/**
 * SEO-1 / cache-version: a per-store, monotonically increasing token derived
 * live from the data itself (queries.ts::latestStoreUpdatedAt) rather than an
 * externally-bumped counter. No debounce, no TTL, no in-memory cache — every
 * call re-runs the MAX() query, matching this org's locked stock-architecture
 * rule ("no cache anywhere, ever") applied to the wider catalog surface.
 *
 * Deriving the version from MAX(updated_at) instead of a counter means no
 * writer anywhere in the codebase has to remember to call a "bump" function —
 * migration 0068's triggers already guarantee any product/variant/collection/
 * blog_post/stock write advances this value on the very next read.
 */
import type { Tx } from '../db/client.js';
import { latestStoreUpdatedAt } from './queries.js';

export async function computeCacheVersion(tx: Tx, storeId: string): Promise<string> {
  const latest = await latestStoreUpdatedAt(tx, storeId);
  return latest.getTime().toString(36);
}
