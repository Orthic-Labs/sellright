import { describe, expect, it } from 'vitest';
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
