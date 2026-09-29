/**
 * SEO-1: robots.txt builder. Pure function — no DB, no fetch.
 *
 * Default output (no store extras): one `User-agent: *` group, no
 * `Crawl-delay`, no AI-crawler-specific rules. `disallow` entries are path
 * segments (no leading slash — see seo/config.ts's DEFAULT_ROBOTS_DISALLOW);
 * this function adds the slash.
 *
 * Per-store extras (store.config.seo, validated in seo/config.ts) let a store
 * reproduce an existing robots.txt exactly:
 *   robotsHeader     — comment lines emitted first
 *   robotsDirectives — extra lines inside the `*` group (e.g. Content-Signal)
 *   robotsExtra      — raw block after the `*` group (bot-specific groups)
 *   robotsSitemaps   — additional sitemap paths after the index
 *   robotsFooter     — raw block emitted last (comments)
 */
export interface RobotsExtras {
  header?: string[];
  directives?: string[];
  extra?: string | null;
  sitemaps?: string[];
  footer?: string | null;
}

export function robotsTxt(siteUrl: string, disallow: string[], extras: RobotsExtras = {}): string {
  const lines: string[] = [];
  if (extras.header?.length) lines.push(...extras.header.map((h) => (h.startsWith('#') ? h : `# ${h}`)), '');
  lines.push('User-agent: *');
  if (extras.directives?.length) lines.push(...extras.directives);
  lines.push('Allow: /');
  for (const segment of disallow) {
    const path = segment.startsWith('/') ? segment : `/${segment}`;
    lines.push(`Disallow: ${path}`);
  }
  if (extras.extra) lines.push('', extras.extra.replace(/\s+$/, ''));
  lines.push('', `Sitemap: ${siteUrl}/sitemap.xml`);
  for (const p of extras.sitemaps ?? []) {
    const path = p.startsWith('/') ? p : `/${p}`;
    if (path !== '/sitemap.xml') lines.push(`Sitemap: ${siteUrl}${path}`);
  }
  if (extras.footer) lines.push('', extras.footer.replace(/\s+$/, ''));
  return lines.join('\n') + '\n';
}
