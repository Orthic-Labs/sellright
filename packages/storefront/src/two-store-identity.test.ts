import { describe, expect, it } from 'vitest';
import type { SrStoreIdentity } from '~/utils/sellright';
import { footerViewModel } from '~/components/footer/footer-view-model';

/**
 * WS-C follow-up: proves that the runtime store identity actually drives
 * user-visible output — the footer — rather than being
 * threaded through and silently ignored. Two distinct identities (as two
 * different stores' /v1/shop/identity responses would resolve to) must
 * produce two distinct results everywhere identity-derived copy appears. (JSON-LD is built by the API from each store's own SEO
 * config: see api/src/seo/jsonld.test.ts.)
 */
function makeIdentity(overrides: Partial<SrStoreIdentity>): SrStoreIdentity {
  return {
    storeName: 'Storefront Demo',
    legalName: 'Storefront Demo',
    tagline: 'Quality products, delivered.',
    supportEmail: 'support@example.com',
    logoText: 'Storefront Demo',
    logoImageUrl: null,
    ogImageUrl: '/og-image.jpg',
    address: null,
    social: {},
    colors: {
      primary: '#18181b', secondary: '#3f3f46', accent: '#2563eb',
      background: '#ffffff', surface: '#f4f4f5', text: '#18181b',
      textMuted: '#71717a', border: '#e4e4e7',
    },
    fonts: { display: 'Inter', body: 'Inter', mono: 'monospace' },
    currency: 'USD',
    locale: 'en',
    siteOrigin: 'https://example.com',
    published: true,
    policies: {
      shipping: { label: 'Flat-Rate', sub: 'Shipping' },
      returns: { label: '1 Week', sub: 'Defect Returns' },
      payment: { label: 'Secure', sub: 'Checkout' },
    },
    ...overrides,
  };
}

const storeA = makeIdentity({
  storeName: 'Acme Knives',
  legalName: 'Acme Knives LLC',
  tagline: 'Sharp things, honestly made.',
  supportEmail: 'help@acmeknives.test',
  logoImageUrl: '/acme-logo.svg',
  ogImageUrl: '/acme-og.jpg',
  address: { streetAddress: '1 Main St', addressLocality: 'Reno', addressRegion: 'NV', postalCode: '89501', addressCountry: 'US' },
  social: { instagram: 'https://instagram.com/acmeknives', facebook: 'https://facebook.com/acmeknives' },
  siteOrigin: 'https://acmeknives.test',
  policies: {
    shipping: { label: 'Free', sub: 'Over $75' },
    returns: { label: '30 Day', sub: 'Returns' },
    payment: { label: 'Secure', sub: 'Checkout' },
  },
});

const storeB = makeIdentity({
  storeName: 'Bloom & Co',
  legalName: 'Bloom & Co Trading Ltd',
  tagline: 'Flowers for every season.',
  supportEmail: 'hello@bloomandco.test',
  logoImageUrl: '/bloom-logo.svg',
  ogImageUrl: '/bloom-og.jpg',
  address: { streetAddress: '2 Garden Ave', addressLocality: 'Austin', addressRegion: 'TX', postalCode: '78701', addressCountry: 'US' },
  social: { twitter: 'https://twitter.com/bloomandco' },
  siteOrigin: 'https://bloomandco.test',
  policies: {
    shipping: { label: 'Flat-Rate', sub: 'Nationwide' },
    returns: { label: '14 Day', sub: 'Money Back' },
    payment: { label: 'Secure', sub: 'Checkout' },
  },
});

describe('two stores with different identities render different output', () => {
  it('footer: copyright and social links differ per store', () => {
    const a = footerViewModel(storeA, 2026);
    const b = footerViewModel(storeB, 2026);

    expect(a.copyright).toBe('© 2026 Acme Knives LLC. All rights reserved.');
    expect(b.copyright).toBe('© 2026 Bloom & Co Trading Ltd. All rights reserved.');
    expect(a.copyright).not.toBe(b.copyright);

    expect(a.social.instagram).toEqual({ href: 'https://instagram.com/acmeknives', ariaLabel: 'Acme Knives on Instagram' });
    expect(a.social.twitter).toBeNull();
    expect(b.social.instagram).toBeNull();
    expect(b.social.twitter).toEqual({ href: 'https://twitter.com/bloomandco', ariaLabel: 'Bloom & Co on Twitter' });
  });
});
