export interface RefreshResult {
  totalUrls: number;
  cdn: { configured: boolean; purged: boolean; urls: string[] };
  indexNow: { attempted: boolean; submitted: number; ok: boolean | null; status: number | null; error: string | null };
}

/** Plain-language lines for the outcome of a sitemap refresh. */
export function describeRefresh(r: RefreshResult): string[] {
  const out: string[] = [];
  out.push(`${r.totalUrls} URL${r.totalUrls === 1 ? '' : 's'} currently listed.`);
  if (!r.cdn.configured) out.push('CDN purge skipped: no Cloudflare zone is configured, so nothing is cached on our side.');
  else if (r.cdn.purged) out.push(`CDN copies purged (${r.cdn.urls.length} sitemap URLs).`);
  else out.push('CDN purge failed; cached sitemaps may stay stale until they expire.');
  if (r.indexNow.attempted) {
    if (r.indexNow.ok) out.push(`IndexNow accepted ${r.indexNow.submitted} URL${r.indexNow.submitted === 1 ? '' : 's'}.`);
    else out.push(`IndexNow was not accepted${r.indexNow.status ? ` (HTTP ${r.indexNow.status})` : ''}${r.indexNow.error ? `: ${r.indexNow.error}` : ''}.`);
  }
  return out;
}

/** Must match packages/api's IndexNow key rule (seo/config.ts): hex, 8-128 chars. */
const INDEXNOW_KEY_RE = /^[a-f0-9]{8,128}$/i;

/** Error message for a site URL draft, or null when it is valid. Blank = clear. */
export function validateSiteUrl(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  let u: URL;
  try { u = new URL(t); } catch { return 'Enter a full address such as https://example.com'; }
  if (u.protocol !== 'https:') return 'The site URL must start with https://';
  return null;
}

/** Error message for an IndexNow key draft, or null when valid. Blank = clear. */
export function validateIndexNowKey(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  return INDEXNOW_KEY_RE.test(t) ? null : 'The key must be 8-128 hexadecimal characters (0-9, a-f)';
}

/** Show only the first/last two characters of a key until the user reveals it. */
export function maskKey(key: string | null | undefined): string {
  if (!key) return '';
  if (key.length <= 6) return '•'.repeat(key.length);
  return `${key.slice(0, 2)}${'•'.repeat(Math.min(key.length - 4, 20))}${key.slice(-2)}`;
}

/** PATCH body containing only the fields that changed (blank clears to null). */
export function seoSettingsPatch(
  current: { siteUrl: string | null; indexNowKey: string | null },
  draft: { siteUrl: string; indexNowKey: string },
): { siteUrl?: string | null; indexNowKey?: string | null } {
  const out: { siteUrl?: string | null; indexNowKey?: string | null } = {};
  const url = draft.siteUrl.trim() || null;
  const key = draft.indexNowKey.trim() || null;
  if (url !== current.siteUrl) out.siteUrl = url;
  if (key !== current.indexNowKey) out.indexNowKey = key;
  return out;
}
