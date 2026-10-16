/**
 * Product reviews (REWARDS-1). Pure data layer over `product_review`
 * (migration 0085); routes own auth, rate limits and HTTP shape.
 *
 * Rules:
 *  - One review per product per reviewer (normalized email).
 *  - A review is public only once `approved` (moderated) — unless the store
 *    enables autoApprove.
 *  - verified_buyer is derived server-side from a PAID order that contains
 *    the product; the client can never assert it.
 *  - Average/count are computed from approved rows on every read (no cache);
 *    the catalog manifest carries a regenerated copy for schema.org.
 *  - The approval bonus is granted exactly once per review (ledger
 *    source_ref), by the transition into `approved`.
 */
import { z } from '@hono/zod-openapi';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { normalizeEmail } from '../auth/email.js';
import { orderProvenanceFilter } from '../auth/order-access.js';
import { grantReviewBonus } from '../loyalty/bonus.js';
import { loyaltyBalance } from '../loyalty/ledger.js';
import { enqueueReviewApproved } from '../email/dispatch.js';

export const ReviewSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  /** Guests may review by proving a purchase (order code + email). */
  allowGuests: z.boolean().default(false),
  /** Publish immediately instead of queueing for moderation. */
  autoApprove: z.boolean().default(false),
  /** Only buyers of the product (paid order) may review it. */
  requirePurchase: z.boolean().default(false),
}).strict();
export type ReviewSettings = z.infer<typeof ReviewSettingsSchema>;
export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = { enabled: true, allowGuests: false, autoApprove: false, requirePurchase: false };

export function reviewSettingsFromConfig(config: unknown): ReviewSettings {
  const raw = (config as { reviews?: unknown } | null | undefined)?.reviews;
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_REVIEW_SETTINGS };
  const parsed = ReviewSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : { ...DEFAULT_REVIEW_SETTINGS };
}

export const ReviewInputSchema = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().max(120).optional(),
  body: z.string().trim().min(10).max(5000),
  /** Display name. Optional for signed-in customers (defaults to first name + last initial). */
  name: z.string().trim().min(1).max(60).optional(),
  /** Guest reviews only: proof of purchase. */
  email: z.string().trim().max(254).optional(),
  orderCode: z.string().trim().max(64).optional(),
});
export type ReviewInput = z.infer<typeof ReviewInputSchema>;

const stripControl = (v: string) => v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+$/g, '');

export interface Aggregate { average: number; count: number; distribution: Record<'1' | '2' | '3' | '4' | '5', number> }
const emptyAggregate = (): Aggregate => ({ average: 0, count: 0, distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } });

/** Approved-review aggregates for the given products (one query). */
export async function aggregatesForProducts(tx: Tx, storeId: string, productIds: string[]): Promise<Map<string, Aggregate>> {
  const out = new Map<string, Aggregate>();
  if (!productIds.length) return out;
  const rows = await tx.select({ productId: s.productReview.productId, rating: s.productReview.rating, n: sql<number>`count(*)::int` })
    .from(s.productReview)
    .where(and(eq(s.productReview.storeId, storeId), eq(s.productReview.status, 'approved'), inArray(s.productReview.productId, productIds)))
    .groupBy(s.productReview.productId, s.productReview.rating);
  for (const r of rows) {
    const a = out.get(r.productId) ?? emptyAggregate();
    a.distribution[String(r.rating) as '1'] += r.n;
    a.count += r.n;
    out.set(r.productId, a);
  }
  for (const a of out.values()) {
    const sum = (Object.entries(a.distribution) as Array<[string, number]>).reduce((n, [k, v]) => n + Number(k) * v, 0);
    a.average = a.count ? Math.round((sum / a.count) * 10) / 10 : 0;
  }
  return out;
}

export async function aggregateForProduct(tx: Tx, storeId: string, productId: string): Promise<Aggregate> {
  return (await aggregatesForProducts(tx, storeId, [productId])).get(productId) ?? emptyAggregate();
}

export interface PublicReview {
  id: string; authorName: string; rating: number; title: string | null; body: string;
  verifiedBuyer: boolean; createdAt: string; reply: string | null; repliedAt: string | null;
}

