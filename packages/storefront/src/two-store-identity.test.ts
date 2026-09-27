import { describe, expect, it } from 'vitest';
import type { SrStoreIdentity } from '~/utils/sellright';
import { footerViewModel } from '~/components/footer/footer-view-model';
import {
  generateOrganizationSchema,
  generateWebsiteSchema,
  generateProductSchema,
} from '~/services/seo-schemas';

/**
 * WS-C follow-up: proves that the runtime store identity actually drives
 * user-visible output — the footer and JSON-LD schemas — rather than being
 * threaded through and silently ignored. Two distinct identities (as two
 * different stores' /v1/shop/identity responses would resolve to) must
 * produce two distinct results everywhere identity-derived copy appears.
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

  it('JSON-LD Organization schema differs per store', () => {
    const a = generateOrganizationSchema(storeA);
    const b = generateOrganizationSchema(storeB);

    expect(a.name).toBe('Acme Knives');
    expect(b.name).toBe('Bloom & Co');
    expect(a.name).not.toBe(b.name);

    expect(a.url).toBe('https://acmeknives.test');
    expect(b.url).toBe('https://bloomandco.test');

    expect(a.description).toBe('Sharp things, honestly made.');
    expect(b.description).toBe('Flowers for every season.');

    expect((a.contactPoint as any).email).toBe('help@acmeknives.test');
    expect((b.contactPoint as any).email).toBe('hello@bloomandco.test');

    expect((a as any).sameAs).toEqual(['https://instagram.com/acmeknives', 'https://facebook.com/acmeknives']);
    expect((b as any).sameAs).toEqual(['https://twitter.com/bloomandco']);

    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('JSON-LD WebSite schema differs per store', () => {
    const a = generateWebsiteSchema(storeA);
    const b = generateWebsiteSchema(storeB);

    expect(a.name).toBe('Acme Knives');
    expect(b.name).toBe('Bloom & Co');
    expect((a.potentialAction as any).target).toBe('https://acmeknives.test/shop?q={search_term_string}');
    expect((b.potentialAction as any).target).toBe('https://bloomandco.test/shop?q={search_term_string}');
  });

  it('JSON-LD Product schema (seller/brand/currency) differs per store', () => {
    const product = {
      name: 'Field Knife',
      slug: 'field-knife',
      id: 'prod_1',
      description: 'A sturdy field knife.',
      variants: [{ sku: 'FK-1', priceWithTax: 4999, currencyCode: null, stockLevel: 'IN_STOCK' }],
      featuredAsset: null,
      assets: [],
    };
    const a = generateProductSchema(product, storeA)!;
    const b = generateProductSchema(product, storeB)!;

    expect(a.brand).toEqual({ '@type': 'Brand', name: 'Acme Knives' });
    expect(b.brand).toEqual({ '@type': 'Brand', name: 'Bloom & Co' });
    expect((a.offers as any).seller).toEqual({ '@type': 'Organization', name: 'Acme Knives' });
    expect((b.offers as any).seller).toEqual({ '@type': 'Organization', name: 'Bloom & Co' });
    expect(a.url).toBe('https://acmeknives.test/products/field-knife');
    expect(b.url).toBe('https://bloomandco.test/products/field-knife');
  });
});
