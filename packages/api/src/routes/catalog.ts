import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import { resolveStore, DEV_DEFAULT_STORE, type StoreCtx } from '../store-context.js';
import * as s from '../db/schema.js';
import { convertMoney, rateFor, RATE_SCALE } from '../money/currency.js';

async function store(c: { req: { header: (k: string) => string | undefined } }): Promise<StoreCtx> {
  const slug = c.req.header('x-store-slug') ?? DEV_DEFAULT_STORE;
  const found = await resolveStore(slug);
  if (!found) throw new Error(`unknown store: ${slug}`);
  return found;
}

const Money = z.number().int().describe('integer minor units (cents)');

const ProductListItem = z.object({
  slug: z.string(),
  name: z.string(),
  status: z.string(),
  minPrice: Money.nullable(),
  image: z.string().nullable(),
});

const Variant = z.object({
  sku: z.string(),
  name: z.string(),
  price: Money,
  salePrice: Money.nullable(),
  compareAtPrice: Money.nullable(),
  isPreOrder: z.boolean(),
  enabled: z.boolean(),
});

const ProductDetail = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  seoTitle: z.string().nullable(),
  seoDescription: z.string().nullable(),
  currency: z.string(),
  images: z.array(z.string()),
  variants: z.array(Variant),
});

export const catalog = new OpenAPIHono();

// GET /v1/shop/catalog/products
catalog.openapi(
  createRoute({
    method: 'get',
    path: '/v1/shop/catalog/products',
    summary: 'List active products',
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(24),
        offset: z.coerce.number().int().min(0).default(0),
      }),
    },
    responses: {
      200: {
        description: 'Products',
        content: { 'application/json': { schema: z.object({ items: z.array(ProductListItem), total: z.number() }) } },
      },
    },
  }),
  async (c) => {
    const st = await store(c);
    const { limit, offset } = c.req.valid('query');
    const result = await withStore(st.id, async (tx) => {
      const items = await tx
        .select({
          slug: s.product.slug,
          name: s.product.name,
          status: s.product.status,
          minPrice: sql<number | null>`min(${s.productVariant.price})`,
          image: sql<string | null>`max(${s.asset.path})`,
        })
        .from(s.product)
        .leftJoin(s.productVariant, eq(s.productVariant.productId, s.product.id))
        .leftJoin(s.asset, eq(s.asset.id, s.product.featuredAssetId))
        .where(and(eq(s.product.status, 'active'), isNull(s.product.deletedAt)))
        .groupBy(s.product.id)
        .orderBy(asc(s.product.name))
        .limit(limit)
        .offset(offset);
      const totalRows = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(s.product)
        .where(and(eq(s.product.status, 'active'), isNull(s.product.deletedAt)));
      return { items, total: totalRows[0]?.total ?? 0 };
    });
    return c.json(result);
  },
);

