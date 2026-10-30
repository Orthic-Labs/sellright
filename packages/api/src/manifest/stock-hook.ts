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
 *
 * SELLRIGHT-ISSUES P1 (per-product regeneration): `onStockChanged` takes an
 * OPTIONAL `variantIds` — when every trigger since the last completed run
 * named specific variants, the regeneration is scoped to just their products
 * (manifest/catalog.ts reuses the rest of the current generation instead of
 * re-querying the whole catalog). ANY untagged trigger (a caller that didn't
 * know which variants changed — most order-fulfillment paths touching
 * several lines at once) forces the WHOLE batch back to a full regen: this
 * is the safe default, never the other way around. Call sites are being
 * migrated to pass variantIds incrementally, starting with the highest-
 * frequency single/bulk stock-edit endpoints (admin-products.ts) — every
 * other call site keeps working unchanged on the full-regen path.
 *
 * SELLRIGHT-ISSUES P1 (durable retry): manifest-pending.ts's
 * catalog_manifest_pending table records "a regeneration is owed for this
 * store" BEFORE the in-process attempt and clears it only once that attempt
 * actually succeeds. A crash between those two points (this process dies,
 * or `withLeaderLock` hands the write to a different instance that then also
 * dies) leaves the row behind; jobs/scheduler.ts's catalog-manifest-drain
 * pass republishes (always a full regen — the scoped variant list from the
 * lost trigger isn't preserved, only the fact that SOMETHING was owed) any
 * row old enough to prove its in-process attempt never finished. No trigger
 * is silently lost, independent of which process (if any) is still alive.
 */
import { env } from '../env.js';
import { CatalogPurgeError, publishCatalogManifest } from './catalog.js';
import { withLeaderLock } from '../jobs/leader-lock.js';
import { _resetJobAdmissionForTest, AdmissionStoppedError, jobAdmission } from '../jobs/admission.js';
import { detachFromPass } from '../db/client.js';
import { resolveStore } from '../store-context.js';
import { markManifestRegenerationPending, clearManifestRegenerationPending } from './manifest-pending.js';
import { log, err as logErr } from '../lib/logger.js';
import { onCatalogCacheChanged } from '../cache/purge-hook.js';

/** 'full' wins over any scoped set — see the file header. Scoped ids are tagged `v:` (variant) or `p:` (product,
 *  V60 / #357 content edits) so one trailing rerun can carry both. */
type RegenScope = 'full' | Set<string>;

interface RegenState {
  generating: boolean;
  /** Accumulated scope for triggers that arrived WHILE a run was in flight. */
  trailing: RegenScope | null;
}

const states = new Map<string, RegenState>();

function stateFor(storeSlug: string): RegenState {
  let st = states.get(storeSlug);
  if (!st) {
    st = { generating: false, trailing: null };
    states.set(storeSlug, st);
  }
  return st;
}

function manifestConfigured(): boolean {
  return env.CATALOG_MANIFEST_JOBS_ENABLED === '1' && !!env.CATALOG_DIR?.trim() && !!env.STORE_SLUG?.trim();
}

function mergeScope(a: RegenScope | null, b: RegenScope): RegenScope {
  if (a === null) return b;
  if (a === 'full' || b === 'full') return 'full';
  return new Set([...a, ...b]);
}

/**
 * Call this AFTER a transaction that changed `stock.on_hand` or
 * `stock.allocated` for `storeSlug` has committed. Fire-and-forget: never
 * await this from a request handler — it must not add latency to the
 * caller's response, and its own failures are logged, not thrown.
 *
 * `variantIds`: the specific variant(s) whose stock changed, when the caller
 * knows them precisely. Omit when a batch touched an unenumerated/uncertain
 * set of variants — omitting is always safe (forces a full regen for this
 * trigger); passing an INCOMPLETE list is not (the manifest would silently
 * skip a changed product), so only pass it when it's exhaustive for this
 * commit.
 */
export function onStockChanged(storeSlug: string, variantIds?: string[]): void {
  schedule(storeSlug, variantIds?.length ? new Set(variantIds.map((id) => `v:${id}`)) : 'full', {});
}

/**
 * V60 / #357: a product/variant content edit committed (name, description, price, media, status, ...). Schedules
 * the same immediate, scoped content publication a stock change does, scoped to these products. The edge purge for
 * the product page then follows the publication (N9) instead of preceding it. Same fire-and-forget contract as
 * onStockChanged: call after commit, never awaited, never throws.
 */
export function onCatalogContentChanged(storeSlug: string, productIds: string[], opts: { productPath?: string } = {}): void {
  schedule(storeSlug, productIds.length ? new Set(productIds.map((id) => `p:${id}`)) : 'full', opts);
}

function schedule(storeSlug: string, scope: RegenScope, purgeOpts: { productPath?: string }): void {
  // N9: with publication configured for this store, the purge runs AFTER the new generation is published
  // (manifest/catalog.ts). Without it there is no content artifact to wait for, so purge now — a deployment with
  // the catalog manifest disabled must still get Cloudflare cache purges. Never throws (see purge-hook.ts).
  if (!manifestConfigured() || storeSlug !== env.STORE_SLUG) {
    onCatalogCacheChanged(storeSlug, purgeOpts);
    return;
  }
  const st = stateFor(storeSlug);
  // #360 H1 / M2: detached from whatever called this (a request, or a job pass that may end — and give its lease
  // back — before this finishes). The durable marker below is one short write on the caller's side of the pools
  // (request pool from a request); the publication itself is admitted background work (jobs pool, capped).
  void detachFromPass(() => enqueue(storeSlug, st, scope));
}

async function enqueue(storeSlug: string, st: RegenState, scope: RegenScope): Promise<void> {
  try {
    const store = await resolveStore(storeSlug);
    // Every trigger is durable before joining an in-process batch. A later
    // publish can acknowledge only its own token, never a newer trigger.
    const pending = await markManifestRegenerationPending(store.id, storeSlug);
    const coveredScope: RegenScope = pending?.requiresFull ? 'full' : scope;
    if (st.generating) {
      st.trailing = mergeScope(st.trailing, coveredScope);
      return;
    }
    await run(storeSlug, store.id, pending?.token ?? null, st, coveredScope);
  } catch (e) {
    logErr.error('stock-triggered catalog manifest bookkeeping failed', e, { storeSlug });
  }
}

async function run(storeSlug: string, storeId: string, token: string | null, st: RegenState, scope: RegenScope): Promise<void> {
  st.generating = true;
  st.trailing = null;
  try {
    const tagged = scope === 'full' ? [] : [...scope];
    const variantIds = scope === 'full' ? undefined : tagged.filter((id) => id.startsWith('v:')).map((id) => id.slice(2));
    const productIds = scope === 'full' ? undefined : tagged.filter((id) => id.startsWith('p:')).map((id) => id.slice(2));
    // #360 N4: an HTTP request triggered this, but the publication is background work: it goes through the shared
    // job admission (jobs pool, concurrency cap), never the request pool the shopper's request is using.
    const result = await jobAdmission().run('catalog-manifest:stock', () => withLeaderLock(
      'catalog-manifest',
      () => publishCatalogManifest({ outDir: env.CATALOG_DIR!, storeSlug, ...(variantIds?.length ? { variantIds } : {}), ...(productIds?.length ? { productIds } : {}) }),
      storeSlug,
    ));
    if (result) log.info('catalog manifest regenerated on stock change', { storeSlug, products: result.products, scope: scope === 'full' ? 'full' : `${scope.size} product-scoped variant(s)` });
    // Only clear the durable marker on an ACTUAL publish. `withLeaderLock`
    // returns undefined when another instance held the lock for this tick —
    // that instance's own run is responsible for the marker, not this one.
    if (result && token !== null) await clearManifestRegenerationPending(storeId, token);
  } catch (e) {
    // Shutting down: the durable marker stays, the next run's drain publishes.
    if (e instanceof AdmissionStoppedError) return;
    // N9 / F5: published, but the edge purge failed or timed out. The marker stays so the drain pass republishes
    // and purges again — the retry is persisted, not held in memory.
    if (e instanceof CatalogPurgeError) { logErr.error('catalog published; edge purge failed — durable retry kept', e, { storeSlug, generation: e.published.generation }); return; }
    logErr.error('stock-triggered catalog manifest regeneration failed', e, { storeSlug });
    // Marker deliberately left in place — catalog-manifest-drain will retry.
  } finally {
    st.generating = false;
    if (st.trailing !== null) {
      const next = st.trailing;
      st.trailing = null;
      void enqueue(storeSlug, st, next);
    }
  }
}

/** Test-only: drop all in-memory generation state between cases. */
export function _resetStockHookStateForTest(): void {
  states.clear();
  _resetJobAdmissionForTest(); // a test that leaves a publication hanging must not hold the shared slots
}
