/** Atomic Vendure migration phase. Invoke through import/run.ts.
 *
 * SR-09: configured business extensions. Both source stores run BlogPlugin;
 * Damned Designs also runs AffiliatePlugin and WaitlistPlugin. Each maps into
 * a native SellRight model:
 *   - blog_post          -> blog_post          (admin-content.ts / shop-extra.ts)
 *   - affiliate          -> affiliate          (admin-affiliate.ts)
 *   - affiliate_settle   -> affiliate_settle   (paid balances; unpaid = earned
 *                                             minus settled, recomputed live
 *                                             from imported orders+promotions)
 *   - waitlist_signup    -> subscriber(kind='waitlist')  (shop-extra.ts)
 *
 * Plugin tables are optional per source: when absent the record type lands on
 * the manifest exclusion list instead of being silently skipped.
 */
import { eq } from 'drizzle-orm';
import * as s from '../db/schema.js';
import { normalizeEmail } from '../auth/email.js';
import { parseDate, parseStrArray } from './store.js';
import type { ImportContext, ManifestExclusion } from './context.js';

export async function importBusiness(ctx: ImportContext): Promise<void> {
  const { tx, q, storeId } = ctx;
  const exclude = (type: ManifestExclusion['type'], table: string, detail: string, count?: number) =>
    ctx.exclusions.push({ type, table, detail, count });
  const absent = (table: string, detail: string) => exclude('source-extension-absent', table, detail);

  /** The catalog phase only imports enabled, non-deleted promotions. Affiliate
   * records can reference a promotion that is disabled or deleted in the
   * source; those identities must still resolve, so backfill them as disabled
   * tombstones — they can never discount, but coupon attribution and the
   * affiliate FK stay faithful. */
  const ensurePromotion = async (sourcePromotionId: unknown): Promise<string | null> => {
    const id = ctx.id('promotion', sourcePromotionId);
    const [existing] = await tx.select({ id: s.promotion.id }).from(s.promotion).where(eq(s.promotion.id, id)).limit(1);
    if (existing) return id;
    const rows = await q(
      `SELECT id, "couponCode" AS code, "startsAt" AS starts, "endsAt" AS ends FROM promotion WHERE id = $1`,
      [sourcePromotionId],
    );
    if (!rows.length) return null;
    const promo = rows[0]!;
    await tx.insert(s.promotion).values({
      id, storeId, code: promo.code ?? null, type: 'percentage', value: 0,
      startsAt: parseDate(promo.starts), endsAt: parseDate(promo.ends), enabled: false,
    });
    return id;
  };

  // --- blog posts (BlogPlugin: both stores) ---
  let blogCount = 0;
  if (ctx.sourceColumns.has('blog_post')) {
    // Explicit store_id predicates on every tenant-table select: the migration
    // role may bypass RLS entirely (superuser test fixtures), so the tenant
    // boundary must be in the query, not just the policy.
    const assetIds = new Set((await tx.select({ id: s.asset.id }).from(s.asset)
      .where(eq(s.asset.storeId, storeId))).map(row => row.id));
    for (const post of await q(
      `SELECT id, title, slug, excerpt, body, "bodyHtml", "authorName", "readingTime",
              "featuredAssetId", tags, "isPublished", "publishDate", "seoTitle", "seoDescription"
       FROM blog_post ORDER BY id`,
    )) {
      if (!post.title || !post.slug) throw new Error('Blog post is missing title/slug: ' + post.id);
      const featured = post.featuredAssetId != null ? ctx.id('asset', post.featuredAssetId) : null;
      const tags = typeof post.tags === 'string' ? parseStrArray(post.tags) : Array.isArray(post.tags) ? post.tags : null;
      if (featured && !assetIds.has(featured)) {
        exclude('unmappable-source-row', 'blog_post', `post ${post.id} featured asset ${post.featuredAssetId} is not in the imported asset set`, 1);
      }
      await tx.insert(s.blogPost).values({
        id: ctx.id('blog-post', post.id), storeId,
        title: post.title, slug: post.slug,
        excerpt: post.excerpt ?? null, body: post.body ?? null, bodyHtml: post.bodyHtml ?? null,
        authorName: post.authorName ?? null,
        readingTime: post.readingTime ?? null,
        featuredAssetId: featured && assetIds.has(featured) ? featured : null,
        tags,
        isPublished: post.isPublished ?? false,
        publishDate: parseDate(post.publishDate),
        seoTitle: post.seoTitle ?? null, seoDescription: post.seoDescription ?? null,
      });
      blogCount++;
    }
  } else {
    absent('blog_post', 'BlogPlugin table absent from the source schema');
  }

  // --- affiliates + settlement ledger (DD AffiliatePlugin) ---
  let affiliateCount = 0;
  if (ctx.sourceColumns.has('affiliate')) {
    for (const row of await q(
      `SELECT id, "promotionId", email, "accessToken", "onboardedAt" FROM affiliate ORDER BY id`,
    )) {
      const promotionId = await ensurePromotion(row.promotionId);
      if (!promotionId) {
        exclude('unmappable-source-row', 'affiliate', `affiliate ${row.id} references promotion ${row.promotionId}, absent from source`, 1);
        continue;
      }
      if (!row.email || !row.accessToken) throw new Error('Affiliate is missing email/accessToken: ' + row.id);
      // accessToken is preserved verbatim: it IS the affiliate's self-serve
      // link identity (/v1/shop/affiliate?t=…). Remapping would break links.
      await tx.insert(s.affiliate).values({
        id: ctx.id('affiliate', row.id), storeId, promotionId,
        email: normalizeEmail(row.email), accessToken: row.accessToken,
        onboardedAt: parseDate(row.onboardedAt) ?? undefined,
      });
      affiliateCount++;
    }
  } else {
    absent('affiliate', 'AffiliatePlugin table absent from the source schema');
  }

  let settleCount = 0;
  if (ctx.sourceColumns.has('affiliate_settle')) {
    for (const row of await q(
      `SELECT id, "promotionId", "amountCents", "periodStartAt", "periodEndAt", "settledAt", "txRef", notes
       FROM affiliate_settle ORDER BY id`,
    )) {
      const promotionId = await ensurePromotion(row.promotionId);
      if (!promotionId) {
        exclude('unmappable-source-row', 'affiliate_settle', `settle ${row.id} references promotion ${row.promotionId}, absent from source`, 1);
        continue;
      }
      const settledAt = parseDate(row.settledAt), periodEndAt = parseDate(row.periodEndAt);
      if (!settledAt || !periodEndAt) throw new Error('Affiliate settle is missing settledAt/periodEndAt: ' + row.id);
      const amountCents = Number(row.amountCents);
      if (!Number.isSafeInteger(amountCents)) throw new Error('Invalid affiliate settle amount: ' + row.id);
      await tx.insert(s.affiliateSettle).values({
        id: ctx.id('affiliate-settle', row.id), storeId, promotionId,
        amountCents, periodStartAt: parseDate(row.periodStartAt), periodEndAt,
        settledAt, txRef: row.txRef ?? null, notes: row.notes ?? null,
      });
      settleCount++;
    }
  } else {
    absent('affiliate_settle', 'AffiliatePlugin settlement table absent from the source schema');
  }

  // --- waitlist signups (DD WaitlistPlugin) -> subscriber(kind='waitlist') ---
  // The source is product-scoped: a pending signup is emailed once when ANY
  // variant of the product crosses 0 -> >0 (productsNowInStock), then stays
  // 'notified' forever. The native SellRight lane is variant-scoped — the
  // restock sweep claims subscriber rows whose topic is `restock:<variantId>`
  // (the imported variant uuid) and flips them to 'unsubscribed'. So a signup
  // maps to one subscriber row per in-scope variant:
  //   - variantId set    -> that variant, when it resolves to an imported one
  //   - variantId null   -> every imported variant of the product (any-variant
  //                         semantics: first restock emails, claim consumes it)
  // Source status maps to the claim states: 'pending' -> 'confirmed'
  // (consented, claimable), 'notified' -> 'unsubscribed' (already consumed in
  // the source — must never re-email). Original lifecycle lives in meta.
  let waitlistCount = 0;
  if (ctx.sourceColumns.has('waitlist_signup')) {
    const variantRows = await tx.select({ id: s.productVariant.id, productId: s.productVariant.productId }).from(s.productVariant)
      .where(eq(s.productVariant.storeId, storeId));
    const variantsByProduct = new Map<string, string[]>();
    const importedVariants = new Set<string>();
    for (const v of variantRows) {
      importedVariants.add(v.id);
      const list = variantsByProduct.get(v.productId) ?? [];
      list.push(v.id);
      variantsByProduct.set(v.productId, list);
    }
    const labels: Record<string, string> = {};
    const rows = await q(
      `SELECT id, "productId", "productSlug", "productName", "variantId", email, status, "notifiedAt", "createdAt", "updatedAt"
       FROM waitlist_signup ORDER BY id`,
    );
    // Source dedupe is (email, productId) while pending — notified history
    // rows coexist with a re-armed pending row. Merge per (email, product):
    // a pending row beats notified history (it is the live request); within
    // the same status the newest signup wins.
    const byKey = new Map<string, (typeof rows)[number]>();
    let merged = 0;
    for (const row of rows) {
      if (!row.email) throw new Error('Waitlist signup is missing email: ' + row.id);
      const key = normalizeEmail(row.email) + '|' + row.productId;
      const prev = byKey.get(key);
      const wins = !prev
        || (row.status === 'pending' && prev.status !== 'pending')
        || (row.status === prev.status && String(prev.createdAt ?? '') <= String(row.createdAt ?? ''));
      if (wins) byKey.set(key, row);
      if (prev) merged++;
    }
    for (const row of byKey.values()) {
      const importedProductId = ctx.id('product', row.productId);
      let variantIds: string[];
      if (row.variantId != null && row.variantId !== '') {
        const id = ctx.id('variant', Number(row.variantId));
        variantIds = importedVariants.has(id) ? [id] : [];
      } else {
        variantIds = variantsByProduct.get(importedProductId) ?? [];
      }
      if (!variantIds.length) {
        exclude('unmappable-source-row', 'waitlist_signup',
          `signup ${row.id} (${row.email}) targets ${row.variantId != null ? 'variant ' + row.variantId : 'product ' + row.productId} — not in the imported catalog`, 1);
        continue;
      }
      const notified = row.status === 'notified';
      const confirmedAt = parseDate(row.createdAt);
      const unsubscribedAt = notified ? parseDate(row.notifiedAt) : null;
      // One logical signup = one shared signup_group across every expanded
      // variant row (the source waitlist_signup row id, migration-scoped — NOT
      // the per-variant row id). The restock claim consumes by group, so the
      // shopper is emailed once per signup — DD parity: the source plugin
      // mailed once for the product, not once per variant restock.
      // Variant-scoped source signups get the same formula: a group of one.
      const signupGroup = ctx.id('waitlist-signup', row.id);
      for (const variantId of variantIds) {
        const topic = 'restock:' + variantId;
        labels[topic] = row.productName ?? row.productSlug ?? topic;
        await tx.insert(s.subscriber).values({
          id: ctx.id('waitlist-signup', row.id + ':' + variantId), storeId,
          email: normalizeEmail(row.email), kind: 'waitlist', topic,
          status: notified ? 'unsubscribed' : 'confirmed', source: 'import',
          signupGroup,
          confirmedAt: confirmedAt ?? undefined,
          unsubscribedAt: unsubscribedAt ?? undefined,
          createdAt: confirmedAt ?? undefined, updatedAt: parseDate(row.updatedAt) ?? undefined,
          meta: {
            productId: importedProductId, productSlug: row.productSlug ?? null,
            productName: row.productName ?? null, variantId,
            vendure: { id: row.id, productId: row.productId, variantId: row.variantId ?? null,
              status: row.status, notifiedAt: row.notifiedAt ?? null },
          },
        });
        waitlistCount++;
      }
    }
    if (merged) exclude('merged-duplicate', 'waitlist_signup', 'duplicate (email, product) signups merged; live request kept', merged);
    // waitlistLabels feeds confirmation/notify copy — key by the exact topic
    // the sweep claims so imported topics render a product name, not a uuid.
    if (Object.keys(labels).length) {
      const [store] = await tx.select({ config: s.store.config }).from(s.store).where(eq(s.store.id, storeId)).limit(1);
      const config = (store?.config ?? {}) as Record<string, unknown>;
      const waitlistLabels = { ...((config.waitlistLabels as Record<string, string> | undefined) ?? {}), ...labels };
      await tx.update(s.store).set({ config: { ...config, waitlistLabels } }).where(eq(s.store.id, storeId));
    }
  } else {
    absent('waitlist_signup', 'WaitlistPlugin table absent from the source schema');
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ store: storeId, blogPosts: blogCount, affiliates: affiliateCount, affiliateSettles: settleCount, waitlistSignups: waitlistCount }, null, 2));
}
