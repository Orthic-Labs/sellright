/** Atomic Vendure migration phase. Invoke through import/run.ts. */
import * as s from '../db/schema.js';
import { parseDate } from './store.js';
import { optionalColumn } from './source-schema.js';
import { ASSET_KEY_SEGMENT } from './artifacts.js';
import { slugify } from '../lib/slug.js';

const lower = (v: string | null) => (v ?? 'image').toLowerCase();

/** Vendure action[] -> our promotion type+value. R24: a source promotion may
 *  carry a discount action AND a separate free_shipping action (DD's combined
 *  "10% off + free shipping" shape) — pick the discount action for
 *  type/value and report whether a free_shipping action rode along, so the
 *  caller can set promotion.freeShipping instead of dropping one benefit. */
export function actionToTypeValue(actions: Array<{ code: string; args?: Array<{ name: string; value: string }> }>): { type: 'percentage' | 'fixed' | 'free_shipping'; value: number; freeShipping: boolean } | null {
  const discount = actions.find((x) => x.code === 'order_percentage_discount' || x.code === 'order_fixed_discount');
  const freeShipping = actions.some((x) => x.code === 'free_shipping');
  const a = discount ?? actions[0];
  if (!a) return null;
  const arg = (n: string) => a.args?.find((x) => x.name === n)?.value;
  if (a.code === 'order_percentage_discount') return { type: 'percentage', value: Number(arg('discount') ?? 0), freeShipping };
  if (a.code === 'order_fixed_discount') return { type: 'fixed', value: Number(arg('amount') ?? 0), freeShipping };
  if (a.code === 'free_shipping') return { type: 'free_shipping', value: 0, freeShipping: false };
  return null;
}

import type { ImportContext } from './context.js';

type SourceAction = { code: string; args?: Array<{ name: string; value: string }> };
const DISCOUNT_ACTIONS = new Set(['order_percentage_discount', 'order_fixed_discount']);

/** How a source promotion's action list maps onto the single-action target
 *  model. Exported for unit tests. */
export function classifyPromotionActions(actions: SourceAction[]): 'single' | 'account_credit' | 'multi_action' | 'unsupported' {
  if (!Array.isArray(actions) || actions.length === 0) return 'unsupported';
  if (actions.some((a) => a?.code === 'account_credit_discount')) return 'account_credit';
  if (actions.length === 1) return 'single';
  const codes = actions.map((a) => a?.code);
  const discounts = codes.filter((c) => DISCOUNT_ACTIONS.has(c)).length;
  const freeShipping = codes.filter((c) => c === 'free_shipping').length;
  if (actions.length === 2 && discounts === 1 && freeShipping === 1) return 'multi_action';
  return 'unsupported';
}

// ── de-Vendure: promotion condition translation ─────────────────────────────
// The source's ONLY item-targeting promotion condition is
// `at_least_n_with_facets`, which names facet VALUE ids directly. Native
// conditions (money/coupon.ts) target collections/products/tags instead —
// runtime never resolves a facet id. The importer (which may know Vendure)
// resolves each referenced facet value into a native collection up front
// (see importCatalog below) and this pure function rewrites the condition
// shape once that facet-value -> collection-id map is known.
export type SourceCondition = { code: string; args?: Array<{ name: string; value: string }> };

