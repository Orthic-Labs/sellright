/**
 * Central "stock changed" signal for the zero-cache catalog manifest.
 *
 * LOCKED invariant (see the storefront stock-architecture spec this mirrors):
 * no debounce, no TTL, no polling for stock. The manifest's `inStock` must
 * reflect the `stock` table the instant an `on_hand`/`allocated` write
 * COMMITS. jobs/scheduler.ts no longer polls the catalog manifest on an
 * interval — every code path that mutates stock calls `onStockChanged`
 * exactly once, right after its own transaction commits (NEVER from inside
 * a transaction that might still roll back — a regeneration triggered by a
 * write that later aborts would publish a stock state that was never real).
 *
 * Concurrency (mirrors damned/admin's CatalogManifestService.triggerImmediateRegeneration,
 * the reference implementation for this rule):
 *   - No setTimeout/debounce/coalesce window of any kind for stock.
 *   - If a regeneration is already running for a store when another stock
 *     change lands, that change doesn't get its own generation — it flags a
 *     single trailing rerun, which starts the moment the in-flight one
 *     finishes. Any number of concurrent triggers during a run collapse into
 *     that one trailing rerun (not zero, not one-per-trigger), so the final
 *     state is always eventually published and the process never runs an
 *     unbounded number of overlapping generations.
 *   - Across processes, `withLeaderLock('catalog-manifest', ..., storeSlug)`
 *     (a non-blocking Postgres advisory lock, already used by the old polling
 *     job) keeps two instances from writing the same store's manifest at the
 *     same time. `publishCatalogManifest`/`publishGeneration` also write via
 *     temp-dir + atomic rename, so even a lock miss can't corrupt `current`.
 *
 * Scope: a deployment publishes exactly one store's manifest (env.STORE_SLUG,
 * same gate the old scheduler job used). `onStockChanged` takes the slug of
 * the store whose stock just changed and no-ops for every other store — this
 * matters because a single Postgres instance/admin session can have RLS-scoped
 * access to more than one store row even though each deployment only ever
 * publishes its own.
 */
import { env } from '../env.js';
import { publishCatalogManifest } from './catalog.js';
import { withLeaderLock } from '../jobs/leader-lock.js';
import { log, err as logErr } from '../lib/logger.js';
import { onCatalogCacheChanged } from '../cache/purge-hook.js';

interface RegenState {
  generating: boolean;
  trailing: boolean;
}

const states = new Map<string, RegenState>();

function stateFor(storeSlug: string): RegenState {
  let st = states.get(storeSlug);
  if (!st) {
    st = { generating: false, trailing: false };
    states.set(storeSlug, st);
  }
  return st;
}

function manifestConfigured(): boolean {
  return env.CATALOG_MANIFEST_JOBS_ENABLED === '1' && !!env.CATALOG_DIR?.trim() && !!env.STORE_SLUG?.trim();
}

/**
 * Call this AFTER a transaction that changed `stock.on_hand` or
 * `stock.allocated` for `storeSlug` has committed. Fire-and-forget: never
 * await this from a request handler — it must not add latency to the
 * caller's response, and its own failures are logged, not thrown.
 */
export function onStockChanged(storeSlug: string): void {
  // Independent of the manifest feature gate below — a deployment with the
  // catalog manifest disabled must still get Cloudflare cache purges on stock
  // change. onCatalogCacheChanged() itself no-ops per-store when that store
  // has no Cloudflare config, so this is always safe to call.
  onCatalogCacheChanged(storeSlug);
  if (!manifestConfigured() || storeSlug !== env.STORE_SLUG) return;
  const st = stateFor(storeSlug);
  if (st.generating) {
    st.trailing = true;
    return;
  }
  void run(storeSlug, st);
}

async function run(storeSlug: string, st: RegenState): Promise<void> {
  st.generating = true;
  st.trailing = false;
  try {
    const result = await withLeaderLock(
      'catalog-manifest',
      () => publishCatalogManifest({ outDir: env.CATALOG_DIR!, storeSlug }),
      storeSlug,
    );
    if (result) log.info('catalog manifest regenerated on stock change', { storeSlug, products: result.products });
  } catch (e) {
    logErr.error('stock-triggered catalog manifest regeneration failed', e, { storeSlug });
  } finally {
    st.generating = false;
    if (st.trailing) {
      st.trailing = false;
      void run(storeSlug, st);
    }
  }
}

/** Test-only: drop all in-memory generation state between cases. */
export function _resetStockHookStateForTest(): void {
  states.clear();
}
