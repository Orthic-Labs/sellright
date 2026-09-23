/**
 * SEO-1: IndexNow submission — https://www.indexnow.org/documentation.
 *
 * The target (api.indexnow.org) is a fixed, trusted third-party endpoint, not
 * an admin-configurable URL — same class of outbound call as
 * security/turnstile.ts's siteverify POST, so this uses plain `fetch`
 * (injectable for tests) rather than the SSRF-guarded safeOutboundFetch,
 * which exists for admin-supplied targets like the Listmonk URL.
 *
 * Called only when the store has a key configured (config.indexNowKey) —
 * callers (routes/admin-seo.ts) are expected to no-op otherwise, but this
 * function also fails closed on its own so it's safe to call unconditionally.
 */
import type { SeoConfig } from './config.js';

const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';
const SUBMIT_TIMEOUT_MS = 8_000;

export interface IndexNowSubmitResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export async function submitIndexNowUrls(
  config: SeoConfig,
  urls: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<IndexNowSubmitResult> {
  if (!config.indexNowKey) return { ok: false, error: 'IndexNow key is not configured for this store' };
  if (!config.siteUrl) return { ok: false, error: 'siteUrl is not configured for this store' };
  const cleaned = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
  if (cleaned.length === 0) return { ok: false, error: 'no URLs to submit' };
  if (cleaned.length > 10_000) return { ok: false, error: 'too many URLs (IndexNow caps a single submission at 10,000)' };

  const host = new URL(config.siteUrl).host;
  const body = JSON.stringify({
    host,
    key: config.indexNowKey,
    keyLocation: `${config.siteUrl}/${config.indexNowKey}.txt`,
    urlList: cleaned,
  });

  try {
    const res = await fetchImpl(INDEXNOW_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body,
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'IndexNow submission failed' };
  }
}
