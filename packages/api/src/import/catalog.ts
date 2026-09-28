/** Atomic Vendure migration phase. Invoke through import/run.ts. */
import * as s from '../db/schema.js';
import { parseDate } from './store.js';
import { optionalColumn } from './source-schema.js';
import { ASSET_KEY_SEGMENT } from './artifacts.js';

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
    // Ordering: Vendure's core schema carries no explicit sortOrder on
    // product_option_group/product_option (unlike e.g. collection.position,
    // which IS selected explicitly elsewhere in this file) — this is the
    // ONE place in the codebase allowed to know that. `g.id`/`o.id` ascending
    // is the best available proxy for "source insertion order": Vendure's
    // default id strategy is an auto-increment integer, so ascending id
    // tracks creation order. `ORDER BY l."productId", g.id` keeps each
    // product's groups contiguous so the running per-product counter below
    // assigns 0..n-1 in that order; same shape per-group for options.
    const groupPosition = new Map<number, number>(); // vendure productId -> next position
    for (const g of await q(
      `SELECT g.id, l."productId" AS pid, gt.name
       FROM product_option_group g
       JOIN product_option_groups_product_option_group l ON l."productOptionGroupId"=g.id
       JOIN product_option_group_translation gt ON gt."baseId"=g.id AND gt."languageCode"=$1
       WHERE g."deletedAt" IS NULL
       ORDER BY l."productId", g.id`, [LANG],
    )) {
      const productId = productMap.get(g.pid);
      if (!productId) continue;
      const id = ctx.id('option-group', g.pid + ':' + g.id);
      groupMap.set(g.pid + ':' + g.id, id);
      const position = groupPosition.get(g.pid) ?? 0;
      groupPosition.set(g.pid, position + 1);
      await tx.insert(s.productOptionGroup).values({ id, storeId, productId, name: g.name, position });
    }

    // --- options ---
    const optionPosition = new Map<string, number>(); // "pid:gid" -> next position
    for (const o of await q(
      `SELECT o.id, o."groupId" AS gid, l."productId" AS pid, ot.name
       FROM product_option o
       JOIN product_option_groups_product_option_group l ON l."productOptionGroupId"=o."groupId"
       JOIN product_option_translation ot ON ot."baseId"=o.id AND ot."languageCode"=$1
       WHERE o."deletedAt" IS NULL
       ORDER BY l."productId", o."groupId", o.id`, [LANG],
    )) {
      const groupId = groupMap.get(o.pid + ':' + o.gid);
      if (!groupId) continue;
      const id = ctx.id('option', o.pid + ':' + o.id);
      optionMap.set(o.pid + ':' + o.id, id);
      const posKey = o.pid + ':' + o.gid;
      const position = optionPosition.get(posKey) ?? 0;
      optionPosition.set(posKey, position + 1);
      await tx.insert(s.productOption).values({ id, storeId, groupId, value: o.name, position });
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
        id, storeId, productId, sku, name: v.name ?? v.sku, price: v.price ?? 0,
        metafields: { vendureId: v.id, originalSku: v.sku, facetValueIds: [...new Set([
          ...variantFacets.filter(f => f.vid === v.id).map(f => String(f.fid)),
          ...productFacets.filter(f => f.pid === v.pid).map(f => String(f.fid)),
        ])] },
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
    for (const pr of await q(
      `SELECT id, "couponCode" AS code, conditions, actions, "startsAt" AS starts, "endsAt" AS ends,
              "usageLimit" AS uselimit, "perCustomerUsageLimit" AS percust, "priorityScore" AS prio
       FROM promotion WHERE enabled = true AND "deletedAt" IS NULL `,
    )) {
      const actions = typeof pr.actions === 'string' ? JSON.parse(pr.actions) : pr.actions;
      const shape = classifyPromotionActions(actions);
      if (shape === 'account_credit') { skippedCredit.push(String(pr.id)); continue; }
      if (shape === 'unsupported') throw new Error('Unsupported promotion action: ' + pr.id);
      const tv = actionToTypeValue(actions);
      if (!tv) throw new Error('Unsupported promotion action: ' + pr.id);
      const conditions = typeof pr.conditions === 'string' ? JSON.parse(pr.conditions) : pr.conditions;
      if (!Array.isArray(conditions) || conditions.some((condition: { code: string }) =>
        !['minimum_order_amount', 'verified_customer', 'at_least_n_with_facets'].includes(condition.code))) {
        throw new Error('Unsupported promotion condition: ' + pr.id);
      }
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
