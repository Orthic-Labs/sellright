/**
 * PAR-02: merchant product feeds (Google / Facebook / Pinterest CSV).
 * Ported from RH's product-sync strategies (google/facebook/pinterest) onto
 * the SellRight schema — one row per enabled variant of an active product.
 *
 * Refresh semantics: RH regenerated CSVs on a daily cron; here the endpoints
 * render straight off the live tables on every request, so a feed pull always
 * reflects the current catalog/stock (no stale static file, no regenerate
 * call needed). Keep the row-shaping pure (this file) and the SQL in
 * routes/feeds.ts so the escaping/format rules are unit-testable without a DB.
 *
 * Store-scoped knobs live in store.config.feeds — see FeedConfig below.
 */
import { selectUnitPrice, variantPriceRuleFromConfig, DEFAULT_VARIANT_PRICE_RULE, type VariantPriceRule } from '../money/pricing.js';

/** One output row = one sellable variant. */
export interface FeedItem {
  /** Stable item id — variant sku, falling back to the variant uuid. */
  id: string;
  /** "Product — Variant" (variant suffix dropped when it just repeats the product name). */
  title: string;
  description: string;
  /** Absolute product page URL. */
  link: string;
  imageLink: string;
  additionalImageLink: string;
  /** "123.45 USD" — effective sell price (pre-order price wins, then sale price). */
  price: string;
  /** Same format; only populated when a genuine markdown exists. */
  salePrice: string;
  availability: 'in stock' | 'out of stock' | 'preorder';
  condition: 'new';
  brand: string;
  itemGroupId: string; // product id — groups a product's variants
  color: string;
  size: string;
  gtin: string; // barcode (UPC/EAN/ISBN)
  mpn: string;  // sku
  identifierExists: 'TRUE' | 'FALSE';
  productType: string;
  shippingWeight: string;
}

export interface FeedConfig {
  storefrontUrl: string; // absolute base, no trailing slash
  currency: string;      // ISO-4217
  brand: string;         // fallback when product.vendor is unset
  /** store.config.pricing.variantRule — the same selector cart/checkout use. */
  priceRule: VariantPriceRule;
  /** e.g. '/products/{slug}' — {slug} placeholder required. */
  productUrlPattern: string;
  /** Option groups (lowercased names) appended to each item link as query
   *  params, e.g. ['color','size'] -> ?color=forest-green&size=large, so the
   *  link opens the PDP with that variant preselected. Empty = plain link. */
  variantLinkParams: string[];
  /** Item title template. Placeholders: {productName} {variantName}
   *  {feedTitle} (product.metafields.feeds.title, else product name) and
   *  {option:<group>} / {Option:<group>} (raw / Title Cased option value).
   *  ' – '-joined segments whose placeholders resolve empty are dropped.
   *  Empty = "<product> - <variant>". */
  titleTemplate: string;
  /** item_group_id source: 'product' (product id) or 'skuBase' (sku with a
   *  trailing -NN removed, e.g. TEE-01 -> TEE). */
  itemGroupId: 'product' | 'skuBase';
  /** Absolute base for asset paths (default: storefrontUrl). */
  assetBaseUrl: string;
  googleProductCategory: string;
  productType: string;
  fbProductCategory: string;
  ageGroup: string;
  gender: string;
  material: string;
  pattern: string;
  sizeSystem: string;
  sizeType: string;
  shippingWeight: string;
  style: string;
  customLabels: [string, string, string, string, string];
}

export type FeedChannel = 'google' | 'facebook' | 'pinterest';

interface RawFeedConfig {
  brand?: string;
  productUrlPattern?: string;
  variantLinkParams?: string[];
  titleTemplate?: string;
  itemGroupId?: string;
  assetBaseUrl?: string;
  googleProductCategory?: string;
  productType?: string;
  fbProductCategory?: string;
  ageGroup?: string;
  gender?: string;
  material?: string;
  pattern?: string;
  sizeSystem?: string;
  sizeType?: string;
  shippingWeight?: string;
  style?: string;
  customLabels?: string[];
}

/** Merge store.config.feeds over generic defaults. All values are optional;
 *  an unconfigured store still gets a valid feed (brand = store name). */