export async function listApproved(tx: Tx, storeId: string, productId: string, opts: { limit: number; offset: number; sort: 'newest' | 'highest' | 'lowest' }): Promise<PublicReview[]> {
  const order = opts.sort === 'highest' ? [desc(s.productReview.rating), desc(s.productReview.createdAt)]
    : opts.sort === 'lowest' ? [sql`${s.productReview.rating} ASC`, desc(s.productReview.createdAt)]
    : [desc(s.productReview.createdAt)];
  const rows = await tx.select().from(s.productReview)
    .where(and(eq(s.productReview.storeId, storeId), eq(s.productReview.productId, productId), eq(s.productReview.status, 'approved')))
    .orderBy(...order, desc(s.productReview.id)).limit(opts.limit).offset(opts.offset);
  return rows.map((r) => ({
    id: r.id, authorName: r.authorName, rating: r.rating, title: r.title, body: r.body, verifiedBuyer: r.verifiedBuyer,
    createdAt: r.createdAt.toISOString(), reply: r.reply, repliedAt: r.repliedAt?.toISOString() ?? null,
  }));
}

/** Display name for a signed-in reviewer: first name + last initial. */
export function defaultDisplayName(c: { firstName: string | null; lastName: string | null; email: string }): string {
  const first = (c.firstName ?? '').trim();
  const last = (c.lastName ?? '').trim();
  if (first) return last ? `${first} ${last[0]!.toUpperCase()}.` : first;
  return 'Verified customer';
}

const PAID_STATES = ['Paid', 'PartiallyRefunded'] as const;

/** Order id of a PAID order that (a) belongs to the customer / matches the
 *  guest's email and (b) contains a variant of `productId`; null otherwise. */
export async function findPurchaseProof(tx: Tx, input: { storeId: string; productId: string; customerId?: string | null; customer?: { email: string; emailVerified: boolean } | null; email?: string | null; orderCode?: string | null }): Promise<string | null> {
  const base = and(
    inArray(s.order.state, [...PAID_STATES]),
    sql`exists (select 1 from order_line ol join product_variant pv on pv.id = ol.variant_id where ol.order_id = ${s.order.id} and pv.product_id = ${input.productId})`,
  );
  if (input.customerId) {
    // Fail closed: customer-linked proof requires the mailbox provenance check
    // (an unproven email_match link must not count as a purchase).
    if (!input.customer) return null;
    const [o] = await tx.select({ id: s.order.id }).from(s.order).where(and(base, eq(s.order.storeId, input.storeId), eq(s.order.customerId, input.customerId), orderProvenanceFilter(input.customer))).orderBy(desc(s.order.createdAt)).limit(1);
    return o?.id ?? null;
  }
  if (input.orderCode && input.email) {
    const email = normalizeEmail(input.email);
    const [o] = await tx.select({ id: s.order.id }).from(s.order).where(and(
      base, eq(s.order.storeId, input.storeId), eq(s.order.code, input.orderCode.trim()),
      sql`lower(coalesce(${s.order.metadata}->'contact'->>'email', '')) = ${email}`,
    )).limit(1);
    return o?.id ?? null;
  }
  return null;
}

export type SubmitResult =
  | { ok: true; id: string; productId: string; status: 'pending' | 'approved'; verifiedBuyer: boolean }
  | { ok: false; reason: 'disabled' | 'product_not_found' | 'sign_in_required' | 'purchase_required' | 'duplicate' | 'email_unverified' };

export async function submitReview(tx: Tx, input: {
  storeId: string; store: { name: string; currency: string; config: unknown }; productSlug: string; review: ReviewInput;
  customer: { id: string; email: string; emailVerified: boolean; firstName: string | null; lastName: string | null } | null;
}): Promise<SubmitResult> {
  const settings = reviewSettingsFromConfig(input.store.config);
  if (!settings.enabled) return { ok: false, reason: 'disabled' };
  const [product] = await tx.select({ id: s.product.id }).from(s.product)
    .where(and(eq(s.product.storeId, input.storeId), eq(s.product.slug, input.productSlug), eq(s.product.status, 'active'), sql`${s.product.deletedAt} IS NULL`)).limit(1);
  if (!product) return { ok: false, reason: 'product_not_found' };

  let email: string; let name: string; let orderId: string | null; let customerId: string | null = null;
  if (input.customer) {
    if (!input.customer.emailVerified) return { ok: false, reason: 'email_unverified' };
    email = normalizeEmail(input.customer.email);
    customerId = input.customer.id;
    name = input.review.name?.trim() || defaultDisplayName(input.customer);
    orderId = await findPurchaseProof(tx, { storeId: input.storeId, productId: product.id, customerId: input.customer.id, customer: input.customer });
  } else {
    if (!settings.allowGuests || !input.review.email || !input.review.orderCode) return { ok: false, reason: 'sign_in_required' };
    email = normalizeEmail(input.review.email);
    orderId = await findPurchaseProof(tx, { storeId: input.storeId, productId: product.id, email, orderCode: input.review.orderCode });
    if (!orderId) return { ok: false, reason: 'purchase_required' }; // a guest must prove a purchase
    name = input.review.name?.trim() || 'Verified customer';
  }
  if (settings.requirePurchase && !orderId) return { ok: false, reason: 'purchase_required' };

  const [row] = await tx.insert(s.productReview).values({
    storeId: input.storeId, productId: product.id, customerId, orderId, authorName: stripControl(name),
    authorEmail: email, rating: input.review.rating, title: input.review.title ? stripControl(input.review.title) : null,
    body: stripControl(input.review.body), status: 'pending', verifiedBuyer: !!orderId,
  }).onConflictDoNothing().returning({ id: s.productReview.id });
  if (!row) return { ok: false, reason: 'duplicate' };
  // autoApprove rides the same approval path (bonus + email) as a manual approve.
  if (settings.autoApprove) {
    await approveReview(tx, { storeId: input.storeId, reviewId: row.id, actor: 'system:auto-approve', store: input.store });
    return { ok: true, id: row.id, productId: product.id, status: 'approved', verifiedBuyer: !!orderId };
  }
  return { ok: true, id: row.id, productId: product.id, status: 'pending', verifiedBuyer: !!orderId };
}

