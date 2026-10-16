/**
 * Canonical public URL of a store's storefront (store.config.storefrontUrl).
 * Sezzle/Stripe return URLs and email links are built from it, so it must be a
 * clean origin (+ optional path prefix): https only, except plain http on a
 * loopback host for local/e2e stacks. No credentials, query or fragment.
 * Returns the normalised string without a trailing slash, or null if invalid.
 */
export function normalizeStorefrontUrl(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return (url.origin + url.pathname).replace(/\/+$/u, '');
}
