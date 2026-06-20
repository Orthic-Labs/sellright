/**
 * Adapters: SellRight REST shapes → the Vendure-ish shapes the Qwik storefront
 * components already consume. This is the strangler seam — the providers call
 * these so the consuming components (PDP, shop grid, search, cart) need no
 * shape changes. See packages/api/src/routes/catalog.ts for the source shapes.
 *
 * Money: SellRight returns integer minor units (cents); the storefront's
 * formatPrice / Price divide by 100, so prices pass straight through.
 *
 * Variant identity: SellRight catalog variants are keyed by SKU (no numeric id).
 * We use the SKU as the stable `id` everywhere a variant id is expected.
 *
 * Stock: the catalog detail endpoint carries no stock; callers hydrate it from
 * /stock (srProductStock) on the client. Until then variants default to '0'
 * (disabled) — matching the manifest-first SSR convention already in the PDP.
 */
import type {
  SrProductDetail,
  SrSearchResult,
  SrStockResult,
  SrCollection,
  SrCollectionsResult,
  SrCustomer,
  SrAddress,
  SrAccountOrderSummary,
  SrAccountOrderDetail,
} from './sellright';

const IN_STOCK = '999';
const OUT_OF_STOCK = '0';

/** A search item shaped like the storefront's `SearchResponse.items[]`. */
export interface AdaptedSearchItem {
  productId: string;
  productName: string;
  slug: string;
  productVariantId: string;
  productAsset: { id: string; preview: string } | null;
  priceWithTax: { min: number; max: number };
  inStock: boolean;
  currencyCode: string;
}

/** Shaped like the storefront's `SearchResponse` (+ itemCustomFields used by the shop grid). */
export interface AdaptedSearchResponse {
  totalItems: number;
  items: AdaptedSearchItem[];
  facetValues: never[];
  collections: never[];
  itemCustomFields: never[];
}

/**
 * GET /catalog/search → SearchResponse-ish. SellRight search has no facets or
 * per-item custom fields, so those are empty (the search route's facet UI and
 * the shop grid's custom-field map both degrade gracefully on empty input).
 * `inStock` is true for every returned item: the search query already filters
 * to active products, and when the caller asks `inStock=true` the server only
 * returns in-stock rows.
 */
export function adaptSearch(res: SrSearchResult): AdaptedSearchResponse {
  return {
    totalItems: res.total,
    items: res.items.map((p) => ({
      productId: p.slug, // no numeric id server-side; slug is the stable key
      productName: p.name,
      slug: p.slug,
      productVariantId: p.slug,
      productAsset: p.image ? { id: p.slug, preview: p.image } : null,
      priceWithTax: { min: p.minPrice ?? 0, max: p.minPrice ?? 0 },
      inStock: p.status === 'active',
      currencyCode: 'USD',
    })),
    facetValues: [],
    collections: [],
    itemCustomFields: [],
  };
}

/** A product shaped like the storefront's `Product` (the subset the PDP reads). */
export interface AdaptedVariant {
  id: string;
  name: string;
  sku: string;
  price: number;
  priceWithTax: number;
  currencyCode: string;
  stockLevel: string;
  options: never[];
  assets: { id: string; preview: string }[];
  featuredAsset: { id: string; preview: string } | null;
  customFields: {
    salePrice: number | null;
    preOrderPrice: number | null;
    isPreOrder: boolean;
    shipDate: string | null;
  };
}

export interface AdaptedProduct {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  featuredAsset: { id: string; preview: string } | null;
  assets: { id: string; preview: string }[];
  variants: AdaptedVariant[];
  facetValues: never[];
  customFields: Record<string, never>;
  hasVariantAssets: boolean;
}

/**
 * GET /catalog/products/{slug} → Product-ish. SellRight catalog has no option
 * groups, so `options: []` → the PDP's single-variant selector path resolves to
 * `variants[0]`. Stock is '0' until hydrated client-side via applyStock().
 */
export function adaptProduct(res: SrProductDetail): AdaptedProduct {
  const featuredAsset = res.images[0] ? { id: `${res.slug}-0`, preview: res.images[0] } : null;
  const assets = res.images.map((preview, i) => ({ id: `${res.slug}-${i}`, preview }));
  return {
    id: res.slug,
    name: res.name,
    slug: res.slug,
    description: res.description,
    seoTitle: res.seoTitle,
    seoDescription: res.seoDescription,
    featuredAsset,
    assets,
    variants: res.variants.map((v) => ({
      id: v.sku,
      name: v.name,
      sku: v.sku,
      price: v.price,
      priceWithTax: v.salePrice ?? v.price,
      currencyCode: res.currency,
      stockLevel: v.enabled ? IN_STOCK : OUT_OF_STOCK,
      options: [],
      assets: [],
      featuredAsset,
      customFields: {
        salePrice: v.salePrice,
        preOrderPrice: null, // not exposed by the catalog detail variant schema
        isPreOrder: v.isPreOrder,
        shipDate: null,
      },
    })),
    facetValues: [],
    customFields: {},
    hasVariantAssets: false,
  };
}

