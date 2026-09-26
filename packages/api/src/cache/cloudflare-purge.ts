/**
 * Per-store Cloudflare edge-cache purge. Optional by design — a store with no
 * Cloudflare config configured (zone id + API token, both via env) simply
 * gets no-op purge calls. Cache purge must NEVER become a hard dependency for
 * a catalog/stock write to succeed: every failure here is logged, never
 * thrown, and never awaited by the caller (same rule the zero-cache stock
 * manifest hook follows — see manifest/stock-hook.ts).
 */
import { env } from '../env.js';
import { appValue } from '../email/dispatch.js';
import { log, err as logErr } from '../lib/logger.js';

export interface CloudflareStoreConfig {
  zoneId: string;
  apiToken: string;
}

/** Resolve a store's Cloudflare zone id + API token from env. Per-store
 * `_BY_APP`-style maps (keyed by store SLUG here, not a product app key) win
 * over the single-store fallback vars. Returns null when either half is
 * missing for this store — disabled, not an error. */
export function resolveCloudflareConfig(storeSlug: string): CloudflareStoreConfig | null {
  const zoneId = appValue(env.CLOUDFLARE_ZONE_ID_BY_APP, storeSlug) ?? env.CLOUDFLARE_ZONE_ID;
  const apiToken = appValue(env.CLOUDFLARE_API_TOKEN_BY_APP, storeSlug) ?? env.CLOUDFLARE_API_TOKEN;
  if (!zoneId || !apiToken) return null;
  return { zoneId, apiToken };
}

// Cloudflare's purge_cache endpoint accepts at most 30 files per call.
const CF_PURGE_BATCH = 30;

/**
 * Purge specific absolute URLs from a store's Cloudflare zone. No-op (returns
 * `false`) when the store has no Cloudflare config. Never throws — every
 * failure (config, network, non-2xx, `success: false`) is logged and
 * swallowed so a purge outage can never block or roll back the write that
 * triggered it. Returns `true` only when every batch succeeded — callers that
 * fire-and-forget this (the catalog/stock hooks) ignore the return value;
 * the manual admin purge route (routes/admin-cache.ts) uses it to report
 * real success/failure back to the caller instead of a blind "queued".
 */
export async function purgeCloudflareUrls(storeSlug: string, urls: string[]): Promise<boolean> {
  if (!urls.length) return false;
  const cfg = resolveCloudflareConfig(storeSlug);
  if (!cfg) return false;

  const batches: string[][] = [];
  for (let i = 0; i < urls.length; i += CF_PURGE_BATCH) batches.push(urls.slice(i, i + CF_PURGE_BATCH));

  let allOk = true;
  for (const files of batches) {
    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${cfg.zoneId}/purge_cache`, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ files }),
      });
      const body = (await res.json().catch(() => null)) as { success?: boolean; errors?: unknown } | null;
      if (!res.ok || body?.success === false) {
        allOk = false;
        logErr.error('cloudflare cache purge rejected', new Error(`HTTP ${res.status}`), { storeSlug, fileCount: files.length, errors: body?.errors });
      } else {
        log.info('cloudflare cache purged', { storeSlug, fileCount: files.length });
      }
    } catch (e) {
      allOk = false;
      logErr.error('cloudflare cache purge request failed', e, { storeSlug, fileCount: files.length });
    }
  }
  return allOk;
}
