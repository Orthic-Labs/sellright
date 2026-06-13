/**
 * Static catalog manifest generator (the storefront's browse read-path).
 * Reads SellRight catalog and writes shop-catalog.json + products/{slug}.json in
 * the shape the Qwik storefront's SSR loaders expect (DD-compatible). Browse =
 * static files; only cart/checkout/auth/search hit the live API.
 *
 *   CATALOG_DIR=/path DATABASE_URL=...sellright_dev corepack pnpm tsx src/manifest/generate.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { resolveStore, DEV_DEFAULT_STORE } from '../store-context.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';

const OUT = env.CATALOG_DIR ?? '/home/vendure/sites/sellright-data';
const STORE_SLUG = env.STORE_SLUG ?? DEV_DEFAULT_STORE;
const assetUrl = (path: string | null | undefined) => (path ? `/assets/${path}` : null);
const selectPrice = (v: { price: number; salePrice: number | null; isPreOrder: boolean; preOrderPrice: number | null }) =>
  v.isPreOrder && v.preOrderPrice != null ? v.preOrderPrice : v.salePrice ?? v.price;

function group<T, K>(arr: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of arr) {
    const k = key(x);
    (m.get(k) ?? m.set(k, []).get(k)!).push(x);
  }
  return m;
}

async function main() {
  await mkdir(`${OUT}/products`, { recursive: true });
  const now = new Date().toISOString();

  const store = await resolveStore(STORE_SLUG);
  const { manifest, details } = await withStore(store.id, async (tx) => {
    const products = await tx.select().from(s.product)
      .where(and(eq(s.product.status, 'active'), isNull(s.product.deletedAt))).orderBy(asc(s.product.name));
    const assetById = new Map((await tx.select({ id: s.asset.id, path: s.asset.path }).from(s.asset)).map((a) => [a.id, a.path]));
    const variants = await tx.select().from(s.productVariant).where(isNull(s.productVariant.deletedAt));
    const variantsByProduct = group(variants, (v) => v.productId);
    const stockByVariant = new Map((await tx.select().from(s.stock)).map((st) => [st.variantId, st.onHand - st.allocated]));
    const vo = await tx.select({ variantId: s.variantOption.variantId, value: s.productOption.value, groupName: s.productOptionGroup.name })
      .from(s.variantOption)
      .innerJoin(s.productOption, eq(s.productOption.id, s.variantOption.optionId))
      .innerJoin(s.productOptionGroup, eq(s.productOptionGroup.id, s.productOption.groupId));
    const optsByVariant = group(vo, (x) => x.variantId);
    const pa = await tx.select({ productId: s.productAsset.productId, path: s.asset.path, position: s.productAsset.position })
      .from(s.productAsset).innerJoin(s.asset, eq(s.asset.id, s.productAsset.assetId)).orderBy(asc(s.productAsset.position));
    const assetsByProduct = group(pa, (x) => x.productId);

    const manifestProducts = [];
    const details = [];
    for (const p of products) {
      const vs = variantsByProduct.get(p.id) ?? [];
      const prices = vs.map(selectPrice);
      const min = prices.length ? Math.min(...prices) : 0;
      const max = prices.length ? Math.max(...prices) : 0;
      const inStock = vs.some((v) => v.fulfillmentType !== 'physical' || v.isPreOrder || (stockByVariant.get(v.id) ?? 0) > 0);
      const featured = assetUrl(p.featuredAssetId ? assetById.get(p.featuredAssetId) : null);
      const v0 = vs[0];
      const cf = { salePrice: v0?.salePrice ?? null, preOrderPrice: v0?.preOrderPrice ?? null, shipDate: v0?.shipDate ?? null, isPreOrder: v0?.isPreOrder ?? false };
      manifestProducts.push({
        id: p.slug, name: p.name, slug: p.slug,
        featuredAsset: featured ? { preview: featured } : null,
        priceRange: { min, max }, inStock, facetValues: [], hasMultiplePrices: min !== max, customFields: cf,
      });
      details.push({
        lastUpdated: now, id: p.slug, name: p.name, slug: p.slug, description: p.description,
        featuredAsset: featured ? { preview: featured } : null,
        assets: (assetsByProduct.get(p.id) ?? []).map((a) => ({ preview: assetUrl(a.path) })),
        priceRange: { min, max }, facetValues: [], hasMultiplePrices: min !== max, hasVariantAssets: false,
        variants: vs.map((v) => ({
          id: v.sku, name: v.name, sku: v.sku, priceWithTax: selectPrice(v),
          options: (optsByVariant.get(v.id) ?? []).map((o) => ({ group: o.groupName, code: o.groupName.toLowerCase(), name: o.value })),
          assets: [],
          customFields: { salePrice: v.salePrice, preOrderPrice: v.preOrderPrice, shipDate: v.shipDate, isPreOrder: v.isPreOrder },
        })),
      });
    }
    return { manifest: { lastUpdated: now, totalItems: manifestProducts.length, defaultSort: 'name', products: manifestProducts }, details };
  });

  await writeFile(`${OUT}/shop-catalog.json`, JSON.stringify(manifest));
  for (const d of details) await writeFile(`${OUT}/products/${d.slug}.json`, JSON.stringify(d));
  // eslint-disable-next-line no-console
  console.log(`manifest: ${STORE_SLUG}: ${manifest.totalItems} products + ${details.length} detail files -> ${OUT}`);
  await pool.end();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
