/**
 * PAR-02: public merchant product feeds — Google Merchant Center, Facebook/
 * Meta catalog, Pinterest. Per-store (host/x-store-slug resolution like every
 * shop route), one CSV row per enabled variant of an active product.
 *
 *   GET /v1/shop/feeds/{channel}   channel = google | facebook | pinterest
 *                                  (a ".csv" suffix is tolerated — merchant
 *                                  consoles conventionally register *.csv URLs)
 *
 * Refresh semantics (PAR-02): the feed renders from live tables on every
 * request — catalog, price, and stock changes appear on the next poll, no
 * cron/static-file regeneration. A short public cache TTL (5 min) keeps a
 * polling merchant center off the hot path without meaningfully delaying
 * updates.
 *
 * Public-by-design: feed URLs are registered in third-party dashboards that
 * send no credentials — the data is the same public catalog/price/stock the
 * storefront exposes. No CSRF (GET, no cookies, no session).
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import { resolveStoreFromCtx } from './store-context.js';
import * as s from '../db/schema.js';
import { env } from '../env.js';
import {
  feedConfigFromStore, generateFeed, toFeedItem,
  type FeedRow,
} from '../feeds/feed.js';

export const feeds = new OpenAPIHono();

// `{channel}` with or without a ".csv" suffix.
const ChannelParam = z.preprocess(
  (v) => (typeof v === 'string' ? v.replace(/\.csv$/i, '') : v),
  z.enum(['google', 'facebook', 'pinterest']),
);

async function loadFeedRows(storeId: string): Promise<FeedRow[]> {
  return withStore(storeId, async (tx) => {
    // Base row set: enabled variants of active, non-deleted products. Featured
    // asset is the primary image (matches manifest/generate.ts); a missing
    // stock row means zero availability for physical items.
    const rows = await tx
      .select({
        variantId: s.productVariant.id,
        sku: s.productVariant.sku,
        variantName: s.productVariant.name,
        price: s.productVariant.price,
        salePrice: s.productVariant.salePrice,
        compareAtPrice: s.productVariant.compareAtPrice,
        isPreOrder: s.productVariant.isPreOrder,
        preOrderPrice: s.productVariant.preOrderPrice,
        fulfillmentType: s.productVariant.fulfillmentType,
        barcode: s.productVariant.barcode,
        weightG: s.productVariant.weightG,
        productId: s.product.id,
        productSlug: s.product.slug,
        productName: s.product.name,
        productDescription: s.product.description,
        vendor: s.product.vendor,
        productType: s.product.productType,
        imagePath: s.asset.path,
        stockAvailable: sql<number | null>`${s.stock.onHand} - ${s.stock.allocated}`,
      })
      .from(s.productVariant)
      .innerJoin(s.product, eq(s.product.id, s.productVariant.productId))
      .leftJoin(s.asset, eq(s.asset.id, s.product.featuredAssetId))
      .leftJoin(s.stock, eq(s.stock.variantId, s.productVariant.id))
      .where(and(
        // RLS already confines this to the resolved store — the explicit
        // predicate is defense-in-depth so the feed can't cross stores even
        // if the connection role ever bypasses RLS.
        eq(s.productVariant.storeId, storeId),
        eq(s.product.status, 'active'),
        isNull(s.product.deletedAt),
        eq(s.productVariant.enabled, true),
        isNull(s.productVariant.deletedAt),
      ))
      .orderBy(asc(s.product.name), asc(s.productVariant.sku));

    if (!rows.length) return [];

    // Variant options (color/size/etc.) — one pass, grouped in JS.
    const variantIds = rows.map((r) => r.variantId);
    const optRows = await tx
      .select({
        variantId: s.variantOption.variantId,
        groupName: s.productOptionGroup.name,
        value: s.productOption.value,
      })
      .from(s.variantOption)
      .innerJoin(s.productOption, eq(s.productOption.id, s.variantOption.optionId))
      .innerJoin(s.productOptionGroup, eq(s.productOptionGroup.id, s.productOption.groupId))
      .where(and(inArray(s.variantOption.variantId, variantIds), eq(s.variantOption.storeId, storeId)));
    const optionsByVariant = new Map<string, Record<string, string>>();
    for (const o of optRows) {
      const m = optionsByVariant.get(o.variantId) ?? {};
      m[o.groupName.trim().toLowerCase()] = o.value;
      optionsByVariant.set(o.variantId, m);
    }

    // Gallery images: first product-asset that isn't the featured one becomes
    // additional_image_link (Google/Pinterest support it).
    const productIds = [...new Set(rows.map((r) => r.productId))];
    const gallery = await tx
      .select({ productId: s.productAsset.productId, assetId: s.productAsset.assetId, path: s.asset.path })
      .from(s.productAsset)
      .innerJoin(s.asset, eq(s.asset.id, s.productAsset.assetId))
      .where(and(inArray(s.productAsset.productId, productIds), eq(s.productAsset.storeId, storeId)))
      .orderBy(asc(s.productAsset.position));
    const galleryByProduct = new Map<string, Array<{ assetId: string; path: string }>>();
    for (const g of gallery) {
      const arr = galleryByProduct.get(g.productId) ?? [];
      arr.push({ assetId: g.assetId, path: g.path });
      galleryByProduct.set(g.productId, arr);
    }

    return rows.map((r) => {
      const additional = (galleryByProduct.get(r.productId) ?? [])
        .map((g) => g.path)
        .find((p) => p && p !== r.imagePath);
      return {
        ...r,
        imagePath: r.imagePath ?? (galleryByProduct.get(r.productId)?.[0]?.path ?? null),
        additionalImagePath: additional ?? null,
        options: optionsByVariant.get(r.variantId) ?? {},
      };
    });
  });
}

feeds.openapi(
  createRoute({
    method: 'get',
    path: '/v1/shop/feeds/{channel}',
    summary: 'Merchant product feed (CSV) for a channel',
    request: { params: z.object({ channel: ChannelParam }) },
    responses: {
      200: { description: 'CSV feed', content: { 'text/csv': { schema: z.string() } } },
      400: { description: 'Unknown channel', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      404: { description: 'Unknown store', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const channel = c.req.valid('param').channel;
    const cfg = feedConfigFromStore({ name: st.name, currency: st.currency, config: st.config }, env.STOREFRONT_URL);
    const rows = await loadFeedRows(st.id);
    const csv = generateFeed(channel, rows.map((r) => toFeedItem(r, cfg)), cfg);
    return c.body(csv, 200, {
      'content-type': 'text/csv; charset=utf-8',
      // Short public cache: merchant centers poll; live tables mean a missed
      // cache window is the only staleness possible.
      'cache-control': 'public, max-age=300',
    });
  },
);
