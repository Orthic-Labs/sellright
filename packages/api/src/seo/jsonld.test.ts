import { describe, expect, it } from 'vitest';
import { seoConfigFromStore } from './config.js';
import { organizationSchema, productSchema, websiteSchema } from './jsonld.js';
import type { ProductAvailability } from './queries.js';

const configured = seoConfigFromStore({
  name: 'Acme',
  config: { seo: { siteUrl: 'https://acme.example.com', contactEmail: 'hi@acme.example.com', organization: { logo: 'https://acme.example.com/logo.png', sameAs: ['https://instagram.com/acme'] } } },
});
const unconfigured = seoConfigFromStore({ name: 'Acme', config: null });

describe('organizationSchema / websiteSchema', () => {
  it('returns null when the store has no siteUrl configured', () => {
    expect(organizationSchema(unconfigured)).toBeNull();
    expect(websiteSchema(unconfigured)).toBeNull();
  });

  it('builds an Organization schema with logo, sameAs and email', () => {
    expect(organizationSchema(configured)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'Acme',
      url: 'https://acme.example.com',
      logo: 'https://acme.example.com/logo.png',
      sameAs: ['https://instagram.com/acme'],
      email: 'hi@acme.example.com',
    });
  });

  it('builds a minimal WebSite schema', () => {
    expect(websiteSchema(configured)).toEqual({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'Acme', url: 'https://acme.example.com' });
  });
});

const product: ProductAvailability = {
  slug: 'widget', name: 'Widget', description: 'A fine widget', images: ['img/widget.webp'],
  currency: 'USD', price: 1999, sku: 'WIDGET-1', inStock: true, updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('productSchema', () => {
  it('returns null without a configured siteUrl', () => {
    expect(productSchema(unconfigured, product)).toBeNull();
  });

  it('renders price as a 2-decimal string and InStock availability', () => {
    const schema = productSchema(configured, product);
    expect(schema).toMatchObject({
      '@type': 'Product',
      name: 'Widget',
      url: 'https://acme.example.com/products/widget/',
      sku: 'WIDGET-1',
      image: ['img/widget.webp'],
    });
    expect(schema!.offers).toEqual({
      '@type': 'Offer', url: 'https://acme.example.com/products/widget/', priceCurrency: 'USD', price: '19.99', availability: 'https://schema.org/InStock',
    });
  });

  it('flips to OutOfStock and omits offers.price when no priced variant exists', () => {
    const outOfStock = productSchema(configured, { ...product, inStock: false });
    expect((outOfStock!.offers as { availability: string }).availability).toBe('https://schema.org/OutOfStock');

    const noPrice = productSchema(configured, { ...product, price: null });
    expect(noPrice!.offers).toBeUndefined();
  });
});