export function feedConfigFromStore(store: { name: string; currency: string; config: unknown }, envStorefrontUrl: string): FeedConfig {
  const cfg = ((store.config as { feeds?: RawFeedConfig; storefrontUrl?: string } | null)?.feeds) ?? {};
  const storedUrl = (store.config as { storefrontUrl?: string } | null)?.storefrontUrl;
  const storefrontUrl = storefrontUrl0(storedUrl, envStorefrontUrl);
  const labels = Array.isArray(cfg.customLabels) ? cfg.customLabels.map(String) : [];
  return {
    storefrontUrl,
    currency: store.currency.toUpperCase(),
    brand: cfg.brand ?? store.name,
    priceRule: variantPriceRuleFromConfig(store.config),
    productUrlPattern: cfg.productUrlPattern ?? '/products/{slug}',
    variantLinkParams: Array.isArray(cfg.variantLinkParams) ? cfg.variantLinkParams.map((g) => String(g).trim().toLowerCase()).filter(Boolean) : [],
    titleTemplate: typeof cfg.titleTemplate === 'string' ? cfg.titleTemplate : '',
    itemGroupId: cfg.itemGroupId === 'skuBase' ? 'skuBase' : 'product',
    // Asset keys are relative to the public /assets mount (the storefront
    // renders `/assets/<key>`), so that is the default base.
    assetBaseUrl: (cfg.assetBaseUrl ?? `${storefrontUrl}/assets`).replace(/\/+$/, ''),
    googleProductCategory: cfg.googleProductCategory ?? '',
    productType: cfg.productType ?? '',
    fbProductCategory: cfg.fbProductCategory ?? '',
    ageGroup: cfg.ageGroup ?? 'adult',
    gender: cfg.gender ?? 'unisex',
    material: cfg.material ?? '',
    pattern: cfg.pattern ?? '',
    sizeSystem: cfg.sizeSystem ?? '',
    sizeType: cfg.sizeType ?? '',
    shippingWeight: cfg.shippingWeight ?? '',
    style: cfg.style ?? '',
    customLabels: [labels[0] ?? '', labels[1] ?? '', labels[2] ?? '', labels[3] ?? '', labels[4] ?? ''],
  };
}

function storefrontUrl0(stored: string | undefined, envUrl: string): string {
  return (stored ?? envUrl).replace(/\/+$/, '');
}

/** Variant/product row as loaded by routes/feeds.ts (live tables). */
export interface FeedRow {
  variantId: string;
  sku: string;
  variantName: string;
  price: number;
  salePrice: number | null;
  compareAtPrice: number | null;
  isPreOrder: boolean;
  preOrderPrice: number | null;
  fulfillmentType: string;
  barcode: string | null;
  weightG: number | null;
  productId: string;
  productSlug: string;
  productName: string;
  productDescription: string | null;
  vendor: string | null;
  productType: string | null;
  imagePath: string | null;
  /** Gallery images other than imagePath (variant's own first, else product's). */
  additionalImagePaths?: string[];
  additionalImagePath?: string | null;
  /** product.metafields.feeds.title — optional per-product feed title. */
  feedTitle?: string | null;
  stockAvailable: number | null; // onHand - allocated; null = no stock row
  options: Record<string, string>; // lowercased group name -> value
}

const money = (cents: number, currency: string) => `${(cents / 100).toFixed(2)} ${currency}`;

/** Effective sell price — the shared per-store selector (money/pricing.ts). */
export function effectivePrice(
  v: Pick<FeedRow, 'price' | 'salePrice' | 'isPreOrder' | 'preOrderPrice'>,
  rule: VariantPriceRule = DEFAULT_VARIANT_PRICE_RULE,
): number {
  return selectUnitPrice(v, rule);
}

/** Availability — mirrors catalog.ts: non-physical stock is always sellable. */
export function availabilityOf(v: Pick<FeedRow, 'fulfillmentType' | 'isPreOrder' | 'stockAvailable'>): FeedItem['availability'] {
  if (v.isPreOrder) return 'preorder';
  if (v.fulfillmentType !== 'physical') return 'in stock';
  return (v.stockAvailable ?? 0) > 0 ? 'in stock' : 'out of stock';
}

function absoluteUrl(path: string | null | undefined, base: string): string {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path; // already absolute (imported/CDN asset)
  let rel = path.replace(/^\/+/, '');
  // A key already carrying the mount segment must not get it twice.
  if (/\/assets$/.test(base) && rel.startsWith('assets/')) rel = rel.slice('assets/'.length);
  return `${base}/${rel}`;
}

