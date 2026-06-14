/**
 * Consolidate the 5 per-app Right Apps stores into ONE multi-tenant 'rightapps'
 * store. Per-app product feeds come from a collection per app; the variant
 * `appKey` records which app each license belongs to. The shared storefront
 * resolves the app by Host -> requests that collection -> themes per brand.
 *
 * Usage (on the box, owner role against the rightapps DB):
 *   set -a; . ~/.sellright/env; set +a
 *   OWNER_RA="${DATABASE_URL_OWNER/\/sellright_dev/\/rightapps}"
 *   cd ~/sites/rightapps/packages/api
 *   DATABASE_URL="$OWNER_RA" ADMIN_EMAIL=adrdsouza@gmail.com pnpm exec tsx src/scripts/consolidate-stores.ts
 *
 * Idempotent: store/products/variants/collections are upserted; old stores are
 * deleted only when they have ZERO orders (safety guard).
 */
import { eq, inArray } from 'drizzle-orm';
import { unsafeUnscopedDb as db, withStore, pool } from '../db/client.js';
import * as s from '../db/schema.js';
import { normalizeEmail } from '../auth/email.js';

const TARGET = { slug: 'rightapps', name: 'RightApps' };
const OLD_STORE_SLUGS = ['heardright', 'viewright', 'mailright', 'coderight', 'scraperight'];

type VariantSeed = {
  sku: string; name: string; price: number;
  fulfillmentType: 'physical' | 'digital_download' | 'license' | 'update_pass';
  appKey: string; licenseSeats: number;
  licenseDurationDays?: number; updatesDurationDays?: number;
  metafields?: Record<string, unknown>;
};
type ProductSeed = { slug: string; name: string; description: string; collection: string; variants: VariantSeed[] };

const COLLECTIONS = [
  { slug: 'heardright', name: 'HeardRight' },
  { slug: 'viewright', name: 'ViewRight' },
  { slug: 'mailright', name: 'MailRight' },
  { slug: 'coderight', name: 'CodeRight' },
];

const PRODUCTS: ProductSeed[] = [
  {
    slug: 'heardright-pro', name: 'HeardRight Pro', collection: 'heardright',
    description: 'Wake word, 100+ voice commands, and BYOK AI services. One-time perpetual license.',
    variants: [{ sku: 'HR-PRO', name: 'Founders Lifetime', price: 6900, fulfillmentType: 'license', appKey: 'heardright', licenseSeats: 1, metafields: { standardPriceCents: 9900, tier: 'pro', founders: true } }],
  },
  {
    slug: 'viewright-personal', name: 'ViewRight — Personal', collection: 'viewright',
    description: 'Lifetime update access for 2 devices. The app is free; this unlocks the signed in-app update channel.',
    variants: [{ sku: 'VR-PERSONAL', name: 'Personal — Lifetime Updates', price: 1500, fulfillmentType: 'update_pass', appKey: 'viewright', licenseSeats: 2, updatesDurationDays: 36500, metafields: { standardPriceCents: 2900, tier: 'personal', founders: true } }],
  },
  {
    slug: 'viewright-household', name: 'ViewRight — Household', collection: 'viewright',
    description: 'Lifetime update access for 5 devices. For a household or a few machines.',
    variants: [{ sku: 'VR-HOUSEHOLD', name: 'Household — Lifetime Updates', price: 3900, fulfillmentType: 'update_pass', appKey: 'viewright', licenseSeats: 5, updatesDurationDays: 36500, metafields: { standardPriceCents: 5900, tier: 'household', founders: true } }],
  },
  {
    slug: 'mailright', name: 'MailRight Pro', collection: 'mailright',
    description: 'Native Gmail + Workspace desktop client with BYOK AI. One license — pick your term. No auto-renew.',
    variants: [
      { sku: 'MR-1YR', name: '1 Year', price: 2900, fulfillmentType: 'license', appKey: 'mailright', licenseSeats: 1, licenseDurationDays: 365, updatesDurationDays: 365, metafields: { term: '1yr', perYearCents: 2900 } },
      { sku: 'MR-3YR', name: '3 Years', price: 6900, fulfillmentType: 'license', appKey: 'mailright', licenseSeats: 1, licenseDurationDays: 1095, updatesDurationDays: 1095, metafields: { term: '3yr', perYearCents: 2300 } },
      { sku: 'MR-5YR', name: '5 Years', price: 10900, fulfillmentType: 'license', appKey: 'mailright', licenseSeats: 1, licenseDurationDays: 1825, updatesDurationDays: 1825, metafields: { term: '5yr', perYearCents: 2180 } },
      { sku: 'MR-DECADE', name: 'Decade', price: 19900, fulfillmentType: 'license', appKey: 'mailright', licenseSeats: 1, licenseDurationDays: 3650, updatesDurationDays: 3650, metafields: { term: 'decade', perYearCents: 1990 } },
    ],
  },
  {
    slug: 'coderight-pro', name: 'CodeRight Pro', collection: 'coderight',
    description: 'Low-RAM, model-agnostic, multi-agent coding desktop app. BYOK. One-time perpetual license.',
    variants: [{ sku: 'CR-PRO', name: 'Founders Lifetime', price: 9900, fulfillmentType: 'license', appKey: 'coderight', licenseSeats: 1, metafields: { standardPriceCents: 14900, tier: 'pro', founders: true } }],
  },
];

