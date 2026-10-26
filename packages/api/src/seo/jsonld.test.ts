import { describe, expect, it } from 'vitest';
import { seoConfigFromStore } from './config.js';
import { organizationSchema, productSchema, websiteSchema } from './jsonld.js';
import type { ProductAvailability } from './queries.js';

const configured = seoConfigFromStore({
  name: 'Acme',
  config: { seo: { siteUrl: 'https://acme.example.com', contactEmail: 'hi@acme.example.com', organization: { logo: 'https://acme.example.com/logo.png', sameAs: ['https://instagram.com/acme'] } } },
});
const unconfigured = seoConfigFromStore({ name: 'Acme', config: null });

const full = seoConfigFromStore({
  name: 'Acme',
  config: {
    seo: {
      siteUrl: 'https://acme.example.com',
      contactEmail: 'hi@acme.example.com',
      searchPath: '/shop',
      organization: {
        logo: 'https://acme.example.com/logo.png',
        image: 'https://acme.example.com/og.jpg',
        description: 'Acme makes things.',
        telephone: '+15550100',
        founder: { name: 'Pat Acme', id: 'https://acme.example.com/#pat' },
        address: { streetAddress: '1 Main St', addressLocality: 'Reno', addressRegion: 'NV', postalCode: '89501', addressCountry: 'US' },
        sameAs: ['https://instagram.com/acme', 'https://facebook.com/groups/acme'],
      },
      shipping: { rate: '8.00', country: 'us', handlingDays: [1, 3], transitDays: [3, 7] },
      returns: { days: 7, country: 'US', fees: 'customer' },
    },
  },
});

describe('organizationSchema / websiteSchema', () => {
  it('returns null when the store has no siteUrl configured', () => {
    expect(organizationSchema(unconfigured)).toBeNull();
    expect(websiteSchema(unconfigured)).toBeNull();
  });

  it('builds a minimal Organization schema with @id, logo, sameAs and a contactPoint', () => {
    expect(organizationSchema(configured)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      '@id': 'https://acme.example.com/#organization',
      name: 'Acme',
      url: 'https://acme.example.com',
      logo: 'https://acme.example.com/logo.png',
      contactPoint: { '@type': 'ContactPoint', email: 'hi@acme.example.com', contactType: 'customer service' },
      sameAs: ['https://instagram.com/acme'],
    });
  });

  it('adds description, image, address, telephone, founder and every sameAs from store config', () => {
    expect(organizationSchema(full)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      '@id': 'https://acme.example.com/#organization',
      name: 'Acme',
      url: 'https://acme.example.com',
      logo: 'https://acme.example.com/logo.png',
      image: 'https://acme.example.com/og.jpg',
      description: 'Acme makes things.',
      founder: { '@type': 'Person', '@id': 'https://acme.example.com/#pat', name: 'Pat Acme' },
      contactPoint: { '@type': 'ContactPoint', telephone: '+15550100', email: 'hi@acme.example.com', contactType: 'customer service' },
      address: { '@type': 'PostalAddress', streetAddress: '1 Main St', addressLocality: 'Reno', addressRegion: 'NV', postalCode: '89501', addressCountry: 'US' },
      sameAs: ['https://instagram.com/acme', 'https://facebook.com/groups/acme'],
    });
  });

  it('builds a WebSite schema without a SearchAction unless the store has a search page', () => {
    expect(websiteSchema(configured)).toEqual({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'Acme', url: 'https://acme.example.com' });
  });

  it('adds the SearchAction for the configured search path', () => {
    expect(websiteSchema(full)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'Acme',
      url: 'https://acme.example.com',
      potentialAction: { '@type': 'SearchAction', target: 'https://acme.example.com/shop?q={search_term_string}', 'query-input': 'required name=search_term_string' },
    });
  });
});

const product: ProductAvailability = {
  slug: 'widget', name: 'Widget', description: 'A fine widget', images: ['img/widget.webp'],
  currency: 'USD', price: 1999, sku: 'WIDGET-1', inStock: true, preOrder: false, updatedAt: '2026-01-01T00:00:00.000Z',
};
const NOW = new Date('2026-10-27T12:00:00.000Z');

