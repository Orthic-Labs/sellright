import { describe, expect, it } from 'vitest';
import { describeRefresh, maskKey, seoSettingsPatch, validateIndexNowKey, validateSiteUrl, type RefreshResult } from './seo';

const base: RefreshResult = { totalUrls: 3, cdn: { configured: false, purged: false, urls: [] }, indexNow: { attempted: false, submitted: 0, ok: null, status: null, error: null } };

describe('describeRefresh', () => {
  it('explains a skipped CDN purge', () => {
    expect(describeRefresh(base)).toEqual(['3 URLs currently listed.', 'CDN purge skipped: no Cloudflare zone is configured, so nothing is cached on our side.']);
  });
  it('reports purge and IndexNow outcomes', () => {
    const ok = describeRefresh({ ...base, totalUrls: 1, cdn: { configured: true, purged: true, urls: ['a', 'b'] }, indexNow: { attempted: true, submitted: 1, ok: true, status: 200, error: null } });
    expect(ok).toEqual(['1 URL currently listed.', 'CDN copies purged (2 sitemap URLs).', 'IndexNow accepted 1 URL.']);
    const bad = describeRefresh({ ...base, cdn: { configured: true, purged: false, urls: [] }, indexNow: { attempted: true, submitted: 0, ok: false, status: 429, error: null } });
    expect(bad[1]).toMatch(/purge failed/);
    expect(bad[2]).toBe('IndexNow was not accepted (HTTP 429).');
  });
});

describe('SEO settings helpers', () => {
  it('validates the site URL as https', () => {
    expect(validateSiteUrl('')).toBeNull();
    expect(validateSiteUrl('https://example.com')).toBeNull();
    expect(validateSiteUrl('http://example.com')).toMatch(/https/);
    expect(validateSiteUrl('example.com')).toMatch(/full address/);
  });
  it('validates the IndexNow key', () => {
    expect(validateIndexNowKey('')).toBeNull();
    expect(validateIndexNowKey('abcdef0123456789')).toBeNull();
    expect(validateIndexNowKey('abc')).not.toBeNull();
    expect(validateIndexNowKey('zzzzzzzzzz')).not.toBeNull();
    expect(validateIndexNowKey('a'.repeat(129))).not.toBeNull();
  });
  it('masks keys', () => {
    expect(maskKey(null)).toBe('');
    expect(maskKey('abcdef0123456789')).toBe('ab' + '•'.repeat(12) + '89');
    expect(maskKey('abcd')).toBe('••••');
  });
  it('builds a minimal patch of changed fields; blank clears', () => {
    const cur = { siteUrl: 'https://a.com', indexNowKey: null };
    expect(seoSettingsPatch(cur, { siteUrl: 'https://a.com', indexNowKey: '' })).toEqual({});
    expect(seoSettingsPatch(cur, { siteUrl: ' https://b.com ', indexNowKey: 'abcdef01' })).toEqual({ siteUrl: 'https://b.com', indexNowKey: 'abcdef01' });
    expect(seoSettingsPatch(cur, { siteUrl: '', indexNowKey: '' })).toEqual({ siteUrl: null });
  });
});