/** Merge live per-variant stock (from /stock) into an adapted product, by SKU. */
export function applyStock(product: AdaptedProduct, stock: SrStockResult): AdaptedProduct {
  const bySku = new Map(stock.variants.map((v) => [v.sku, v.inStock]));
  product.variants = product.variants.map((v) => ({
    ...v,
    stockLevel: bySku.get(v.sku) ? IN_STOCK : OUT_OF_STOCK,
  }));
  return product;
}

/** GET /catalog/products/{slug}/stock → the shape `getProductStockLevelsOnly` returns. */
export function adaptStockOnly(slug: string, stock: SrStockResult) {
  return {
    product: {
      id: slug,
      variants: stock.variants.map((v) => ({ id: v.sku, stockLevel: v.inStock ? IN_STOCK : OUT_OF_STOCK })),
    },
  };
}

/** A collection shaped like the storefront's `Collection` (the subset consumers read). */
export interface AdaptedCollection {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  featuredAsset: { id: string; preview: string } | null;
  children: never[];
  breadcrumbs: never[];
  parent: { name: '__root_collection__' };
  productVariants: { items: never[]; totalItems: number };
  products: Array<{ slug: string; name: string; minPrice: number | null }>;
}

export function adaptCollection(res: SrCollection): AdaptedCollection {
  return {
    id: res.slug,
    slug: res.slug,
    name: res.name,
    description: res.description,
    seoTitle: res.seoTitle,
    seoDescription: res.seoDescription,
    featuredAsset: null,
    children: [],
    breadcrumbs: [],
    parent: { name: '__root_collection__' },
    productVariants: { items: [], totalItems: 0 },
    products: res.products,
  };
}

