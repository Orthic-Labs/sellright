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
});