// GET /v1/shop/catalog/products/:slug
catalog.openapi(
  createRoute({
    method: 'get',
    path: '/v1/shop/catalog/products/{slug}',
    summary: 'Product detail',
    request: { params: z.object({ slug: z.string() }), query: z.object({ currency: z.string().optional() }) },
    responses: {
      200: { description: 'Product', content: { 'application/json': { schema: ProductDetail } } },
      404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await store(c);
    const { slug } = c.req.valid('param');
    const { currency } = c.req.valid('query');
    const detail = await withStore(st.id, async (tx) => {
      const [p] = await tx
        .select()
        .from(s.product)
        .where(and(eq(s.product.slug, slug), isNull(s.product.deletedAt)))
        .limit(1);
      if (!p) return null;
      // Presentment conversion (display-only): orders still charge in base currency.
      const displayCurrency = (currency ?? st.currency).toUpperCase();
      let rate = RATE_SCALE;
      if (displayCurrency !== st.currency.toUpperCase()) {
        const rates = await tx.select({ currency: s.currencyRate.currency, rate: s.currencyRate.rate, enabled: s.currencyRate.enabled }).from(s.currencyRate);
        rate = rateFor(rates, st.currency, displayCurrency);
      }
      const conv = (v: number | null) => (v == null ? null : convertMoney(v, rate));
      const variants = (await tx
        .select({
          sku: s.productVariant.sku,
          name: s.productVariant.name,
          price: s.productVariant.price,
          salePrice: s.productVariant.salePrice,
          compareAtPrice: s.productVariant.compareAtPrice,
          isPreOrder: s.productVariant.isPreOrder,
          enabled: s.productVariant.enabled,
        })
        .from(s.productVariant)
        .where(and(eq(s.productVariant.productId, p.id), isNull(s.productVariant.deletedAt)))
        .orderBy(asc(s.productVariant.name)))
        .map((v) => ({ ...v, price: convertMoney(v.price, rate), salePrice: conv(v.salePrice), compareAtPrice: conv(v.compareAtPrice) }));
      const imgs = await tx
        .select({ path: s.asset.path })
        .from(s.productAsset)
        .innerJoin(s.asset, eq(s.asset.id, s.productAsset.assetId))
        .where(eq(s.productAsset.productId, p.id))
        .orderBy(asc(s.productAsset.position));
      return {
        slug: p.slug,
        name: p.name,
        description: p.description,
        status: p.status,
        seoTitle: p.seoTitle,
        seoDescription: p.seoDescription,
        currency: displayCurrency,
        images: imgs.map((i) => i.path),
        variants,
      };
    });
    if (!detail) return c.json({ error: 'not found' }, 404);
    return c.json(detail, 200);
  },
);

// GET /v1/shop/catalog/collections
catalog.openapi(
  createRoute({
    method: 'get',
    path: '/v1/shop/catalog/collections',
    summary: 'List collections',
    responses: {
      200: {
        description: 'Collections',
        content: {
          'application/json': {
            schema: z.object({ items: z.array(z.object({ slug: z.string(), name: z.string(), products: z.number() })) }),
          },
        },
      },
    },
  }),
  async (c) => {
    const st = await store(c);
    const items = await withStore(st.id, (tx) =>
      tx
        .select({
          slug: s.collection.slug,
          name: s.collection.name,
          products: sql<number>`count(${s.collectionProduct.productId})::int`,
        })
        .from(s.collection)
        .leftJoin(s.collectionProduct, eq(s.collectionProduct.collectionId, s.collection.id))
        .groupBy(s.collection.id)
        .orderBy(asc(s.collection.name)),
    );
    return c.json({ items });
  },
);

// ── storefront collection browse (manual or smart; published only) ────────────
import { productMatchesRules, parseRules } from '../catalog/collection-rules.js';

catalog.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/collections/{slug}', summary: 'Collection page (products + SEO)',
    request: { params: z.object({ slug: z.string() }) },
    responses: {
      200: { description: 'Collection', content: { 'application/json': { schema: z.object({ slug: z.string(), name: z.string(), description: z.string().nullable(), seoTitle: z.string().nullable(), seoDescription: z.string().nullable(), products: z.array(z.any()) }) } } },
      404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await store(c);
    const { slug } = c.req.valid('param');
    const out = await withStore(st.id, async (tx) => {
      const [col] = await tx.select().from(s.collection).where(eq(s.collection.slug, slug)).limit(1);
      if (!col || !col.published) return null;
      let products;
      const parsed = parseRules(col.rules);
      if (parsed) {
        const rows = await tx
          .select({ id: s.product.id, slug: s.product.slug, name: s.product.name, vendor: s.product.vendor, productType: s.product.productType, tags: s.product.tags, minPrice: sql<number | null>`(select min(price) from product_variant pv where pv.product_id = ${s.product.id} and pv.deleted_at is null)` })
          .from(s.product).where(and(eq(s.product.status, 'active'), isNull(s.product.deletedAt)));
        products = rows.filter((r) => productMatchesRules({ name: r.name, vendor: r.vendor, productType: r.productType, tags: r.tags, minPrice: r.minPrice }, parsed)).map((r) => ({ slug: r.slug, name: r.name, minPrice: r.minPrice }));
      } else {
        products = await tx
          .select({ slug: s.product.slug, name: s.product.name, minPrice: sql<number | null>`(select min(price) from product_variant pv where pv.product_id = ${s.product.id} and pv.deleted_at is null)` })
          .from(s.collectionProduct).innerJoin(s.product, eq(s.product.id, s.collectionProduct.productId))
          .where(and(eq(s.collectionProduct.collectionId, col.id), eq(s.product.status, 'active'), isNull(s.product.deletedAt)))
          .orderBy(asc(s.collectionProduct.position), s.product.name);
      }
      return { slug: col.slug, name: col.name, description: col.description, seoTitle: col.seoTitle, seoDescription: col.seoDescription, products };
    });
    if (!out) return c.json({ error: 'collection not found' }, 404);
    return c.json(out, 200);
  },
);

// GET /v1/shop/currencies — enabled presentment currencies (+ base)
catalog.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/currencies', summary: 'Available presentment currencies',
    responses: { 200: { description: 'OK', content: { 'application/json': { schema: z.object({ base: z.string(), currencies: z.array(z.object({ currency: z.string(), rate: z.number().int() })) }) } } } },
  }),
  async (c) => {
    const st = await store(c);
    const rates = await withStore(st.id, (tx) => tx.select({ currency: s.currencyRate.currency, rate: s.currencyRate.rate, enabled: s.currencyRate.enabled }).from(s.currencyRate));
    return c.json({ base: st.currency, currencies: rates.filter((r) => r.enabled).map((r) => ({ currency: r.currency, rate: r.rate })) }, 200);
  },
);
