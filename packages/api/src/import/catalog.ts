/** Atomic Vendure migration phase. Invoke through import/run.ts. */
import * as s from '../db/schema.js';
import { parseDate } from './store.js';

const lower = (v: string | null) => (v ?? 'image').toLowerCase();

/** Vendure action[] -> our promotion type+value (DD uses a single action). */
function actionToTypeValue(actions: Array<{ code: string; args?: Array<{ name: string; value: string }> }>): { type: 'percentage' | 'fixed' | 'free_shipping'; value: number } | null {
  const a = actions[0];
  if (!a) return null;
  const arg = (n: string) => a.args?.find((x) => x.name === n)?.value;
  if (a.code === 'order_percentage_discount') return { type: 'percentage', value: Number(arg('discount') ?? 0) };
  if (a.code === 'order_fixed_discount') return { type: 'fixed', value: Number(arg('amount') ?? 0) };
  if (a.code === 'free_shipping') return { type: 'free_shipping', value: 0 };
  return null;
}

import type { ImportContext } from './context.js';

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
        id, storeId, type: lower(a.type), path: storeId + '/vendure/' + (a.preview ?? a.source), width: a.width ?? null, height: a.height ?? null,
      });
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
    // --- variants (en name, price, custom fields) ---
    for (const v of await q(
      `SELECT v.id, v."productId" AS pid, v.sku, v.enabled, v."trackInventory", v."useGlobalOutOfStockThreshold", v."outOfStockThreshold",
              vt.name, pvp.price,
              v."customFieldsSaleprice" AS sale, v."customFieldsPreorderprice" AS preprice,
              v."customFieldsIspreorder" AS ispre, v."customFieldsShipdate" AS shipdate
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
    let promoCount = 0;
    for (const pr of await q(
      `SELECT id, "couponCode" AS code, conditions, actions, "startsAt" AS starts, "endsAt" AS ends,
              "usageLimit" AS uselimit, "perCustomerUsageLimit" AS percust, "priorityScore" AS prio
       FROM promotion WHERE enabled = true AND "deletedAt" IS NULL `,
    )) {
      const actions = typeof pr.actions === 'string' ? JSON.parse(pr.actions) : pr.actions;
      const tv = actionToTypeValue(actions);
      if (!tv || actions.length !== 1) throw new Error('Unsupported promotion action: ' + pr.id);
      const conditions = typeof pr.conditions === 'string' ? JSON.parse(pr.conditions) : pr.conditions;
      if (!Array.isArray(conditions) || conditions.some((condition: { code: string }) =>
        !['minimum_order_amount', 'verified_customer', 'at_least_n_with_facets'].includes(condition.code))) {
        throw new Error('Unsupported promotion condition: ' + pr.id);
      }
      await tx.insert(s.promotion).values({
        id: ctx.id('promotion', pr.id), storeId, code: pr.code, type: tv.type, value: tv.value, conditions,
        startsAt: parseDate(pr.starts), endsAt: parseDate(pr.ends),
        usageLimit: pr.uselimit ?? null, perCustomerUsageLimit: pr.percust ?? null,
        priority: pr.prio ?? 0, enabled: true,
      });
      promoCount++;
    }

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