export function adaptCollections(res: SrCollectionsResult): AdaptedCollection[] {
  return res.items.map((c) =>
    adaptCollection({
      slug: c.slug,
      name: c.name,
      description: null,
      seoTitle: null,
      seoDescription: null,
      products: [],
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Customer / Address / Order — SellRight REST → Vendure-ish shapes the account
// + checkout components already read (firstName, emailAddress, addresses[].
// streetLine1, country.code, orders.items[], totalWithTax, …). The providers
// cast the adapter output to the generated Vendure types; the field names match
// what the components actually read, so the components need no changes.
// ─────────────────────────────────────────────────────────────────────────────

/** A Vendure-ish Address (the subset the address book / checkout read). */
export interface AdaptedAddress {
  id: string;
  fullName: string;
  company: string;
  streetLine1: string;
  streetLine2: string;
  city: string;
  province: string;
  postalCode: string;
  country: { code: string; name: string };
  phoneNumber: string;
  defaultShippingAddress: boolean;
  defaultBillingAddress: boolean;
}

/** A Vendure-ish Customer (the subset account pages read). `addresses` is
 *  populated only when the caller fetched the address book (else []). */
export interface AdaptedCustomer {
  id: string;
  title: string;
  firstName: string;
  lastName: string;
  emailAddress: string;
  phoneNumber: string;
  // WP5: surfaced so the storefront can render the migrated-customer banner.
  customFields: { isMigrated: boolean; emailVerified: boolean };
  addresses: AdaptedAddress[];
}

export function adaptAddress(a: SrAddress): AdaptedAddress {
  return {
    id: a.id,
    fullName: a.fullName ?? '',
    company: '',
    streetLine1: a.line1,
    streetLine2: a.line2 ?? '',
    city: a.city,
    province: a.province ?? '',
    postalCode: a.postalCode ?? '',
    country: { code: a.country, name: a.country },
    phoneNumber: a.phone ?? '',
    defaultShippingAddress: a.isDefaultShipping,
    defaultBillingAddress: a.isDefaultBilling,
  };
}

export function adaptCustomer(c: SrCustomer, addresses: SrAddress[] = []): AdaptedCustomer {
  return {
    id: c.id,
    title: '',
    firstName: c.firstName ?? '',
    lastName: c.lastName ?? '',
    emailAddress: c.email,
    phoneNumber: c.phone ?? '',
    customFields: { isMigrated: c.isMigrated, emailVerified: c.emailVerified },
    addresses: addresses.map(adaptAddress),
  };
}

/** Map the storefront's Vendure-ish CreateAddressInput → the REST address body. */
export function toAddressInput(input: {
  fullName?: string | null;
  streetLine1?: string | null;
  streetLine2?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
  phoneNumber?: string | null;
  defaultShippingAddress?: boolean | null;
  defaultBillingAddress?: boolean | null;
}) {
  return {
    fullName: input.fullName ?? null,
    line1: input.streetLine1 ?? '',
    line2: input.streetLine2 ?? null,
    city: input.city ?? '',
    province: input.province ?? null,
    postalCode: input.postalCode ?? null,
    country: (input.countryCode ?? 'US').toUpperCase(),
    phone: input.phoneNumber ?? null,
    isDefaultShipping: input.defaultShippingAddress ?? undefined,
    isDefaultBilling: input.defaultBillingAddress ?? undefined,
  };
}

/** A Vendure-ish Order line (the subset order history reads). */
export interface AdaptedOrderLine {
  id: string;
  quantity: number;
  linePriceWithTax: number;
  unitPriceWithTax: number;
  featuredAsset: { preview: string } | null;
  productVariant: { name: string; sku: string; product: { name: string }; options: never[]; customFields: Record<string, never> };
  customFields: Record<string, never>;
}

/** A Vendure-ish Order (the subset account history + confirmation read). The
 *  REST account-order endpoints carry far less than Vendure (no per-line tax,
 *  no payments/fulfillments); the unread/zero fields keep the components from
 *  crashing on missing properties. */
export interface AdaptedOrder {
  id: string;
  code: string;
  state: string;
  createdAt: string | null;
  totalWithTax: number;
  total: number;
  subTotalWithTax: number;
  subTotal: number;
  shippingWithTax: number;
  shipping: number;
  totalQuantity: number;
  currencyCode: string;
  lines: AdaptedOrderLine[];
  discounts: never[];
  couponCodes: never[];
  surcharges: never[];
  shippingLines: never[];
  payments: never[];
  fulfillments: never[];
  shippingAddress: Record<string, unknown> | null;
  billingAddress: Record<string, unknown> | null;
  customer: { firstName: string; lastName: string; emailAddress: string } | null;
  customFields: { isPreOrder: boolean };
}

/** Order-history list row (no lines, just a count + totals). */
export function adaptOrderSummary(o: SrAccountOrderSummary): AdaptedOrder {
  return {
    id: o.code,
    code: o.code,
    state: o.state,
    createdAt: o.placedAt,
    totalWithTax: o.grandTotal,
    total: o.grandTotal,
    subTotalWithTax: o.grandTotal,
    subTotal: o.grandTotal,
    shippingWithTax: 0,
    shipping: 0,
    totalQuantity: o.lines,
    currencyCode: 'USD',
    lines: [],
    discounts: [],
    couponCodes: [],
    surcharges: [],
    shippingLines: [],
    payments: [],
    fulfillments: [],
    shippingAddress: null,
    billingAddress: null,
    customer: null,
    customFields: { isPreOrder: false },
  };
}

/** Order detail (owned, by code) — has line snapshots. */
export function adaptOrderDetail(o: SrAccountOrderDetail): AdaptedOrder {
  return {
    id: o.code,
    code: o.code,
    state: o.state,
    createdAt: null,
    totalWithTax: o.grandTotal,
    total: o.grandTotal,
    subTotalWithTax: o.grandTotal,
    subTotal: o.grandTotal,
    shippingWithTax: 0,
    shipping: 0,
    totalQuantity: o.lines.reduce((a, l) => a + l.quantity, 0),
    currencyCode: 'USD',
    lines: o.lines.map((l, i) => ({
      id: `${o.code}-${i}`,
      quantity: l.quantity,
      linePriceWithTax: l.lineTotal,
      unitPriceWithTax: l.quantity ? Math.round(l.lineTotal / l.quantity) : l.lineTotal,
      featuredAsset: null,
      productVariant: { name: l.name, sku: l.sku, product: { name: l.name }, options: [], customFields: {} },
      customFields: {},
    })),
    discounts: [],
    couponCodes: [],
    surcharges: [],
    shippingLines: [],
    payments: [],
    fulfillments: [],
    shippingAddress: null,
    billingAddress: null,
    customer: null,
    customFields: { isPreOrder: false },
  };
}

export function adaptAccountOrders(res: { items: SrAccountOrderSummary[] }): AdaptedOrder[] {
  return res.items.map(adaptOrderSummary);
}
