/**
 * Catalog importer: Vendure (damned_vendure) -> SellRight (sellright_dev).
 *
 * Maps Vendure's integer PKs to our UUIDs, pulls names/slugs from *_translation
 * (en), prices from product_variant_price, and the DD variant custom fields
 * (salePrice / preOrderPrice / isPreOrder / shipDate). Idempotent: truncates the
 * catalog tables, then imports fresh inside one store-scoped transaction.
 *
 * Run on the box:
 *   SOURCE_DATABASE_URL=postgres://sellright:...@127.0.0.1:5433/damned_vendure \
 *   DATABASE_URL=postgres://sellright:...@127.0.0.1:5433/sellright_dev \
 *   corepack pnpm tsx src/import/catalog.ts
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';

const SOURCE_URL = process.env.SOURCE_DATABASE_URL;
if (!SOURCE_URL) throw new Error('SOURCE_DATABASE_URL is required (the damned_vendure clone)');
const LANG = 'en';
const STORE = { slug: 'damned', name: 'Damned Designs', currency: 'USD' };

const src = new Pool({ connectionString: SOURCE_URL });
const q = async (sql: string, params: unknown[] = []) => (await src.query(sql, params)).rows;

const lower = (v: string | null) => (v ?? 'image').toLowerCase();
function parseDate(v: string | null): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const CATALOG_TABLES = [
  'variant_asset', 'product_asset', 'collection_product', 'variant_option',
  'collection', 'product_variant', 'product_option', 'product_option_group',
  'product', 'asset', 'store',
];

async function main() {
  // Reset catalog (dev — re-runnable). TRUNCATE is table-level, not RLS-gated.
  await pool.query(`TRUNCATE ${CATALOG_TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);

  const storeId = randomUUID();
  const assetMap = new Map<number, string>();
  const productMap = new Map<number, string>();
  const groupMap = new Map<number, string>();
  const optionMap = new Map<number, string>();
  const variantMap = new Map<number, string>();
  const variantProduct = new Map<number, number>(); // vendure variantId -> vendure productId
  const collectionMap = new Map<number, string>();

  await withStore(storeId, async (tx) => {
    await tx.insert(s.store).values({ id: storeId, slug: STORE.slug, name: STORE.name, currency: STORE.currency });

    // --- assets ---
    for (const a of await q(`SELECT id, type, source, preview, width, height FROM asset`)) {
      const id = randomUUID();
      assetMap.set(a.id, id);
      await tx.insert(s.asset).values({
        id, storeId, type: lower(a.type), path: a.source ?? a.preview, width: a.width ?? null, height: a.height ?? null,
      });
    }

    // --- products (en, not deleted) ---
    for (const p of await q(
      `SELECT p.id, p.enabled, p."featuredAssetId" AS fa, pt.name, pt.slug, pt.description
       FROM product p JOIN product_translation pt ON pt."baseId"=p.id AND pt."languageCode"=$1
       WHERE p."deletedAt" IS NULL`, [LANG],
    )) {
      const id = randomUUID();
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
      const id = randomUUID();
      groupMap.set(g.id, id);
      await tx.insert(s.productOptionGroup).values({ id, storeId, productId, name: g.name });
    }

    // --- options ---
    for (const o of await q(
      `SELECT o.id, o."groupId" AS gid, ot.name
       FROM product_option o
       JOIN product_option_translation ot ON ot."baseId"=o.id AND ot."languageCode"=$1
       WHERE o."deletedAt" IS NULL`, [LANG],
    )) {
      const groupId = groupMap.get(o.gid);
      if (!groupId) continue;
      const id = randomUUID();
      optionMap.set(o.id, id);
      await tx.insert(s.productOption).values({ id, storeId, groupId, value: o.name });
    }

    // --- variants (en name, price, custom fields) ---
    for (const v of await q(
      `SELECT v.id, v."productId" AS pid, v.sku, v.enabled,
              vt.name, pvp.price,
              v."customFieldsSaleprice" AS sale, v."customFieldsPreorderprice" AS preprice,
              v."customFieldsIspreorder" AS ispre, v."customFieldsShipdate" AS shipdate
       FROM product_variant v
       LEFT JOIN product_variant_translation vt ON vt."baseId"=v.id AND vt."languageCode"=$1
       LEFT JOIN product_variant_price pvp ON pvp."variantId"=v.id
       WHERE v."deletedAt" IS NULL`, [LANG],
    )) {
      const productId = productMap.get(v.pid);
      if (!productId) continue; // variant of a deleted product
      const id = randomUUID();
      variantMap.set(v.id, id);
      variantProduct.set(v.id, v.pid);
      await tx.insert(s.productVariant).values({
        id, storeId, productId, sku: v.sku, name: v.name ?? v.sku, price: v.price ?? 0,
        salePrice: v.sale ?? null, preOrderPrice: v.preprice ?? null,
        isPreOrder: v.ispre ?? false, shipDate: parseDate(v.shipdate), enabled: v.enabled,
      });
    }

    // --- variant <-> option ---
    for (const vo of await q(`SELECT "productVariantId" AS vid, "productOptionId" AS oid FROM product_variant_options_product_option`)) {
      const variantId = variantMap.get(vo.vid);
      const optionId = optionMap.get(vo.oid);
      if (variantId && optionId) await tx.insert(s.variantOption).values({ variantId, optionId });
    }

    // --- collections (skip root; parent->null if parent is root) ---
    const rootRows = await q(`SELECT id FROM collection WHERE "isRoot"=true`);
    const rootIds = new Set<number>(rootRows.map((r) => r.id));
    const cols = await q(
      `SELECT c.id, c."parentId" AS parent, c.position, ct.name, ct.slug, ct.description
       FROM collection c JOIN collection_translation ct ON ct."baseId"=c.id AND ct."languageCode"=$1
       WHERE c."isRoot"=false ORDER BY c.position`, [LANG],
    );
    for (const c of cols) { collectionMap.set(c.id, randomUUID()); }
    for (const c of cols) {
      const parentId = c.parent && !rootIds.has(c.parent) ? collectionMap.get(c.parent) ?? null : null;
      await tx.insert(s.collection).values({
        id: collectionMap.get(c.id)!, storeId, slug: c.slug, name: c.name, description: c.description ?? null, parentId,
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
      await tx.insert(s.collectionProduct).values({ collectionId, productId });
    }

    // --- product <-> asset ---
    for (const pa of await q(`SELECT "productId" AS pid, "assetId" AS aid, position FROM product_asset`)) {
      const productId = productMap.get(pa.pid);
      const assetId = assetMap.get(pa.aid);
      if (productId && assetId) await tx.insert(s.productAsset).values({ productId, assetId, position: pa.position ?? 0 });
    }

    // --- variant <-> asset ---
    for (const va of await q(`SELECT "productVariantId" AS vid, "assetId" AS aid, position FROM product_variant_asset`)) {
      const variantId = variantMap.get(va.vid);
      const assetId = assetMap.get(va.aid);
      if (variantId && assetId) await tx.insert(s.variantAsset).values({ variantId, assetId, position: va.position ?? 0 });
    }

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      store: storeId,
      assets: assetMap.size, products: productMap.size, optionGroups: groupMap.size,
      options: optionMap.size, variants: variantMap.size, collections: collectionMap.size,
    }, null, 2));
  });

  await src.end();
  await pool.end();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
