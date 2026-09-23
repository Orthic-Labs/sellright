/**
 * SEO-1: robots.txt builder. Pure function — no DB, no fetch.
 *
 * Deliberately excludes (per the org's seo-arch conventions, mirrored here
 * for the generic API surface): no `Crawl-delay`, no AI-crawler-specific
 * rules. `disallow` entries are path segments (no leading/trailing slash —
 * see seo/config.ts's DEFAULT_ROBOTS_DISALLOW); this function adds the slash.
 */
export function robotsTxt(siteUrl: string, disallow: string[]): string {
  const lines = ['User-agent: *', 'Allow: /'];
  for (const segment of disallow) {
    const path = segment.startsWith('/') ? segment : `/${segment}`;
    lines.push(`Disallow: ${path}`);
  }
  lines.push('', `Sitemap: ${siteUrl}/sitemap.xml`);
  return lines.join('\n') + '\n';
}