describe('productSchema', () => {
  it('returns null without a configured siteUrl', () => {
    expect(productSchema(unconfigured, product)).toBeNull();
  });

  it('renders price as a 2-decimal string, brand, seller, condition and validity; no policy blocks without store config', () => {
    const schema = productSchema(configured, product, NOW);
    expect(schema).toMatchObject({
      '@type': 'Product',
      name: 'Widget',
      url: 'https://acme.example.com/products/widget/',
      sku: 'WIDGET-1',
      brand: { '@type': 'Brand', name: 'Acme' },
      itemCondition: 'https://schema.org/NewCondition',
      image: ['https://acme.example.com/assets/img/widget.webp?preset=xl'],
    });
    expect(schema!.offers).toEqual({
      '@type': 'Offer',
      url: 'https://acme.example.com/products/widget/',
      priceCurrency: 'USD',
      price: '19.99',
      priceValidUntil: '2027-10-27',
      availability: 'https://schema.org/InStock',
      itemCondition: 'https://schema.org/NewCondition',
      seller: { '@type': 'Organization', name: 'Acme' },
    });
  });

  it('takes shippingDetails and hasMerchantReturnPolicy from store config, in the store currency', () => {
    const offers = productSchema(full, { ...product, currency: 'EUR' }, NOW)!.offers as Record<string, unknown>;
    expect(offers.shippingDetails).toEqual([{
      '@type': 'OfferShippingDetails',
      shippingRate: { '@type': 'MonetaryAmount', value: '8.00', currency: 'EUR' },
      shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'US' },
      deliveryTime: {
        '@type': 'ShippingDeliveryTime',
        handlingTime: { '@type': 'QuantitativeValue', minValue: 1, maxValue: 3, unitCode: 'DAY' },
        transitTime: { '@type': 'QuantitativeValue', minValue: 3, maxValue: 7, unitCode: 'DAY' },
      },
    }]);
    expect(offers.hasMerchantReturnPolicy).toEqual({
      '@type': 'MerchantReturnPolicy',
      applicableCountry: 'US',
      returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
      merchantReturnDays: 7,
      returnMethod: 'https://schema.org/ReturnByMail',
      returnFees: 'https://schema.org/ReturnShippingFees',
    });
  });

  it('two stores get their own policies: free shipping and a 30-day free return', () => {
    const rotten = seoConfigFromStore({
      name: 'Rotten',
      config: { seo: { siteUrl: 'https://rotten.example.com', shipping: { rate: 0, country: 'US', handlingDays: [1, 2], transitDays: [5, 7] }, returns: { days: 30, country: 'US', fees: 'free' } } },
    });
    const offers = productSchema(rotten, product, NOW)!.offers as Record<string, any>;
    expect(offers.shippingDetails[0].shippingRate.value).toBe('0.00');
    expect(offers.shippingDetails[0].deliveryTime.transitTime.minValue).toBe(5);
    expect(offers.hasMerchantReturnPolicy.merchantReturnDays).toBe(30);
    expect(offers.hasMerchantReturnPolicy.returnFees).toBe('https://schema.org/FreeReturn');
    expect(offers.seller.name).toBe('Rotten');
  });

  it('ignores a malformed shipping or returns block rather than emitting a broken one', () => {
    const bad = seoConfigFromStore({
      name: 'Acme',
      config: { seo: { siteUrl: 'https://acme.example.com', shipping: { rate: 'free', country: 'US' }, returns: { days: 0, country: 'US' } } },
    });
    const offers = productSchema(bad, product, NOW)!.offers as Record<string, unknown>;
    expect(offers).not.toHaveProperty('shippingDetails');
    expect(offers).not.toHaveProperty('hasMerchantReturnPolicy');
  });

  it('reports PreOrder for an in-stock product with a pre-order variant, OutOfStock when nothing is available', () => {
    const avail = (p: Partial<ProductAvailability>) => (productSchema(configured, { ...product, ...p }, NOW)!.offers as { availability: string }).availability;
    expect(avail({ preOrder: true })).toBe('https://schema.org/PreOrder');
    expect(avail({ inStock: false })).toBe('https://schema.org/OutOfStock');
    expect(avail({ inStock: false, preOrder: true })).toBe('https://schema.org/OutOfStock');
  });

  it('omits offers when no priced variant exists', () => {
    const noPrice = productSchema(configured, { ...product, price: null }, NOW);
    expect(noPrice!.offers).toBeUndefined();
  });

  it('describes the product in plain text and parses material/additionalProperty from the SPECS block', () => {
    const description = '<p>The Oni is a &quot;small&quot; knife.</p><p>SPECS</p><p>Blade Material: Sandvik 14c28n.<br>Handle Material: G10<br>Reversible Deep carry pocket Clip</p>';
    const schema = productSchema(configured, { ...product, description }, NOW)!;
    expect(schema.description).toBe('The Oni is a "small" knife. SPECS Blade Material: Sandvik 14c28n. Handle Material: G10 Reversible Deep carry pocket Clip');
    expect(String(schema.description)).not.toMatch(/[<>]/);
    expect(schema.material).toBe('Sandvik 14c28n');
    expect(schema.additionalProperty).toEqual([
      { '@type': 'PropertyValue', name: 'Blade Material', value: 'Sandvik 14c28n' },
      { '@type': 'PropertyValue', name: 'Handle Material', value: 'G10' },
    ]);
  });

  it('has no material or additionalProperty without a SPECS block', () => {
    const schema = productSchema(configured, product, NOW)!;
    expect(schema).not.toHaveProperty('material');
    expect(schema).not.toHaveProperty('additionalProperty');
  });

  it('leaves absolute image URLs alone and does not double the preset', () => {
    const schema = productSchema(configured, { ...product, images: ['https://cdn.example.com/a.png', '/assets/x/y.png?preset=xl'] }, NOW)!;
    expect(schema.image).toEqual(['https://cdn.example.com/a.png', 'https://acme.example.com/assets/x/y.png?preset=xl']);
  });
});