async function main() {
  const adminEmail = process.env.ADMIN_EMAIL ? normalizeEmail(process.env.ADMIN_EMAIL) : null;

  // 1) upsert the single target store
  const [store] = await db
    .insert(s.store)
    .values({ slug: TARGET.slug, name: TARGET.name, currency: 'USD', config: { payments: { stripe: true, manual: false, cod: false } } })
    .onConflictDoUpdate({ target: s.store.slug, set: { name: TARGET.name, currency: 'USD', updatedAt: new Date() } })
    .returning({ id: s.store.id, slug: s.store.slug });
  const storeId = store!.id;
  console.log(`[consolidate] target store ready: ${store!.slug} (${storeId})`);

  // 2) grant admin owner on the target store
  if (adminEmail) {
    const [admin] = await db.select({ id: s.adminUser.id }).from(s.adminUser).where(eq(s.adminUser.email, adminEmail)).limit(1);
    if (!admin) { console.error(`[consolidate] admin not found: ${adminEmail}`); process.exit(2); }
    await db.insert(s.adminUserStore).values({ adminUserId: admin.id, storeId, role: 'owner' })
      .onConflictDoUpdate({ target: [s.adminUserStore.adminUserId, s.adminUserStore.storeId], set: { role: 'owner' } });
    console.log(`[consolidate] owner grant: ${adminEmail} -> ${TARGET.slug}`);
  }

  // 3) products + variants + collections (RLS-scoped to the target store)
  await withStore(storeId, async (tx) => {
    // collections
    const colId = new Map<string, string>();
    for (const col of COLLECTIONS) {
      let [row] = await tx.select({ id: s.collection.id }).from(s.collection).where(eq(s.collection.slug, col.slug)).limit(1);
      if (!row) [row] = await tx.insert(s.collection).values({ storeId, slug: col.slug, name: col.name, published: true }).returning({ id: s.collection.id });
      colId.set(col.slug, row!.id);
      console.log(`[consolidate] collection ready: ${col.slug}`);
    }

    for (const p of PRODUCTS) {
      let [prod] = await tx.select({ id: s.product.id }).from(s.product).where(eq(s.product.slug, p.slug)).limit(1);
      if (!prod) {
        [prod] = await tx.insert(s.product).values({ storeId, slug: p.slug, name: p.name, description: p.description, status: 'active' }).returning({ id: s.product.id });
        console.log(`[consolidate] product created: ${p.slug}`);
      } else {
        await tx.update(s.product).set({ name: p.name, description: p.description, status: 'active', deletedAt: null }).where(eq(s.product.id, prod.id));
        console.log(`[consolidate] product updated: ${p.slug}`);
      }
      const productId = prod!.id;

      for (const v of p.variants) {
        const [ex] = await tx.select({ id: s.productVariant.id }).from(s.productVariant).where(eq(s.productVariant.sku, v.sku)).limit(1);
        const vals = {
          storeId, productId, sku: v.sku, name: v.name, price: v.price,
          fulfillmentType: v.fulfillmentType, appKey: v.appKey, licenseSeats: v.licenseSeats,
          licenseDurationDays: v.licenseDurationDays ?? null, updatesDurationDays: v.updatesDurationDays ?? null,
          metafields: v.metafields ?? null, enabled: true, deletedAt: null as Date | null,
        };
        if (!ex) { await tx.insert(s.productVariant).values(vals); console.log(`[consolidate]   variant created: ${v.sku} $${(v.price / 100).toFixed(2)}`); }
        else { await tx.update(s.productVariant).set(vals).where(eq(s.productVariant.id, ex.id)); console.log(`[consolidate]   variant updated: ${v.sku}`); }
      }

      const cid = colId.get(p.collection)!;
      await tx.insert(s.collectionProduct).values({ storeId, collectionId: cid, productId }).onConflictDoNothing();
    }
  });

  // 4) delete the old per-app stores (guarded: only when they have ZERO orders)
  const olds = await db.select({ id: s.store.id, slug: s.store.slug }).from(s.store).where(inArray(s.store.slug, OLD_STORE_SLUGS));
  for (const old of olds) {
    const orders = await withStore(old.id, (tx) => tx.select({ id: s.order.id }).from(s.order).limit(1));
    if (orders.length) { console.warn(`[consolidate] SKIP delete ${old.slug} — has orders`); continue; }
    await withStore(old.id, async (tx) => {
      await tx.delete(s.auditLog).where(eq(s.auditLog.storeId, old.id));
      await tx.delete(s.collectionProduct).where(eq(s.collectionProduct.storeId, old.id));
      await tx.delete(s.collection).where(eq(s.collection.storeId, old.id));
      await tx.delete(s.productVariant).where(eq(s.productVariant.storeId, old.id));
      await tx.delete(s.product).where(eq(s.product.storeId, old.id));
    });
    await db.delete(s.adminUserStore).where(eq(s.adminUserStore.storeId, old.id));
    await db.delete(s.paymentMethod).where(eq(s.paymentMethod.storeId, old.id));
    await db.delete(s.store).where(eq(s.store.id, old.id));
    console.log(`[consolidate] deleted old store: ${old.slug}`);
  }

  // 5) summary
  const remaining = await db.select({ slug: s.store.slug }).from(s.store);
  console.log(`[consolidate] stores remaining: ${remaining.map((r) => r.slug).join(', ') || '(none)'}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
