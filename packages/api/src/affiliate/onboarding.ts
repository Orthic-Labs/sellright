/**
 * Affiliate automation (DD parity — affiliate-onboarding.listener.ts).
 *
 * DD keyed onboarding off PromotionEvent: a promotion whose name carried an
 * email address auto-created the affiliate row, and a later name change
 * rotated the dashboard token + re-sent the welcome mail. SellRight's
 * promotion has no name field, so migration 0052 adds an explicit
 * `promotion.affiliate_email` column — NULL means "ordinary promotion".
 * (The drizzle table def lives in schema-core.ts, owned by another lane, so
 * this module reaches the column through raw sql refs — safe: the column is
 * in the database from 0052 onward.)
 *
 * syncPromotionAffiliate() is the drop-in for admin-marketing.ts's
 * POST/PATCH /v1/admin/promotions handlers — that file is owned by another
 * lane, so the call-site is reported, not edited:
 *
 *   await syncPromotionAffiliate(tx, st.storeId, p.id, admin.email);
 *
 * Everything is idempotent: same-email saves are a no-op, recipient changes
 * rotate the token (the old dashboard link dies), and every mail goes through
 * the transactional outbox with a dedupe key so retries can't double-send.
 */
import { eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { enqueueEmail } from '../email/outbox.js';
import { affiliateWelcome, affiliateTokenRotated } from '../email/templates-ops.js';
import { env } from '../env.js';

export const newAffiliateToken = () => randomBytes(24).toString('hex'); // 48 chars

interface PromoRow { id: string; code: string | null; affiliateEmail: string | null }

/** promotion.affiliate_email isn't on the drizzle table (0052, other lane's
 *  schema file) — read it with raw sql inside the store-scoped tx. */
async function promotionWithEmail(tx: Tx, promotionId: string): Promise<PromoRow | null> {
  const r = await tx.execute(sql`
    SELECT id, code, affiliate_email AS "affiliateEmail"
    FROM promotion WHERE id = ${promotionId} LIMIT 1`);
  return (r.rows as unknown as PromoRow[])[0] ?? null;
}

async function storeCtx(tx: Tx, storeId: string) {
  const [store] = await tx.select({ name: s.store.name, currency: s.store.currency, config: s.store.config })
    .from(s.store).where(eq(s.store.id, storeId)).limit(1);
  const storefrontUrl = ((store?.config as { storefrontUrl?: string } | null)?.storefrontUrl) ?? env.STOREFRONT_URL;
  return { name: store?.name ?? 'Store', currency: store?.currency ?? 'USD', storefrontUrl, fromEmail: env.SMTP_FROM ?? '' };
}

/** Enqueue the affiliate welcome/rotation mail via the transactional outbox
 *  (dedupe-keyed — a replayed save can't double-send). Exported for
 *  routes/admin-affiliate.ts's manual onboard path. */
export async function enqueueAffiliateMail(
  tx: Tx, storeId: string, kind: 'welcome' | 'rotation',
  email: string, code: string | null, token: string, dedupeSuffix: string,
) {
  const ctx = await storeCtx(tx, storeId);
  const dashboardUrl = `${ctx.storefrontUrl.replace(/\/$/, '')}/affiliate`;
  const accessUrl = `${dashboardUrl}?t=${token}`;
  const tpl = kind === 'welcome' ? affiliateWelcome : affiliateTokenRotated;
  const rendered = tpl(ctx, { code: code ?? '', dashboardUrl, accessUrl });
  await enqueueEmail(tx, storeId, {
    kind: `affiliate_${kind}`,
    recipient: email,
    payload: { to: email, from: env.SMTP_FROM, subject: rendered.subject, html: rendered.html, text: rendered.text },
    dedupeKey: `affiliate_${kind}:${dedupeSuffix}`,
  });
}

export type SyncResult =
  | { kind: 'noop' }                 // no affiliate_email bound / email unchanged
  | { kind: 'missing' }              // promotion id unknown (caller raced a delete)
  | { kind: 'onboarded'; affiliateId: string; email: string }
  | { kind: 'rotated'; affiliateId: string; email: string };

/**
 * Reconcile a promotion's affiliate binding. Called after promotion
 * create/update — safe to call on every save (same email → no-op).
 */
export async function syncPromotionAffiliate(
  tx: Tx, storeId: string, promotionId: string, actor: string,
): Promise<SyncResult> {
  const promo = await promotionWithEmail(tx, promotionId);
  if (!promo) return { kind: 'missing' };
  const email = promo.affiliateEmail?.trim().toLowerCase();
  if (!email || !email.includes('@')) return { kind: 'noop' };

  const [existing] = await tx.select().from(s.affiliate)
    .where(eq(s.affiliate.promotionId, promotionId)).limit(1);

  if (existing) {
    if (existing.email === email) return { kind: 'noop' };
    // Recipient changed → rotate: the old access token dies here.
    const accessToken = newAffiliateToken();
    await tx.update(s.affiliate).set({ email, accessToken }).where(eq(s.affiliate.id, existing.id));
    await tx.insert(s.auditLog).values({
      storeId, actor, entity: 'affiliate', entityId: existing.id, action: 'rotate',
      data: { from: existing.email, to: email, code: promo.code },
    });
    await enqueueAffiliateMail(tx, storeId, 'rotation', email, promo.code, accessToken, `${existing.id}:${email}`);
    return { kind: 'rotated', affiliateId: existing.id, email };
  }

  const accessToken = newAffiliateToken();
  const [aff] = await tx.insert(s.affiliate)
    .values({ storeId, promotionId, email, accessToken })
    .onConflictDoNothing() // unique promotion_id — a concurrent save wins; our mail dedupes anyway
    .returning({ id: s.affiliate.id });
  if (!aff) return { kind: 'noop' };
  await tx.insert(s.auditLog).values({
    storeId, actor, entity: 'affiliate', entityId: aff.id, action: 'onboard',
    data: { email, code: promo.code, source: 'promotion' },
  });
  await enqueueAffiliateMail(tx, storeId, 'welcome', email, promo.code, accessToken, `${aff.id}`);
  return { kind: 'onboarded', affiliateId: aff.id, email };
}

/**
 * Admin recipient change (PATCH /v1/admin/affiliates/{id} calls this):
 * repoint the affiliate at a new email — rotate the token so the previous
 * recipient's dashboard link is dead — and mail the new recipient.
 * Returns null when the affiliate id doesn't exist in this store.
 */
export async function reassignAffiliate(
  tx: Tx, storeId: string, affiliateId: string, email: string, actor: string,
): Promise<{ id: string; email: string; code: string | null } | null> {
  const [a] = await tx.select().from(s.affiliate).where(eq(s.affiliate.id, affiliateId)).limit(1);
  if (!a) return null;
  const next = email.trim().toLowerCase();
  if (a.email === next) return { id: a.id, email: a.email, code: null };
  const accessToken = newAffiliateToken();
  await tx.update(s.affiliate).set({ email: next, accessToken }).where(eq(s.affiliate.id, a.id));
  const [promo] = await tx.select({ code: s.promotion.code }).from(s.promotion).where(eq(s.promotion.id, a.promotionId)).limit(1);
  await tx.insert(s.auditLog).values({
    storeId, actor, entity: 'affiliate', entityId: a.id, action: 'rotate',
    data: { from: a.email, to: next, code: promo?.code ?? null },
  });
  await enqueueAffiliateMail(tx, storeId, 'rotation', next, promo?.code ?? null, accessToken, `${a.id}:${next}`);
  return { id: a.id, email: next, code: promo?.code ?? null };
}
