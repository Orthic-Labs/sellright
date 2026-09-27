import { describe, expect, it } from 'vitest';
import { normalizeIdentity } from './normalize-identity';
import type { SrStoreIdentity } from './sellright';

describe('normalizeIdentity (defense-in-depth against API/storefront version skew)', () => {
  it('fills a missing top-level field (e.g. an older API without `policies`) from the static fallback', () => {
    const partial = { storeName: 'Acme' } as unknown as SrStoreIdentity;
    const result = normalizeIdentity(partial);
    expect(result.storeName).toBe('Acme');
    expect(result.policies.shipping).toEqual({ label: 'Flat-Rate', sub: 'Shipping' });
    expect(result.policies.returns.label).toBe('1 Week');
    expect(result.colors.primary).toBe('#18181b');
    expect(result.fonts.body).toBe('Inter, system-ui, sans-serif');
    expect(result.social).toEqual({});
  });

  it('fills a missing nested sub-field without discarding sibling fields the response DID provide', () => {
    const partial = {
      storeName: 'Acme',
      policies: { shipping: { label: 'Free' } },
      social: { instagram: 'https://instagram.com/acme' },
    } as unknown as SrStoreIdentity;
    const result = normalizeIdentity(partial);
    expect(result.policies.shipping).toEqual({ label: 'Free', sub: 'Shipping' });
    expect(result.policies.returns).toEqual({ label: '1 Week', sub: 'Defect Returns' });
    expect(result.social.instagram).toBe('https://instagram.com/acme');
  });

  it('never overrides a fully-populated fetched identity with fallback values', () => {
    const full: SrStoreIdentity = {
      storeName: 'Acme', legalName: 'Acme LLC', tagline: 'Sharp.', supportEmail: 'a@a.test',
      logoText: 'Acme', logoImageUrl: '/logo.svg', ogImageUrl: '/og.jpg',
      address: { streetAddress: '1 St', addressLocality: 'X', addressRegion: 'Y', postalCode: '1', addressCountry: 'US' },
      social: { instagram: 'https://instagram.com/acme' },
      colors: { primary: '#000', secondary: '#111', accent: '#222', background: '#fff', surface: '#eee', text: '#000', textMuted: '#555', border: '#ccc' },
      fonts: { display: 'A', body: 'B', mono: 'C' },
      currency: 'EUR', locale: 'fr', siteOrigin: 'https://acme.test', published: true,
      policies: { shipping: { label: 'S', sub: 's' }, returns: { label: 'R', sub: 'r' }, payment: { label: 'P', sub: 'p' } },
    };
    expect(normalizeIdentity(full)).toEqual(full);
  });
});