export interface ModerationOutcome {
  /** Product whose aggregate may have changed (caller refreshes the manifest after commit). */
  productId: string;
  bonusPoints: number;
}

/**
 * Approve a review. Idempotent: approving an already-approved review changes
 * nothing and grants nothing twice (the bonus rides on the ledger source_ref).
 * Re-approving a previously rejected review is allowed.
 */
export async function approveReview(tx: Tx, input: {
  storeId: string; reviewId: string; actor: string; store: { name: string; currency: string; config: unknown };
}): Promise<ModerationOutcome | null> {
  const [r] = await tx.select().from(s.productReview).where(and(eq(s.productReview.id, input.reviewId), eq(s.productReview.storeId, input.storeId))).limit(1);
  if (!r) return null;
  const wasApproved = r.status === 'approved';
  if (!wasApproved) {
    await tx.update(s.productReview).set({ status: 'approved', moderatedBy: input.actor, moderatedAt: new Date(), updatedAt: new Date() }).where(eq(s.productReview.id, r.id));
  }
  const bonus = await grantReviewBonus(tx, input.storeId, r.id);
  if (!wasApproved) {
    const [prod] = await tx.select({ name: s.product.name, slug: s.product.slug }).from(s.product).where(eq(s.product.id, r.productId)).limit(1);
    const balance = r.customerId ? (await loyaltyBalance(tx, r.customerId)).available : null;
    await enqueueReviewApproved(tx, input.storeId, input.store, r.authorEmail, {
      productName: prod?.name ?? 'your purchase', productSlug: prod?.slug ?? '', points: bonus.points, balance,
      dedupeKey: `review_approved:${r.id}`,
    });
  }
  return { productId: r.productId, bonusPoints: bonus.points };
}

export async function rejectReview(tx: Tx, input: { storeId: string; reviewId: string; actor: string }): Promise<ModerationOutcome | null> {
  const [r] = await tx.select({ id: s.productReview.id, productId: s.productReview.productId, bonusPoints: s.productReview.bonusPoints })
    .from(s.productReview).where(and(eq(s.productReview.id, input.reviewId), eq(s.productReview.storeId, input.storeId))).limit(1);
  if (!r) return null;
  await tx.update(s.productReview).set({ status: 'rejected', moderatedBy: input.actor, moderatedAt: new Date(), updatedAt: new Date() }).where(eq(s.productReview.id, r.id));
  return { productId: r.productId, bonusPoints: 0 };
}

export async function deleteReview(tx: Tx, input: { storeId: string; reviewId: string }): Promise<ModerationOutcome | null> {
  const [r] = await tx.select({ id: s.productReview.id, productId: s.productReview.productId })
    .from(s.productReview).where(and(eq(s.productReview.id, input.reviewId), eq(s.productReview.storeId, input.storeId))).limit(1);
  if (!r) return null;
  await tx.delete(s.productReview).where(eq(s.productReview.id, r.id));
  return { productId: r.productId, bonusPoints: 0 };
}

export async function setReply(tx: Tx, input: { storeId: string; reviewId: string; reply: string | null }): Promise<boolean> {
  const reply = input.reply?.trim() ? stripControl(input.reply.trim()) : null;
  const res = await tx.update(s.productReview).set({ reply, repliedAt: reply ? new Date() : null, updatedAt: new Date() })
    .where(and(eq(s.productReview.id, input.reviewId), eq(s.productReview.storeId, input.storeId))).returning({ id: s.productReview.id });
  return res.length > 0;
}
