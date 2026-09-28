import { describe, expect, it } from 'vitest';
import {
  resolveAssetPath,
  effectiveVariantPrice,
  normalizeManifestListItem,
  normalizeManifestProductDetail,
  mergeProductStock,
  withUncheckedStock,
  UNCHECKED_STOCK,
} from './catalog';

describe('resolveAssetPath', () => {
  it('prefixes a bare filename with /assets/', () => {
    expect(resolveAssetPath('foo.jpg')).toBe('/assets/foo.jpg');
  });
  it('passes an already-absolute path through unchanged (idempotent)', () => {
    expect(resolveAssetPath('/assets/foo.jpg')).toBe('/assets/foo.jpg');
  });
  it('passes a full URL through unchanged', () => {
    expect(resolveAssetPath('https://cdn.example.com/foo.jpg')).toBe('https://cdn.example.com/foo.jpg');
  });
  it('returns null for null/undefined/empty', () => {
    expect(resolveAssetPath(null)).toBeNull();
    expect(resolveAssetPath(undefined)).toBeNull();
    expect(resolveAssetPath('')).toBeNull();
  });
});

describe('effectiveVariantPrice', () => {
  it('returns the regular price with no sale/pre-order', () => {
    expect(effectiveVariantPrice({ price: 1000, salePrice: null, preOrderPrice: null, isPreOrder: false })).toBe(1000);
  });
  it('returns the sale price when set and not a pre-order', () => {
    expect(effectiveVariantPrice({ price: 1000, salePrice: 800, preOrderPrice: null, isPreOrder: false })).toBe(800);
  });
  it('ignores sale price for a pre-order variant and uses preOrderPrice', () => {
    expect(effectiveVariantPrice({ price: 1000, salePrice: 800, preOrderPrice: 900, isPreOrder: true })).toBe(900);
  });
  it('falls back to regular price when preOrderPrice is unset on a pre-order', () => {
    expect(effectiveVariantPrice({ price: 1000, salePrice: null, preOrderPrice: null, isPreOrder: true })).toBe(1000);
  });
});

describe('normalizeManifestListItem', () => {
  it('maps a fully-populated manifest entry to the native shape', () => {
    const out = normalizeManifestListItem({
      slug: 'edc-knife', name: 'EDC Knife', inStock: true,
      priceRange: { min: 12000, max: 15000 },
      tags: ['Bestseller', 'New'],
      featuredImage: { url: '/assets/edc.jpg' },
      salePrice: 9900, preOrderPrice: null, shipDate: null, isPreOrder: false,
    });
    expect(out).toEqual({
      slug: 'edc-knife', name: 'EDC Knife', status: 'active', inStock: true,
      tags: ['Bestseller', 'New'], minPrice: 12000,
      pricingVariant: { sku: 'edc-knife', price: 12000, salePrice: 9900, preOrderPrice: null, isPreOrder: false, shipDate: null },
      image: '/assets/edc.jpg',
    });
  });

  it('defaults missing optional fields safely (no price, no image, no tags)', () => {
    const out = normalizeManifestListItem({ slug: 'bare', name: 'Bare' });
    expect(out).toEqual({
      slug: 'bare', name: 'Bare', status: 'active', inStock: false,
      tags: [], minPrice: null, pricingVariant: null, image: null,
    });
  });

  it('resolves an already-absolute manifest image path idempotently', () => {
    const out = normalizeManifestListItem({
      slug: 'x', name: 'X', priceRange: { min: 100, max: 100 },
      featuredImage: { url: '/assets/already-resolved.jpg' },
    });
    expect(out.image).toBe('/assets/already-resolved.jpg');
  });
});

describe('normalizeManifestProductDetail', () => {
  const raw = {
    slug: 'p1', name: 'Product One', description: 'desc',
    featuredImage: { url: 'p1-0.jpg' },
    assets: [{ preview: 'p1-0.jpg' }, { preview: 'p1-1.jpg' }],
    tags: ['Sale'],
    variants: [{
      id: 'SKU-1', sku: 'SKU-1', name: 'Default', price: 5000,
      options: [{ code: 'red', name: 'Red', groupId: 'color', group: 'Color' }],
      assets: [{ preview: 'v1.jpg' }],
      salePrice: 4500, preOrderPrice: null, shipDate: null, isPreOrder: false,
    }],
  };

  it('produces a fail-closed stock shell with resolved images', () => {
    const out = normalizeManifestProductDetail(raw);
    expect(out.slug).toBe('p1');
    expect(out.tags).toEqual(['Sale']);
    expect(out.images).toEqual(['/assets/p1-0.jpg', '/assets/p1-0.jpg', '/assets/p1-1.jpg']);
    expect(out.variants).toHaveLength(1);
    const v = out.variants[0];
    expect(v.sku).toBe('SKU-1');
    expect(v.price).toBe(5000); // best-effort: manifest only carries the effective price
    expect(v.salePrice).toBe(4500);
    expect(v.inStock).toBe(false); // LOCKED: never ships true from a shell
    expect(v.availableQuantity).toBe(0);
    expect(v.options[0]).toEqual({ id: 'red', code: 'red', name: 'Red', group: { id: 'color', code: 'color', name: 'Color' } });
  });
});

describe('mergeProductStock', () => {
  const product = normalizeManifestProductDetail({
    slug: 'p1', name: 'P1', description: null, assets: [],
    variants: [
      { id: 'A', sku: 'A', name: 'A', price: 100, options: [], assets: [] },
      { id: 'B', sku: 'B', name: 'B', price: 200, options: [], assets: [] },
    ],
  });

  it('applies live stock by SKU', () => {
    const merged = mergeProductStock(product, {
      variants: [
        { sku: 'A', inStock: true, availableQuantity: 5 },
        { sku: 'B', inStock: false, availableQuantity: 0 },
      ],
    });
    expect(merged.variants.find((v) => v.sku === 'A')).toMatchObject({ inStock: true, availableQuantity: 5 });
    expect(merged.variants.find((v) => v.sku === 'B')).toMatchObject({ inStock: false, availableQuantity: 0 });
  });

  it('fails closed for a SKU the stock response omits', () => {
    const merged = mergeProductStock(product, { variants: [{ sku: 'A', inStock: true, availableQuantity: null }] });
    const b = merged.variants.find((v) => v.sku === 'B')!;
    expect(b.inStock).toBe(false);
    expect(b.availableQuantity).toBe(0);
  });

  it('preserves an explicit null availableQuantity as uncapped', () => {
    const merged = mergeProductStock(product, { variants: [{ sku: 'A', inStock: true, availableQuantity: null }] });
    const a = merged.variants.find((v) => v.sku === 'A')!;
    expect(a.inStock).toBe(true);
    expect(a.availableQuantity).toBeNull();
  });
});

describe('withUncheckedStock / UNCHECKED_STOCK', () => {
  it('forces every variant fail-closed', () => {
    const product = normalizeManifestProductDetail({
      slug: 'p1', name: 'P1', description: null, assets: [],
      variants: [{ id: 'A', sku: 'A', name: 'A', price: 100, options: [], assets: [] }],
    });
    const checked = mergeProductStock(product, { variants: [{ sku: 'A', inStock: true, availableQuantity: 3 }] });
    const reset = withUncheckedStock(checked);
    expect(reset.variants[0]).toMatchObject(UNCHECKED_STOCK);
  });
});
