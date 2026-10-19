import { afterEach, describe, expect, it, vi } from 'vitest';
import { identityFromStaticTheme, theme, siteUrl } from './theme.config';

describe('identityFromStaticTheme (WS-C offline/dev fallback)', () => {
  it('mirrors the build-time theme fields', () => {
    const identity = identityFromStaticTheme();
    expect(identity.storeName).toBe(theme.storeName);
    expect(identity.legalName).toBe(theme.legalName);
    expect(identity.tagline).toBe(theme.tagline);
    expect(identity.supportEmail).toBe(theme.supportEmail);
    expect(identity.colors).toEqual(theme.colors);
    expect(identity.fonts).toEqual(theme.fonts);
    expect(identity.currency).toBe(theme.currency);
    expect(identity.locale).toBe(theme.locale);
    expect(identity.siteOrigin).toBe(siteUrl);
  });

  it('always reports published — a fallback never triggers the private-preview gate', () => {
    expect(identityFromStaticTheme().published).toBe(true);
  });
});


describe('stable category build configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('binds the public stable IDs to labels without reordering labels', async () => {
    vi.stubEnv('VITE_SHOP_CATEGORIES', 'folding knives,fixed blades,edc,fidget,apparel');
    vi.stubEnv('VITE_SHOP_CATEGORY_IDS', '1,3,5,6,4');
    vi.resetModules();
    const configured = await import('./theme.config');
    expect(configured.theme.shopCategories).toEqual(['folding knives', 'fixed blades', 'edc', 'fidget', 'apparel']);
    expect(configured.shopCategoryFilters[4]).toEqual({ id: '4', name: 'apparel' });
    expect(configured.shopCategoryFilters[3]).toEqual({ id: '6', name: 'fidget' });
  });

  it('rejects an explicitly empty stable-ID variable instead of using positional defaults', async () => {
    vi.stubEnv('VITE_SHOP_CATEGORIES', 'First,Second');
    vi.stubEnv('VITE_SHOP_CATEGORY_IDS', '');
    vi.resetModules();
    await expect(import('./theme.config')).rejects.toThrow('Invalid VITE_SHOP_CATEGORY_IDS');
  });
});
