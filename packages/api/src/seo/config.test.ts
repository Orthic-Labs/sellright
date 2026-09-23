import { describe, expect, it } from 'vitest';
import { DEFAULT_ROBOTS_DISALLOW, DEFAULT_STATIC_PATHS, seoConfigFromStore } from './config.js';

describe('seoConfigFromStore', () => {
  it('returns safe defaults when config.seo is entirely absent', () => {
    const config = seoConfigFromStore({ name: 'Acme', config: null });
    expect(config).toMatchObject({
      siteUrl: null,
      contactEmail: null,
      organization: { name: 'Acme', logo: null, sameAs: [] },
      robotsDisallow: [...DEFAULT_ROBOTS_DISALLOW],
      staticPaths: [...DEFAULT_STATIC_PATHS],
      indexNowKey: null,
    });
  });

  it('reads seo.siteUrl, normalizes to origin (drops path/query/hash)', () => {
    const config = seoConfigFromStore({ name: 'Acme', config: { seo: { siteUrl: 'https://example.com/some/path?x=1#y' } } });
    expect(config.siteUrl).toBe('https://example.com');
  });

  it('falls back to store.config.storefrontUrl (the existing feeds/email field) when seo.siteUrl is unset', () => {
    const config = seoConfigFromStore({ name: 'Acme', config: { storefrontUrl: 'https://shop.example.com/' } });
    expect(config.siteUrl).toBe('https://shop.example.com');
  });

  it('seo.siteUrl overrides storefrontUrl when both are present', () => {
    const config = seoConfigFromStore({ name: 'Acme', config: { storefrontUrl: 'https://old.example.com', seo: { siteUrl: 'https://new.example.com' } } });
    expect(config.siteUrl).toBe('https://new.example.com');
  });

  it('rejects a non-http(s) or malformed siteUrl rather than throwing', () => {
    expect(seoConfigFromStore({ name: 'Acme', config: { seo: { siteUrl: 'ftp://example.com' } } }).siteUrl).toBeNull();
    expect(seoConfigFromStore({ name: 'Acme', config: { seo: { siteUrl: 'not a url' } } }).siteUrl).toBeNull();
    expect(seoConfigFromStore({ name: 'Acme', config: { seo: { siteUrl: 42 } } }).siteUrl).toBeNull();
  });

  it('organization.name falls back to the store name; other org fields default empty', () => {
    const config = seoConfigFromStore({ name: 'Acme', config: { seo: { organization: { logo: 'https://example.com/logo.png' } } } });
    expect(config.organization).toEqual({ name: 'Acme', logo: 'https://example.com/logo.png', sameAs: [] });
  });

  it('accepts a custom robotsDisallow list, ignoring empty/non-string entries', () => {
    const config = seoConfigFromStore({ name: 'Acme', config: { seo: { robotsDisallow: ['custom-path', '', 42, 'another'] } } });
    expect(config.robotsDisallow).toEqual(['custom-path', 'another']);
  });

  it('an empty robotsDisallow array falls back to the default list (not an empty robots.txt)', () => {
    const config = seoConfigFromStore({ name: 'Acme', config: { seo: { robotsDisallow: [] } } });
    expect(config.robotsDisallow).toEqual([...DEFAULT_ROBOTS_DISALLOW]);
  });

  it('validates the IndexNow key shape (hex, 8-128 chars) and lowercases it', () => {
    const valid = seoConfigFromStore({ name: 'Acme', config: { seo: { indexNow: { key: 'ABCDEF0123456789' } } } });
    expect(valid.indexNowKey).toBe('abcdef0123456789');

    const tooShort = seoConfigFromStore({ name: 'Acme', config: { seo: { indexNow: { key: 'ab12' } } } });
    expect(tooShort.indexNowKey).toBeNull();

    const notHex = seoConfigFromStore({ name: 'Acme', config: { seo: { indexNow: { key: 'not-hex-at-all!!' } } } });
    expect(notHex.indexNowKey).toBeNull();
  });
});
