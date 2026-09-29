import { describe, expect, it } from 'vitest';
import { robotsTxt } from './robots.js';

describe('robotsTxt', () => {
  it('allows everything by default and disallows each configured segment', () => {
    const txt = robotsTxt('https://example.com', ['checkout', 'account']);
    expect(txt).toContain('User-agent: *');
    expect(txt).toContain('Allow: /');
    expect(txt).toContain('Disallow: /checkout');
    expect(txt).toContain('Disallow: /account');
  });

  it('ends with a Sitemap line pointing at the site sitemap index', () => {
    const txt = robotsTxt('https://example.com', []);
    expect(txt.trim().endsWith('Sitemap: https://example.com/sitemap.xml')).toBe(true);
  });

  it('never emits Crawl-delay or bot-specific AI-crawler rules', () => {
    const txt = robotsTxt('https://example.com', ['checkout']);
    expect(txt).not.toMatch(/crawl-delay/i);
    expect(txt).not.toMatch(/GPTBot|CCBot|ClaudeBot|Google-Extended/i);
  });

  it('tolerates a disallow entry that already has a leading slash', () => {
    const txt = robotsTxt('https://example.com', ['/checkout']);
    expect(txt).toContain('Disallow: /checkout');
    expect(txt).not.toContain('Disallow: //checkout');
  });

  it('renders per-store extras in order: header, * group directives, extra block, sitemaps, footer', () => {
    const txt = robotsTxt('https://example.com', ['checkout'], {
      header: ['# Robots for Example'],
      directives: ['Content-Signal: search=yes, ai-train=no'],
      extra: 'User-agent: GPTBot\nDisallow: /',
      sitemaps: ['/sitemap-main.xml', 'sitemap-blog.xml', '/sitemap.xml'],
      footer: '# llms.txt: https://example.com/llms.txt',
    });
    expect(txt).toBe([
      '# Robots for Example', '',
      'User-agent: *', 'Content-Signal: search=yes, ai-train=no', 'Allow: /', 'Disallow: /checkout', '',
      'User-agent: GPTBot', 'Disallow: /', '',
      'Sitemap: https://example.com/sitemap.xml',
      'Sitemap: https://example.com/sitemap-main.xml',
      'Sitemap: https://example.com/sitemap-blog.xml', '',
      '# llms.txt: https://example.com/llms.txt',
    ].join('\n') + '\n');
  });

  it('keeps a trailing comment of the extra block attached to the sitemaps as their heading', () => {
    const txt = robotsTxt('https://example.com', [], { extra: 'User-agent: GPTBot\nDisallow: /\n\n# Sitemaps' });
    expect(txt).toContain('# Sitemaps\nSitemap: https://example.com/sitemap.xml');
  });
});
