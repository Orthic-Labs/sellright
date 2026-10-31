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
  const apiToken = appValue(env.CLOUDFLARE_API_TOKEN_BY_APP, storeSlug) ?? env.CLOUDFLARE_API_TOKEN;
  if (!apiToken) return null;
  const zoneId = appValue(env.CLOUDFLARE_ZONE_ID_BY_APP, storeSlug) ?? env.CLOUDFLARE_ZONE_ID;
  if (zoneId) return { zoneId, apiToken };
  // Multi-zone store with no default zone: usable when at least one of its hosts maps to a zone.
  const hostZone = storeHosts(storeSlug).map((h) => zoneForHost(h)).find(Boolean);
  return hostZone ? { zoneId: '', apiToken } : null;
}

/** Extra hostnames a store's storefront is served on (STOREFRONT_HOSTS_BY_STORE, "slug=h1|h2|h3"), lowercased and
 * de-duplicated. Empty for a single-host store (var unset), which keeps every purge request exactly as before. */
export function storeHosts(storeSlug: string): string[] {
  const raw = appValue(env.STOREFRONT_HOSTS_BY_STORE, storeSlug);
  if (!raw) return [];
  return [...new Set(raw.split('|').map((h) => h.trim().toLowerCase()).filter(Boolean))];
}

/** Zone id for one hostname from CLOUDFLARE_ZONE_ID_BY_HOST ("host=zone,..."), or undefined. */
export function zoneForHost(host: string): string | undefined {
  return appValue(env.CLOUDFLARE_ZONE_ID_BY_HOST, host);
}

/** Fan each URL out to every host of the store (same path + query, scheme of the source URL). Only URLs whose host is
 * one of the store's listed hosts are expanded; with no host list this returns the input unchanged. */
export function fanOutUrls(storeSlug: string, urls: string[]): string[] {
  const hosts = storeHosts(storeSlug);
  if (!hosts.length) return urls;
  const out = new Set<string>();
  for (const raw of urls) {
    out.add(raw);
    let u: URL;
    try { u = new URL(raw); } catch { continue; }
    if (!hosts.includes(u.hostname.toLowerCase())) continue;
    for (const h of hosts) out.add(`${u.protocol}//${h}${u.pathname}${u.search}`);
  }
  return [...out];
}

/** Group items by Cloudflare zone via the item's hostname. Hosts without a mapping use the store's default zone; items
 * with no zone at all land in the '' group (reported as a failure by callers). Insertion order is preserved. */
function groupByZone<T>(cfg: CloudflareStoreConfig, items: T[], hostOf: (i: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const zone = zoneForHost(hostOf(item)) ?? cfg.zoneId;
    const g = groups.get(zone);
    if (g) g.push(item); else groups.set(zone, [item]);
  }
  return groups;
}

const urlHost = (u: string): string => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };

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

  const groups = groupByZone(cfg, fanOutUrls(storeSlug, urls), urlHost);

  let allOk = true;
  for (const [zoneId, zoneUrls] of groups) {
    if (!zoneId) {
      allOk = false;
      logErr.error('cloudflare cache purge has no zone for host', new Error('no zone id'), { storeSlug, fileCount: zoneUrls.length });
      continue;
    }
    const batches: string[][] = [];
    for (let i = 0; i < zoneUrls.length; i += CF_PURGE_BATCH) batches.push(zoneUrls.slice(i, i + CF_PURGE_BATCH));
    for (const files of batches) {
      try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
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
  }
  return allOk;
}

/** Cloudflare purge-by-hostname accepts at most 100 hosts per call on every plan (docs: "Max operations per request"). */
export const CF_PURGE_MAX_HOSTS = 100;

/**
 * Purge every cached object for the given hostnames in a store's zone (`{ hosts }` body: available on all plans, and
 * scoped to the host, unlike purge_everything which would also drop other tenants on a shared zone). Same contract as
 * purgeCloudflareUrls: never throws; false on no config / rejection / network error. Rate limit on Free is 5 requests
 * per minute per account (shared with other non-URL purges), so callers must not loop on it.
 */
export async function purgeCloudflareHosts(storeSlug: string, hosts: string[]): Promise<boolean> {
  const given = [...new Set(hosts.filter(Boolean))];
  const siblings = storeHosts(storeSlug);
  // Multi-host store: a purge of any one of its hosts covers all of them.
  const expanded = siblings.length && given.some((h) => siblings.includes(h.toLowerCase())) ? [...new Set([...given, ...siblings])] : given;
  const list = expanded.slice(0, CF_PURGE_MAX_HOSTS);
  if (!list.length) return false;
  const cfg = resolveCloudflareConfig(storeSlug);
  if (!cfg) return false;
  let allOk = true;
  for (const [zoneId, zoneHosts] of groupByZone(cfg, list, (h) => h.toLowerCase())) {
    if (!zoneId) {
      logErr.error('cloudflare host purge has no zone for host', new Error('no zone id'), { storeSlug, hostCount: zoneHosts.length });
      allOk = false;
      continue;
    }
    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ hosts: zoneHosts }),
      });
      const body = (await res.json().catch(() => null)) as { success?: boolean; errors?: unknown } | null;
      if (!res.ok || body?.success === false) {
        logErr.error('cloudflare host purge rejected', new Error(`HTTP ${res.status}`), { storeSlug, hostCount: zoneHosts.length, errors: body?.errors });
        allOk = false;
        continue;
      }
      log.info('cloudflare host purged', { storeSlug, hostCount: zoneHosts.length });
    } catch (e) {
      logErr.error('cloudflare host purge request failed', e, { storeSlug, hostCount: zoneHosts.length });
      allOk = false;
    }
  }
  return allOk;
}
