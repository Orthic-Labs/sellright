/**
 * PAR-02 feed unit tests — pure (no DB). Covers CSV escaping, field layout for
 * all three channels, price/availability rules, and config defaults.
 */
import { describe, expect, it } from 'vitest';
import {
  availabilityOf, csvCell, effectivePrice, feedConfigFromStore, generateFeed,
  toFeedItem,
  FACEBOOK_FIELDS, GOOGLE_FIELDS, PINTEREST_FIELDS,
  type FeedConfig, type FeedRow,
} from './feed.js';

/** Minimal RFC-4180 line parser for assertions (the real escape lives in csvCell). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const CFG: FeedConfig = {
  storefrontUrl: 'https://shop.example.com',
  currency: 'USD',
  brand: 'TestBrand',
  priceRule: 'preorder',
  productUrlPattern: '/products/{slug}',
  assetBaseUrl: 'https://cdn.example.com',
  googleProductCategory: 'Apparel > T-Shirts',
  productType: 'DefaultType',
  fbProductCategory: 'fb:apparel',
  ageGroup: 'adult',
  gender: 'unisex',
  material: '',
  pattern: '',
  sizeSystem: 'US',
  sizeType: 'regular',
  shippingWeight: '0.2 kg',
  style: 'streetwear',
  customLabels: ['l0', 'l1', 'l2', 'l3', 'l4'],
};

const ROW: FeedRow = {
  variantId: 'var-1', sku: 'TEE-BLK-M', variantName: 'Black / M',
  price: 2500, salePrice: null, compareAtPrice: null,
  isPreOrder: false, preOrderPrice: null,
  fulfillmentType: 'physical', barcode: '012345678905', weightG: 200,
  productId: 'prod-1', productSlug: 'logo-tee', productName: 'Logo Tee',
  productDescription: 'A tee, with a logo.', vendor: null, productType: 'Shirts',
  imagePath: 'assets/tee.png', additionalImagePath: null,
  stockAvailable: 7, options: { color: 'Black', size: 'M' },
};

describe('csvCell', () => {
  it('escapes commas, quotes, CR/LF and tabs', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2\ttab')).toBe('line1 line2 tab');
    expect(csvCell('a\rb')).toBe('a b');
    expect(csvCell(null)).toBe('');
    expect(csvCell('')).toBe('');
  });
});

describe('effectivePrice / availabilityOf', () => {
  it('preorder price wins over sale/base', () => {
    expect(effectivePrice({ price: 1000, salePrice: 800, isPreOrder: true, preOrderPrice: 900 })).toBe(900);
    expect(effectivePrice({ price: 1000, salePrice: 800, isPreOrder: false, preOrderPrice: null })).toBe(800);
    expect(effectivePrice({ price: 1000, salePrice: null, isPreOrder: false, preOrderPrice: null })).toBe(1000);
  });
  it('availability: preorder > digital always-in-stock > physical stock', () => {
    expect(availabilityOf({ fulfillmentType: 'physical', isPreOrder: true, stockAvailable: 0 })).toBe('preorder');
    expect(availabilityOf({ fulfillmentType: 'digital_download', isPreOrder: false, stockAvailable: 0 })).toBe('in stock');
    expect(availabilityOf({ fulfillmentType: 'license', isPreOrder: false, stockAvailable: null })).toBe('in stock');
    expect(availabilityOf({ fulfillmentType: 'physical', isPreOrder: false, stockAvailable: 3 })).toBe('in stock');
    expect(availabilityOf({ fulfillmentType: 'physical', isPreOrder: false, stockAvailable: 0 })).toBe('out of stock');
    expect(availabilityOf({ fulfillmentType: 'physical', isPreOrder: false, stockAvailable: null })).toBe('out of stock');
  });
});

describe('toFeedItem', () => {
  it('shapes a full row: stable id, urls, price, availability, catalog fields', () => {
    const i = toFeedItem(ROW, CFG);
    expect(i.id).toBe('TEE-BLK-M');            // stable: sku, not a uuid
    expect(i.title).toBe('Logo Tee - Black / M');
    expect(i.link).toBe('https://shop.example.com/products/logo-tee');
    expect(i.imageLink).toBe('https://cdn.example.com/assets/tee.png');
    expect(i.price).toBe('25.00 USD');
    expect(i.availability).toBe('in stock');
    expect(i.condition).toBe('new');
    expect(i.brand).toBe('TestBrand');          // vendor unset → configured brand
    expect(i.itemGroupId).toBe('prod-1');
    expect(i.color).toBe('Black');
    expect(i.size).toBe('M');
    expect(i.gtin).toBe('012345678905');
    expect(i.mpn).toBe('TEE-BLK-M');
    expect(i.identifierExists).toBe('TRUE');
    expect(i.productType).toBe('Shirts');
  });
  it('vendor wins over configured brand; sku-less variant falls back to id', () => {
    const i = toFeedItem({ ...ROW, vendor: 'Acme', sku: '', barcode: null }, CFG);
    expect(i.brand).toBe('Acme');
    expect(i.id).toBe('var-1');
    expect(i.identifierExists).toBe('FALSE');
  });
  it('absolute image urls pass through; relative paths join the asset base', () => {
    expect(toFeedItem({ ...ROW, imagePath: 'https://other.cdn/x.png' }, CFG).imageLink).toBe('https://other.cdn/x.png');
    expect(toFeedItem({ ...ROW, imagePath: '/abs/x.png' }, CFG).imageLink).toBe('https://cdn.example.com/abs/x.png');
    expect(toFeedItem({ ...ROW, imagePath: null }, CFG).imageLink).toBe('');
  });
  it('sale price only populated for a genuine markdown', () => {
    expect(toFeedItem({ ...ROW, salePrice: 2000 }, CFG).salePrice).toBe('20.00 USD');
    expect(toFeedItem({ ...ROW, salePrice: 3000 }, CFG).salePrice).toBe(''); // above base = not a sale
  });
  it('slug is url-encoded in the product link', () => {
    const i = toFeedItem({ ...ROW, productSlug: 'tee & co' }, CFG);
    expect(i.link).toBe('https://shop.example.com/products/tee%20%26%20co');
  });
});

describe('generateFeed', () => {
  const items = [toFeedItem(ROW, CFG), toFeedItem({ ...ROW, variantId: 'var-2', sku: 'TEE-BLK,L', variantName: 'Black, "Large"', salePrice: 2000 }, CFG)];

  it('google: header fields + one CSV row per variant, correct column order', () => {
    const csv = generateFeed('google', items, CFG);
    const lines = csv.split('\n');
    expect(lines[0]).toBe(GOOGLE_FIELDS.join(','));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('TEE-BLK-M');
    expect(lines[1]).toContain('25.00 USD');
    expect(lines[1]).toContain('in stock');
    // item_group_id column carries the product id — parse the row honoring
    // quoted cells (the description contains a comma).
    const cells = parseCsvLine(lines[1]!);
    expect(cells[GOOGLE_FIELDS.indexOf('item_group_id')]).toBe('prod-1');
    expect(cells[GOOGLE_FIELDS.indexOf('description')]).toBe('A tee, with a logo.');
  });

  it('facebook + pinterest headers and escaping (comma/quote in title are quoted)', () => {
    const fb = generateFeed('facebook', items, CFG).split('\n');
    expect(fb[0]).toBe(FACEBOOK_FIELDS.join(','));
    expect(fb[2]).toContain('"Logo Tee - Black, ""Large"""'); // escaped title cell
    expect(parseCsvLine(fb[2]!)[FACEBOOK_FIELDS.indexOf('title')]).toBe('Logo Tee - Black, "Large"');
    expect(parseCsvLine(fb[2]!)[FACEBOOK_FIELDS.indexOf('sale_price')]).toBe('20.00 USD');

    const pin = generateFeed('pinterest', items, CFG).split('\n');
    expect(pin[0]).toBe(PINTEREST_FIELDS.join(','));
    expect(pin[1]).toContain('l0');
  });

  it('empty catalog produces header-only CSV', () => {
    expect(generateFeed('google', [], CFG)).toBe(GOOGLE_FIELDS.join(','));
  });
});

describe('feedConfigFromStore', () => {
  it('defaults: brand=store name, currency uppercased, env storefront fallback', () => {
    const cfg = feedConfigFromStore({ name: 'My Store', currency: 'eur', config: null }, 'https://env.example.com');
    expect(cfg.brand).toBe('My Store');
    expect(cfg.currency).toBe('EUR');
    expect(cfg.storefrontUrl).toBe('https://env.example.com');
    expect(cfg.assetBaseUrl).toBe('https://env.example.com');
    expect(cfg.productUrlPattern).toBe('/products/{slug}');
  });
  it('store config overrides win; customLabels pad to five', () => {
    const cfg = feedConfigFromStore({
      name: 'S', currency: 'usd',
      config: { storefrontUrl: 'https://s.example.com/', feeds: { brand: 'B', customLabels: ['a'], productUrlPattern: '/p/{slug}' } },
    }, 'https://env.example.com');
    expect(cfg.brand).toBe('B');
    expect(cfg.storefrontUrl).toBe('https://s.example.com'); // trailing slash stripped
    expect(cfg.customLabels).toEqual(['a', '', '', '', '']);
  });
});