/** "Forest green" -> "forest-green" (the storefront's option param form). */
export function toParamCode(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const titleCase = (v: string) => v.trim().toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** Feeds reject raw markup in `description` — reduce rich text to plain text. */
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
export function htmlToText(html: string): string {
  let text = html.replace(/<(br|\/p|\/li|\/h[1-6])\s*\/?>/gi, ' ');
  // Strip tags to a fixed point (nested/overlapping fragments like "<<b>p>"),
  // then drop any lone angle brackets left behind.
  for (let prev = ''; prev !== text;) { prev = text; text = text.replace(/<[^<>]*>/g, ''); }
  return text
    .replace(/[<>]/g, '')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function productLink(cfg: FeedConfig, row: Pick<FeedRow, 'productSlug' | 'options'>): string {
  const pattern = cfg.productUrlPattern.includes('{slug}') ? cfg.productUrlPattern : '/products/{slug}';
  const base = `${cfg.storefrontUrl}${pattern.replace('{slug}', encodeURIComponent(row.productSlug))}`;
  const params = new URLSearchParams();
  for (const group of cfg.variantLinkParams) {
    const value = row.options[group];
    if (value) params.set(group, toParamCode(value));
  }
  const qs = params.toString();
  return qs ? `${base}${base.includes('?') ? '&' : '?'}${qs}` : base;
}

function renderTitle(row: FeedRow, cfg: FeedConfig): string {
  const vn = row.variantName.trim();
  if (!cfg.titleTemplate.trim()) return vn && vn !== row.productName ? `${row.productName} - ${vn}` : row.productName || vn;
  const value = (key: string): string => {
    if (key === 'productName') return row.productName;
    if (key === 'variantName') return vn;
    if (key === 'feedTitle') return row.feedTitle?.trim() || row.productName;
    const m = /^([oO])ption:(.+)$/.exec(key);
    if (m) { const v = row.options[m[2]!.trim().toLowerCase()] ?? ''; return m[1] === 'O' ? titleCase(v) : v; }
    return '';
  };
  return cfg.titleTemplate.split(' – ')
    .map((seg) => { let empty = false; const out = seg.replace(/\{([^}]+)\}/g, (_m, k: string) => { const v = value(k); if (!v) empty = true; return v; }); return empty ? '' : out.trim(); })
    .filter(Boolean).join(' – ').slice(0, 150);
}

/** Shape one DB row into a feed item (channel-agnostic fields). */
export function toFeedItem(row: FeedRow, cfg: FeedConfig): FeedItem {
  const vn = row.variantName.trim();
  const title = renderTitle(row, cfg);
  const imageLink = absoluteUrl(row.imagePath, cfg.assetBaseUrl);
  const extra = (row.additionalImagePaths ?? (row.additionalImagePath ? [row.additionalImagePath] : []))
    .map((p) => absoluteUrl(p, cfg.assetBaseUrl))
    .filter((u, i, all) => u && u !== imageLink && all.indexOf(u) === i)
    .slice(0, 10);
  const price = effectivePrice(row, cfg.priceRule);
  const onSale = row.salePrice != null && row.salePrice < row.price;
  const gtin = row.barcode?.trim() ?? '';
  const mpn = row.sku?.trim() ?? '';
  return {
    id: row.sku || row.variantId,
    title,
    description: htmlToText(row.productDescription ?? '') || row.productName || vn,
    link: productLink(cfg, row),
    imageLink,
    additionalImageLink: extra.join(','),
    price: money(price, cfg.currency),
    salePrice: onSale ? money(row.salePrice!, cfg.currency) : '',
    availability: availabilityOf(row),
    condition: 'new',
    brand: row.vendor?.trim() || cfg.brand,
    itemGroupId: cfg.itemGroupId === 'skuBase' && row.sku ? row.sku.replace(/-\d+$/, '') : row.productId,
    color: row.options['color'] ?? '',
    size: row.options['size'] ?? '',
    gtin,
    mpn,
    identifierExists: gtin || mpn ? 'TRUE' : 'FALSE',
    productType: row.productType?.trim() || cfg.productType,
    shippingWeight: cfg.shippingWeight,
  };
}

/** RFC-4180-ish cell escape — same rule RH used: strip CR/LF/TAB, double quotes,
 *  quote only when the result contains a comma or quote. */
export function csvCell(value: unknown): string {
  const str = value == null ? '' : String(value).replace(/\r|\n|\t/g, ' ');
  const escaped = str.replace(/"/g, '""');
  return /[",]/.test(escaped) ? `"${escaped}"` : escaped;
}

const csvRow = (cells: unknown[]) => cells.map(csvCell).join(',');

export const GOOGLE_FIELDS = [
  'id', 'title', 'description', 'link', 'image_link', 'price', 'availability', 'condition', 'brand',
  'google_product_category', 'product_type', 'item_group_id', 'color', 'size', 'age_group', 'gender',
  'material', 'pattern', 'gtin', 'mpn', 'identifier_exists', 'shipping_weight', 'additional_image_link',
  'size_system', 'size_type',
] as const;

export const FACEBOOK_FIELDS = [
  'id', 'title', 'description', 'availability', 'condition', 'price', 'link', 'image_link', 'additional_image_link', 'brand',
  'google_product_category', 'fb_product_category', 'quantity_to_sell_on_facebook', 'sale_price',
  'sale_price_effective_date', 'item_group_id', 'gender', 'color', 'size', 'age_group', 'material',
  'pattern', 'shipping', 'shipping_weight', 'video[0].url', 'video[0].tag[0]', 'gtin',
  'product_tags[0]', 'product_tags[1]', 'style[0]',
] as const;

export const PINTEREST_FIELDS = [
  'id', 'title', 'description', 'link', 'image_link', 'price', 'availability', 'item_group_id',
  'brand', 'condition', 'google_product_category', 'product_type', 'color', 'size', 'gender',
  'age_group', 'material', 'sale_price', 'additional_image_link',
  'custom_label_0', 'custom_label_1', 'custom_label_2', 'custom_label_3', 'custom_label_4',
] as const;

function googleRow(i: FeedItem, cfg: FeedConfig): string {
  return csvRow([
    i.id, i.title, i.description, i.link, i.imageLink, i.price, i.availability, i.condition, i.brand,
    cfg.googleProductCategory, i.productType, i.itemGroupId, i.color, i.size, cfg.ageGroup, cfg.gender,
    cfg.material, cfg.pattern, i.gtin, i.mpn, i.identifierExists, i.shippingWeight, i.additionalImageLink,
    cfg.sizeSystem, cfg.sizeType,
  ]);
}

function facebookRow(i: FeedItem, cfg: FeedConfig): string {
  return csvRow([
    i.id, i.title, i.description, i.availability, i.condition, i.price, i.link, i.imageLink, i.additionalImageLink, i.brand,
    cfg.googleProductCategory, cfg.fbProductCategory, /* quantity_to_sell_on_facebook */ '',
    i.salePrice, /* sale_price_effective_date */ '', i.itemGroupId, cfg.gender, i.color, i.size,
    cfg.ageGroup, cfg.material, cfg.pattern, /* shipping */ '', i.shippingWeight,
    /* video url/tag */ '', '', i.gtin, /* product_tags */ '', '', cfg.style,
  ]);
}

function pinterestRow(i: FeedItem, cfg: FeedConfig): string {
  return csvRow([
    i.id, i.title, i.description, i.link, i.imageLink, i.price, i.availability, i.itemGroupId,
    i.brand, i.condition, cfg.googleProductCategory, i.productType, i.color, i.size, cfg.gender,
    cfg.ageGroup, cfg.material, i.salePrice, i.additionalImageLink, ...cfg.customLabels,
  ]);
}

/** Render a complete CSV (header + one row per item). Items are pre-shaped via
 *  toFeedItem so this stays pure. */
export function generateFeed(channel: FeedChannel, items: FeedItem[], cfg: FeedConfig): string {
  switch (channel) {
    case 'google':
      return [GOOGLE_FIELDS.join(','), ...items.map((i) => googleRow(i, cfg))].join('\n');
    case 'facebook':
      return [FACEBOOK_FIELDS.join(','), ...items.map((i) => facebookRow(i, cfg))].join('\n');
    case 'pinterest':
      return [PINTEREST_FIELDS.join(','), ...items.map((i) => pinterestRow(i, cfg))].join('\n');
  }
}
