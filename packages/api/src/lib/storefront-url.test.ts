import { describe, expect, it } from 'vitest';
import { normalizeStorefrontUrl } from './storefront-url.js';

describe('normalizeStorefrontUrl', () => {
  it('accepts https and strips the trailing slash, path prefix kept', () => {
    expect(normalizeStorefrontUrl('https://shop.example.com/')).toBe('https://shop.example.com');
    expect(normalizeStorefrontUrl(' https://shop.example.com/store/ ')).toBe('https://shop.example.com/store');
  });
  it('allows plain http only on loopback hosts', () => {
    expect(normalizeStorefrontUrl('http://127.0.0.1:4398')).toBe('http://127.0.0.1:4398');
    expect(normalizeStorefrontUrl('http://localhost:4300/')).toBe('http://localhost:4300');
    expect(normalizeStorefrontUrl('http://shop.example.com')).toBeNull();
  });
  it('rejects junk, other schemes, credentials, query and fragments', () => {
    for (const bad of ['', 'shop.example.com', 'ftp://shop.example.com', 'javascript:alert(1)', 'https://u:p@shop.example.com', 'https://shop.example.com/?a=1', 'https://shop.example.com/#x']) {
      expect(normalizeStorefrontUrl(bad), bad).toBeNull();
    }
  });
});