export function parseFacetIdsArg(condition: SourceCondition): string[] {
  const raw = condition.args?.find((a) => a.name === 'facets')?.value;
  try {
    const parsed = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function translatePromotionConditions(
  conditions: SourceCondition[],
  facetToCollectionId: Map<string, string>,
): SourceCondition[] {
  return conditions.map((condition) => {
    if (condition.code !== 'at_least_n_with_facets') return condition;
    const minimum = condition.args?.find((a) => a.name === 'minimum')?.value ?? '1';
    const collectionIds = parseFacetIdsArg(condition)
      .map((fid) => facetToCollectionId.get(fid))
      .filter((id): id is string => !!id);
    return { code: 'at_least_n_in_collections', args: [{ name: 'minimum', value: minimum }, { name: 'collectionIds', value: JSON.stringify(collectionIds) }] };
  });
}

/** Every native product id (post-import uuid) carrying a given source facet
 *  value, whether the association was on the product or on one of its
 *  variants — matches the source's exact eligibility set, not just the
 *  PUBLIC-facet subset that becomes `product.tags`. */
function productIdsForFacetValue(
  fid: string,
  productFacets: Array<Record<string, unknown>>,
  variantFacets: Array<Record<string, unknown>>,
  variantProduct: Map<number, number>,
  productMap: Map<number, string>,
): string[] {
  const pids = new Set<number>();
  for (const pf of productFacets) if (String(pf.fid) === fid) pids.add(Number(pf.pid));
  for (const vf of variantFacets) {
    if (String(vf.fid) !== fid) continue;
    const pid = variantProduct.get(Number(vf.vid));
    if (pid !== undefined) pids.add(pid);
  }
  const out: string[] = [];
  for (const pid of pids) {
    const mapped = productMap.get(pid);
    if (mapped) out.push(mapped);
  }
  return out;
}

export async function importCatalog(ctx: ImportContext): Promise<void> {
  const { tx, q } = ctx;
  const LANG = 'en';
  const storeId = ctx.storeId;
  const assetMap = new Map<number, string>();
  const productMap = new Map<number, string>();
  const groupMap = new Map<string, string>();
  const optionMap = new Map<string, string>();
  const variantMap = new Map<number, string>();
  const variantProduct = new Map<number, number>(); // vendure variantId -> vendure productId
  const collectionMap = new Map<number, string>();
  const usedSku = new Set<string>();
  const skuCollisions: { original: string; assigned: string; vendureVariantId: number }[] = [];

  {

    // --- assets ---
    for (const a of await q(`SELECT id, type, source, preview, width, height FROM asset`)) {
      const id = ctx.id('asset', a.id);
      assetMap.set(a.id, id);
      await tx.insert(s.asset).values({
        // store the PREVIEW path (what the storefront/manifest displays), not source
        id, storeId, type: lower(a.type), path: storeId + '/' + ASSET_KEY_SEGMENT + '/' + (a.preview ?? a.source), width: a.width ?? null, height: a.height ?? null,
      });
    }

    // Public source facets become native browse tags; private facets stay private.
    const publicTags = await q(`SELECT links.pid, fvt.name FROM (
      SELECT "productId" AS pid, "facetValueId" AS fid FROM product_facet_values_facet_value
      UNION
      SELECT pv."productId" AS pid, links."facetValueId" AS fid
      FROM product_variant_facet_values_facet_value links
      JOIN product_variant pv ON pv.id = links."productVariantId"
      WHERE pv."deletedAt" IS NULL AND pv.enabled = true
    ) links JOIN facet_value fv ON fv.id = links.fid
    JOIN facet f ON f.id = fv."facetId" AND f."isPrivate" = false
    JOIN facet_value_translation fvt ON fvt."baseId" = fv.id AND fvt."languageCode" = $1`, [LANG]);
    const tagsByProduct = new Map<number, Set<string>>();
    for (const tag of publicTags) {
      const values = tagsByProduct.get(tag.pid) ?? new Set<string>();
      values.add(tag.name);
      tagsByProduct.set(tag.pid, values);
    }
    // --- products (en, not deleted) ---
    for (const p of await q(
      `SELECT p.id, p.enabled, p."featuredAssetId" AS fa, pt.name, pt.slug, pt.description
       FROM product p JOIN product_translation pt ON pt."baseId"=p.id AND pt."languageCode"=$1
       WHERE p."deletedAt" IS NULL`, [LANG],
    )) {
      const id = ctx.id('product', p.id);
      productMap.set(p.id, id);
      await tx.insert(s.product).values({
        id, storeId, slug: p.slug, name: p.name, description: p.description ?? null,
        status: p.enabled ? 'active' : 'draft',
        featuredAssetId: p.fa ? assetMap.get(p.fa) ?? null : null,
        tags: [...(tagsByProduct.get(p.id) ?? [])].sort(),
      });
    }

    // --- option groups (linked to products) ---
    for (const g of await q(
      `SELECT g.id, l."productId" AS pid, gt.name
       FROM product_option_group g
       JOIN product_option_groups_product_option_group l ON l."productOptionGroupId"=g.id
       JOIN product_option_group_translation gt ON gt."baseId"=g.id AND gt."languageCode"=$1
       WHERE g."deletedAt" IS NULL`, [LANG],
    )) {
      const productId = productMap.get(g.pid);
      if (!productId) continue;
      const id = ctx.id('option-group', g.pid + ':' + g.id);
      groupMap.set(g.pid + ':' + g.id, id);
      await tx.insert(s.productOptionGroup).values({ id, storeId, productId, name: g.name });
    }

    // --- options ---
    for (const o of await q(
      `SELECT o.id, o."groupId" AS gid, l."productId" AS pid, ot.name
       FROM product_option o
       JOIN product_option_groups_product_option_group l ON l."productOptionGroupId"=o."groupId"
       JOIN product_option_translation ot ON ot."baseId"=o.id AND ot."languageCode"=$1
       WHERE o."deletedAt" IS NULL`, [LANG],
    )) {
      const groupId = groupMap.get(o.pid + ':' + o.gid);
      if (!groupId) continue;
      const id = ctx.id('option', o.pid + ':' + o.id);
      optionMap.set(o.pid + ':' + o.id, id);
      await tx.insert(s.productOption).values({ id, storeId, groupId, value: o.name });
    }

    const [global] = await q('SELECT "trackInventory", "outOfStockThreshold" FROM global_settings');
    const variantFacets = await q('SELECT "productVariantId" AS vid, "facetValueId" AS fid FROM product_variant_facet_values_facet_value');
    const productFacets = await q('SELECT "productId" AS pid, "facetValueId" AS fid FROM product_facet_values_facet_value');
    // SR-08: per-store variant custom fields (DD declares salePrice,
    // isPreOrder, preOrderPrice, shipDate; RH declares salePrice only). Select
    // NULL for the fields a source does not declare.
    const vf = (column: string, alias: string) => optionalColumn(ctx.sourceColumns, 'product_variant', column, 'v', alias);
    // --- variants (en name, price, custom fields) ---
    for (const v of await q(
      `SELECT v.id, v."productId" AS pid, v.sku, v.enabled, v."trackInventory", v."useGlobalOutOfStockThreshold", v."outOfStockThreshold",
              vt.name, pvp.price,
              ${vf('customFieldsSaleprice', 'sale')}, ${vf('customFieldsPreorderprice', 'preprice')},
              ${vf('customFieldsIspreorder', 'ispre')}, ${vf('customFieldsShipdate', 'shipdate')}
       FROM product_variant v
       LEFT JOIN product_variant_translation vt ON vt."baseId"=v.id AND vt."languageCode"=$1
       LEFT JOIN product_variant_price pvp ON pvp."variantId"=v.id AND pvp."channelId"=$2 AND pvp."currencyCode"=$3
       WHERE v."deletedAt" IS NULL ORDER BY v.id`, [LANG, ctx.channelId, ctx.currency],
    )) {
      const productId = productMap.get(v.pid);
      if (!productId) continue; // variant of a deleted product
      const tracked = v.trackInventory === 'INHERIT' ? global?.trackInventory : v.trackInventory === 'TRUE';
      const threshold = v.useGlobalOutOfStockThreshold ? global?.outOfStockThreshold : v.outOfStockThreshold;
      if (tracked !== true || Number(threshold) !== 0) throw new Error('Source inventory tracking/threshold needs explicit mapping: ' + v.id);
      if (v.price == null) throw new Error('Missing channel/currency price for source variant ' + v.id);
      const id = ctx.id('variant', v.id);
      variantMap.set(v.id, id);
      variantProduct.set(v.id, v.pid);
      // DD source has duplicate SKUs (Vendure doesn't enforce uniqueness; we do).
      // Suffix collisions so import succeeds + stays unique; report them for cleanup.
      let sku: string = v.sku;
      if (usedSku.has(sku)) {
        const assigned = `${sku}__dup${v.id}`;
        skuCollisions.push({ original: sku, assigned, vendureVariantId: v.id });
        sku = assigned;
      }
      usedSku.add(sku);
      await tx.insert(s.productVariant).values({
        // De-Vendure: `facetValueIds` used to ride along here purely so
        // runtime coupon eval (money/coupon.ts) could read it back via
        // productFacetIds(). Coupon eligibility is now resolved through native
        // collections (see the promotions block below) — vendureId/originalSku
        // stay (import provenance, unrelated to facets).
        id, storeId, productId, sku, name: v.name ?? v.sku, price: v.price ?? 0,
        metafields: { vendureId: v.id, originalSku: v.sku },
        salePrice: v.sale ?? null, preOrderPrice: v.preprice ?? null,
        isPreOrder: v.ispre ?? false, shipDate: parseDate(v.shipdate), enabled: v.enabled,
      });
    }

    // --- variant <-> option ---
    for (const vo of await q(`SELECT "productVariantId" AS vid, "productOptionId" AS oid FROM product_variant_options_product_option`)) {
      const variantId = variantMap.get(vo.vid);
      const optionId = optionMap.get(variantProduct.get(vo.vid) + ':' + vo.oid);
      if (variantId && optionId) await tx.insert(s.variantOption).values({ storeId, variantId, optionId });
    }

    // --- stock levels (preserve on-hand and allocated across locations) ---
    const vids = [...variantMap.keys()];
    if (vids.length) {
      const stockRows = (
        await q(
          `SELECT "productVariantId" AS vid, sum("stockOnHand")::int AS onhand, sum("stockAllocated")::int AS allocated
           FROM stock_level WHERE "productVariantId" = ANY($1) GROUP BY "productVariantId"`,
          [vids],
        )
      )
        .map((sl) => {
          const variantId = variantMap.get(sl.vid);
          return variantId ? { variantId, storeId, onHand: sl.onhand ?? 0, allocated: sl.allocated ?? 0 } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      if (stockRows.length) await tx.insert(s.stock).values(stockRows);
    }

    // --- promotions (coupon-code based) ---
    // account_credit_discount promotions (the source's old store-credit
    // mechanism — balances move to the points ledger in import/loyalty.ts)
    // are recorded as a reviewed exclusion instead of failing the run.
    // R24: multi-action promotions (a discount action PLUS a free_shipping
    // action) are now imported faithfully — actionToTypeValue picks the
    // discount for type/value and promotion.freeShipping carries the
    // free-shipping benefit, instead of dropping it.
    let promoCount = 0;
    const skippedCredit: string[] = [];
    const promoRows = await q(
      `SELECT id, "couponCode" AS code, conditions, actions, "startsAt" AS starts, "endsAt" AS ends,
              "usageLimit" AS uselimit, "perCustomerUsageLimit" AS percust, "priorityScore" AS prio
       FROM promotion WHERE enabled = true AND "deletedAt" IS NULL `,
    );

    // De-Vendure (item-targeting coupon conditions): `at_least_n_with_facets`
    // names source facet VALUE ids directly — never a native concept, and the
    // one thing money/coupon.ts's runtime evaluator must not read anymore.
    // Resolve every facet value any promotion's condition references into a
    // synthetic, UNPUBLISHED native collection (not a browsable category —
    // purely a coupon-eligibility set) containing every product that carried
    // it, product- or variant-level, public or private (this must match the
    // source's exact eligibility set, which is not limited to the public
    // subset that becomes `product.tags`). `translatePromotionConditions`
    // then rewrites the condition to native `at_least_n_in_collections`.
    const referencedFacetValueIds = new Set<string>();
    for (const pr of promoRows) {
      const conditions = typeof pr.conditions === 'string' ? JSON.parse(pr.conditions) : pr.conditions;
      if (!Array.isArray(conditions)) continue;
      for (const condition of conditions) {
        if (condition?.code === 'at_least_n_with_facets') for (const fid of parseFacetIdsArg(condition)) referencedFacetValueIds.add(fid);
      }
    }
    const facetToCollectionId = new Map<string, string>();
    if (referencedFacetValueIds.size) {
      // Only `facet_value`/`facet_value_translation` are load-bearing here —
      // the facet GROUP name (e.g. "Steel") isn't needed for eligibility and
      // isn't guaranteed translatable in every source, so the collection is
      // named/slugged from the facet value alone. The facet value's own
      // source id is folded into the slug, which makes it unique by
      // construction (one row per distinct id here) with no DB round trip.
      const fvRows = await q(
        `SELECT fv.id, fvt.name AS value_name
         FROM facet_value fv
         JOIN facet_value_translation fvt ON fvt."baseId" = fv.id AND fvt."languageCode" = $1
         WHERE fv.id = ANY($2)`,
        [LANG, [...referencedFacetValueIds].map(Number)],
      );
      for (const fv of fvRows) {
        const fid = String(fv.id);
        const productIds = productIdsForFacetValue(fid, productFacets, variantFacets, variantProduct, productMap);
        // No surviving product carries this facet value (e.g. only deleted
        // products had it) — the condition ends up with an empty
        // collectionIds array, i.e. it always fails closed. That mirrors the
        // source behavior faithfully (nothing was eligible there either).
        if (!productIds.length) continue;
        const collectionId = ctx.id('facet-eligibility-collection', fid);
        await tx.insert(s.collection).values({
          id: collectionId, storeId, slug: slugify(`promo-eligible-${fv.value_name}-${fid}`), name: `Promo eligibility: ${fv.value_name}`,
          description: 'Auto-created during migration for coupon eligibility — not a browsable category.',
          published: false,
        });
        for (const productId of productIds) await tx.insert(s.collectionProduct).values({ storeId, collectionId, productId });
        facetToCollectionId.set(fid, collectionId);
      }
    }

    // R24: multi-action promotions (a discount action PLUS a free_shipping
    // action) are now imported faithfully — actionToTypeValue picks the
    // discount for type/value and promotion.freeShipping carries the
    // free-shipping benefit, instead of dropping it.
    for (const pr of promoRows) {
      const actions = typeof pr.actions === 'string' ? JSON.parse(pr.actions) : pr.actions;
      const shape = classifyPromotionActions(actions);
      if (shape === 'account_credit') { skippedCredit.push(String(pr.id)); continue; }
      if (shape === 'unsupported') throw new Error('Unsupported promotion action: ' + pr.id);
      const tv = actionToTypeValue(actions);
      if (!tv) throw new Error('Unsupported promotion action: ' + pr.id);
      const sourceConditions = typeof pr.conditions === 'string' ? JSON.parse(pr.conditions) : pr.conditions;
      if (!Array.isArray(sourceConditions) || sourceConditions.some((condition: { code: string }) =>
        !['minimum_order_amount', 'verified_customer', 'at_least_n_with_facets'].includes(condition.code))) {
        throw new Error('Unsupported promotion condition: ' + pr.id);
      }
      const conditions = translatePromotionConditions(sourceConditions, facetToCollectionId);
      await tx.insert(s.promotion).values({
        id: ctx.id('promotion', pr.id), storeId, code: pr.code, type: tv.type, value: tv.value, freeShipping: tv.freeShipping, conditions,
        startsAt: parseDate(pr.starts), endsAt: parseDate(pr.ends),
        usageLimit: pr.uselimit ?? null, perCustomerUsageLimit: pr.percust ?? null,
        priority: pr.prio ?? 0, enabled: true,
      });
      promoCount++;
    }
    if (skippedCredit.length) ctx.exclusions.push({ type: 'unmappable-source-row', table: 'promotion',
      detail: `account_credit_discount promotions skipped (legacy store-credit mechanism; balances import as loyalty points): ${skippedCredit.join(',')}`,
      count: skippedCredit.length });

    // --- collections (skip root; parent->null if parent is root) ---
    const rootRows = await q(`SELECT id FROM collection WHERE "isRoot"=true`);
    const rootIds = new Set<number>(rootRows.map((r) => r.id));
    const cols = await q(
      `SELECT c.id, c."parentId" AS parent, c.position, c."isPrivate", c."featuredAssetId", ct.name, ct.slug, ct.description
       FROM collection c JOIN collection_translation ct ON ct."baseId"=c.id AND ct."languageCode"=$1
       WHERE c."isRoot"=false ORDER BY c.position`, [LANG],
    );
    const depth = (row: (typeof cols)[number]) => {
      const seen = new Set<number>();
      let current = row;
      while (current.parent && !rootIds.has(current.parent)) {
        if (seen.has(current.id)) throw new Error('Cyclic source collection hierarchy');
        seen.add(current.id);
        const parent = cols.find(c => c.id === current.parent);
        if (!parent) throw new Error('Missing collection parent');
        current = parent;
      }
      return seen.size;
    };
    cols.sort((a, b) => depth(a) - depth(b) || a.position - b.position || a.id - b.id);
    for (const c of cols) { collectionMap.set(c.id, ctx.id('collection', c.id)); }
    for (const c of cols) {
      const parentId = c.parent && !rootIds.has(c.parent) ? collectionMap.get(c.parent) ?? null : null;
      await tx.insert(s.collection).values({
        id: collectionMap.get(c.id)!, storeId, slug: c.slug, name: c.name, description: c.description ?? null, parentId, published: !c.isPrivate, imageAssetId: assetMap.get(c.featuredAssetId) ?? null,
      });
    }

    // --- collection <-> product (Vendure links via variants; collapse to distinct products) ---
    const seen = new Set<string>();
    for (const cv of await q(`SELECT "collectionId" AS cid, "productVariantId" AS vid FROM collection_product_variants_product_variant`)) {
      const collectionId = collectionMap.get(cv.cid);
      const pid = variantProduct.get(cv.vid);
      const productId = pid ? productMap.get(pid) : undefined;
      if (!collectionId || !productId) continue;
      const key = `${collectionId}:${productId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await tx.insert(s.collectionProduct).values({ storeId, collectionId, productId });
    }

    // --- product <-> asset ---
    for (const pa of await q(`SELECT "productId" AS pid, "assetId" AS aid, position FROM product_asset`)) {
      const productId = productMap.get(pa.pid);
      const assetId = assetMap.get(pa.aid);
      if (productId && assetId) await tx.insert(s.productAsset).values({ storeId, productId, assetId, position: pa.position ?? 0 });
    }

    // --- variant <-> asset ---
    for (const va of await q(`SELECT "productVariantId" AS vid, "assetId" AS aid, position FROM product_variant_asset`)) {
      const variantId = variantMap.get(va.vid);
      const assetId = assetMap.get(va.aid);
      if (variantId && assetId) await tx.insert(s.variantAsset).values({ storeId, variantId, assetId, position: va.position ?? 0 });
    }

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      store: storeId,
      assets: assetMap.size, products: productMap.size, optionGroups: groupMap.size,
      options: optionMap.size, variants: variantMap.size, collections: collectionMap.size,
      promotions: promoCount, skuCollisions: skuCollisions.length,
    }, null, 2));
    if (skuCollisions.length) {
      // eslint-disable-next-line no-console
      console.log('DUPLICATE SKUs in DD source (fix in Vendure; suffixed on import):\n' + JSON.stringify(skuCollisions, null, 2));
    }
  }

}
