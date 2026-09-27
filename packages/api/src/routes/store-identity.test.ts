import { describe, expect, it } from 'vitest';
import { storeIdentityFromConfig } from './store-identity.js';

describe('storeIdentityFromConfig', () => {
  it('falls back to neutral defaults + store name/currency when config.identity is absent', () => {
    const identity = storeIdentityFromConfig({ name: 'Acme', currency: 'USD', config: null }, true);
    expect(identity.storeName).toBe('Acme');
    expect(identity.legalName).toBe('Acme');
    expect(identity.logoText).toBe('Acme');
    expect(identity.currency).toBe('USD');
    expect(identity.tagline).toBe('Quality products, delivered.');
    expect(identity.address).toBeNull();
    expect(identity.colors.primary).toBe('#18181b');
    expect(identity.published).toBe(true);
  });

  it('reflects an explicit false published flag', () => {
    const identity = storeIdentityFromConfig({ name: 'Acme', currency: 'USD', config: {} }, false);
    expect(identity.published).toBe(false);
  });

  it('overrides fields from config.identity when set', () => {
    const identity = storeIdentityFromConfig({
      name: 'Acme',
      currency: 'USD',
      config: {
        identity: {
          storeName: 'Acme Knives',
          tagline: 'Sharp things.',
          supportEmail: 'help@acme.test',
          social: { instagram: 'https://instagram.com/acme' },
          colors: { primary: '#000000' },
          address: { streetAddress: '1 Main St', addressLocality: 'NYC', addressRegion: 'NY', postalCode: '10001', addressCountry: 'US' },
          siteOrigin: 'https://acme.test',
        },
      },
    }, true);
    expect(identity.storeName).toBe('Acme Knives');
    expect(identity.legalName).toBe('Acme Knives');
    expect(identity.tagline).toBe('Sharp things.');
    expect(identity.supportEmail).toBe('help@acme.test');
    expect(identity.social.instagram).toBe('https://instagram.com/acme');
    expect(identity.colors.primary).toBe('#000000');
    expect(identity.colors.secondary).toBe('#3f3f46'); // untouched field keeps default
    expect(identity.address?.addressLocality).toBe('NYC');
    expect(identity.siteOrigin).toBe('https://acme.test');
  });

  it('defaults policies and overrides only the given sub-fields', () => {
    const withDefault = storeIdentityFromConfig({ name: 'Acme', currency: 'USD', config: null }, true);
    expect(withDefault.policies).toEqual({
      shipping: { label: 'Flat-Rate', sub: 'Shipping' },
      returns: { label: '1 Week', sub: 'Defect Returns' },
      payment: { label: 'Secure', sub: 'Checkout' },
    });
    const withOverride = storeIdentityFromConfig({
      name: 'Acme',
      currency: 'USD',
      config: { identity: { policies: { shipping: { label: 'Free' } } } },
    }, true);
    expect(withOverride.policies.shipping).toEqual({ label: 'Free', sub: 'Shipping' });
    expect(withOverride.policies.returns).toEqual({ label: '1 Week', sub: 'Defect Returns' });
  });

  it('ignores non-string/malformed identity fields rather than throwing', () => {
    const identity = storeIdentityFromConfig({
      name: 'Acme',
      currency: 'USD',
      config: { identity: { storeName: 123, colors: 'nope', social: null } },
    }, true);
    expect(identity.storeName).toBe('Acme');
    expect(identity.colors.primary).toBe('#18181b');
    expect(identity.social.instagram).toBeUndefined();
  });
});
