/**
 * Reads the native catalog and publishes one complete, store-marked generation.
 * Consumers pin current, validate its marker, and fall back to REST when stale.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import { resolveStore } from '../store-context.js';
import * as s from '../db/schema.js';
import { selectUnitPrice, variantPriceRuleFromConfig, type VariantPriceRule } from '../money/pricing.js';
import { publishGeneration } from './publish.js';

const assetUrl = (path: string | null | undefined) => !path ? null : (/^(https?:\/\/|\/)/.test(path) ? path : `/assets/${path}`);
const selectPrice = (v: { price: number; salePrice: number | null; isPreOrder: boolean; preOrderPrice: number | null }, rule: VariantPriceRule) =>
  selectUnitPrice(v, rule);

function group<T, K>(arr: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of arr) {
    const k = key(x);
    (m.get(k) ?? m.set(k, []).get(k)!).push(x);
  }
  return m;
}

export async function publishCatalogManifest(args: { outDir: string; storeSlug: string }) {
  const now = new Date().toISOString();

  const store = await resolveStore(args.storeSlug);
  const priceRule = variantPriceRuleFromConfig(store.config);
  const { manifest, details } = await withStore(store.id, async (tx) => {
    const products = await tx.select().from(s.product)
      .where(and(eq(s.product.storeId, store.id), eq(s.product.status, 'active'), isNull(s.product.deletedAt))).orderBy(asc(s.product.name));
    const assetById = new Map((await tx.select({ id: s.asset.id, path: s.asset.path }).from(s.asset).where(eq(s.asset.storeId, store.id))).map((a) => [a.id, a.path]));
    const variants = await tx.select().from(s.productVariant).where(and(eq(s.productVariant.storeId, store.id), isNull(s.productVariant.deletedAt), eq(s.productVariant.enabled, true))).orderBy(asc(s.productVariant.sku));
    const variantsByProduct = group(variants, (v) => v.productId);
    const stockByVariant = new Map((await tx.select().from(s.stock).where(eq(s.stock.storeId, store.id))).map((st) => [st.variantId, st.onHand - st.allocated]));
    const vo = await tx.select({ variantId: s.variantOption.variantId, optionId: s.productOption.id, groupId: s.productOptionGroup.id, value: s.productOption.value, groupName: s.productOptionGroup.name })
      .from(s.variantOption)
      .innerJoin(s.productOption, eq(s.productOption.id, s.variantOption.optionId))
      .innerJoin(s.productOptionGroup, eq(s.productOptionGroup.id, s.productOption.groupId))
      .where(eq(s.variantOption.storeId, store.id));
    const optsByVariant = group(vo, (x) => x.variantId);
    const pa = await tx.select({ productId: s.productAsset.productId, path: s.asset.path, position: s.productAsset.position })
      .from(s.productAsset).innerJoin(s.asset, eq(s.asset.id, s.productAsset.assetId)).where(eq(s.productAsset.storeId, store.id)).orderBy(asc(s.productAsset.position));
    const assetsByProduct = group(pa, (x) => x.productId);

    const manifestProducts = [];
    const details = [];
    for (const p of products) {
      const vs = variantsByProduct.get(p.id) ?? [];
      const prices = vs.map((v) => selectPrice(v, priceRule));
      const min = prices.length ? Math.min(...prices) : 0;
      const max = prices.length ? Math.max(...prices) : 0;
      const inStock = vs.some((v) => v.fulfillmentType !== 'physical' || v.isPreOrder || (stockByVariant.get(v.id) ?? 0) > 0);
      const featured = assetUrl(p.featuredAssetId ? assetById.get(p.featuredAssetId) : null);
      const v0 = [...vs].sort((a, b) => selectPrice(a, priceRule) - selectPrice(b, priceRule))[0];
      const cf = { salePrice: v0?.salePrice ?? null, preOrderPrice: v0?.preOrderPrice ?? null, shipDate: v0?.shipDate ?? null, isPreOrder: v0?.isPreOrder ?? false };
      manifestProducts.push({
        id: p.slug, name: p.name, slug: p.slug,
        featuredAsset: featured ? { preview: featured } : null,
        priceRange: { min, max }, inStock, facetValues: (p.tags ?? []).map(name => ({ name, facetName: 'Tags' })), hasMultiplePrices: min !== max, customFields: cf,
      });
      details.push({
        lastUpdated: now, id: p.slug, name: p.name, slug: p.slug, description: p.description,
        featuredAsset: featured ? { preview: featured } : null,
        assets: (assetsByProduct.get(p.id) ?? []).map((a) => ({ preview: assetUrl(a.path) })),
        priceRange: { min, max }, facetValues: (p.tags ?? []).map(name => ({ name, facetName: 'Tags' })), hasMultiplePrices: min !== max, hasVariantAssets: false,
        variants: vs.map((v) => ({
          id: v.sku, name: v.name, sku: v.sku, priceWithTax: selectPrice(v, priceRule),
          options: (optsByVariant.get(v.id) ?? []).map((o) => ({ group: o.groupName, groupId: o.groupId, code: o.optionId, name: o.value })),
          assets: [],
          customFields: { salePrice: v.salePrice, preOrderPrice: v.preOrderPrice, shipDate: v.shipDate, isPreOrder: v.isPreOrder },
        })),
      });
    }
    return { manifest: { lastUpdated: now, totalItems: manifestProducts.length, defaultSort: 'name', products: manifestProducts }, details };
  });

  return publishGeneration({ ...args, manifest, details });
}
