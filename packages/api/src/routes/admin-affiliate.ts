import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { clientIp } from '../auth/rate-limit.js';
import { rateLimitBackend } from '../auth/rate-limit-backend.js';
import { withStore } from '../db/client.js';
import { resolveStore, devDefaultStore } from '../store-context.js';
import * as s from '../db/schema.js';
import { HttpError, J, errBody, money, requireAdmin, requireStore, requireWrite, requirePermission, guard, slugify } from './admin-helpers.js';
import { enqueueAffiliateMail, reassignAffiliate, syncPromotionAffiliate } from '../affiliate/onboarding.js';
import { affiliateRangeStats, affiliateTopSellers } from '../affiliate/stats.js';
import { AFFILIATE_MIN_TOKEN_LENGTH, AFFILIATE_ORDER_LIMIT, AFFILIATE_STATS_RATE, COMMISSION_PCT, COMMISSION_STATES, commissionBasis } from '../affiliate/constants.js';
import { dayRangeError } from '../lib/day-range.js';

export const adminAffiliate = new OpenAPIHono();

// Commission = 10% of the merchandise subtotal AFTER order discounts (the
// affiliate's own coupon included), on paid orders attributed to the
// affiliate's promotion — matches DD's affiliate plugin, which paid on the
// discounted subtotal and never on fully refunded or cancelled orders.
// Rules live in affiliate/constants.ts (shared with the welcome mail).

/** DD's coupon status chip (affiliate-stats.service.ts getCouponInfo). SellRight
 *  hard-deletes only unused promotions, so a bound coupon is never 'Deleted'. */
const couponStatus = (enabled: boolean): 'Active' | 'Disabled' => (enabled ? 'Active' : 'Disabled');

/** Earned (10% of discounted paid-order subtotals on this promo) and settled-to-date. */
async function affiliateAmounts(tx: { execute: Function }, promotionId: string) {
  const r = await (tx as any).execute(sql`
    select
      coalesce((select sum(greatest(o.subtotal - o.discount_total, 0)) from "order" o
                where o.promotion_id = ${promotionId}
                  and o.state = any(array['Paid','PartiallyRefunded']::order_state[])),0)::int as subtotals,
      coalesce((select sum(a.amount_cents) from affiliate_settle a where a.promotion_id = ${promotionId}),0)::int as settled,
      (select count(*) from "order" o where o.promotion_id = ${promotionId}
         and o.state = any(array['Paid','PartiallyRefunded']::order_state[]))::int as orders,
      (select max(a.settled_at) from affiliate_settle a where a.promotion_id = ${promotionId}) as last_settled_at`);
  const row = (r as { rows: Array<{ subtotals: number; settled: number; orders: number; last_settled_at: Date | string | null }> }).rows[0]!;
  const earned = Math.round(row.subtotals * (COMMISSION_PCT / 100));
  const lastSettledAt = row.last_settled_at ? new Date(row.last_settled_at).toISOString() : null;
  return { earned, settled: row.settled, unsettled: earned - row.settled, orders: row.orders, subtotals: row.subtotals, lastSettledAt };
}

// ── list ─────────────────────────────────────────────────────────────────────
adminAffiliate.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/affiliates', summary: 'List affiliates',
    responses: { 200: { description: 'OK', content: J(z.object({ items: z.array(z.unknown()), commissionPct: z.number() })) }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const items = await withStore(st.storeId, async (tx) => {
      const affs = await tx
        .select({ id: s.affiliate.id, email: s.affiliate.email, accessToken: s.affiliate.accessToken, promotionId: s.affiliate.promotionId, code: s.promotion.code, enabled: s.promotion.enabled, onboardedAt: s.affiliate.onboardedAt })
        .from(s.affiliate).innerJoin(s.promotion, eq(s.promotion.id, s.affiliate.promotionId)).orderBy(desc(s.affiliate.onboardedAt));
      const out = [];
      for (const { enabled, ...a } of affs) { const amt = await affiliateAmounts(tx, a.promotionId); out.push({ ...a, status: couponStatus(enabled), onboardedAt: a.onboardedAt.toISOString(), ...amt }); }
      return out;
    });
    return c.json({ items, commissionPct: COMMISSION_PCT }, 200);
  }),
);

// ── onboard (creates a coupon promo + the affiliate) ─────────────────────────
adminAffiliate.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/affiliates', summary: 'Onboard an affiliate (creates their coupon)',
    request: { body: { content: J(z.object({ email: z.string().email(), code: z.string().optional(), discountPct: z.number().int().min(0).max(100).default(10) })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string(), code: z.string(), accessToken: z.string() })) }, 409: { description: 'Exists', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const b = c.req.valid('json');
    const code = (b.code || slugify(b.email.split('@')[0]!)).toUpperCase().slice(0, 24);
    const res = await withStore(st.storeId, async (tx) => {
      const [dupePromo] = await tx.select({ id: s.promotion.id }).from(s.promotion).where(eq(s.promotion.code, code)).limit(1);
      if (dupePromo) return { dupe: true as const };
      // percentage promo value is the percent integer (10 = 10%) — see totals.ts.
      const [promo] = await tx.insert(s.promotion).values({ storeId: st.storeId, code, type: 'percentage', value: b.discountPct, enabled: true }).returning({ id: s.promotion.id });
      const accessToken = randomBytes(24).toString('hex'); // 48 chars
      const [aff] = await tx.insert(s.affiliate).values({ storeId: st.storeId, promotionId: promo!.id, email: b.email, accessToken }).returning({ id: s.affiliate.id });
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'affiliate', entityId: aff!.id, action: 'onboard', data: { email: b.email, code } });
      // Welcome mail in the same tx (transactional outbox) — the affiliate
      // only exists when the email does. dedupeKey pins it to the row.
      await enqueueAffiliateMail(tx, st.storeId, 'welcome', b.email, code, accessToken, aff!.id);
      return { id: aff!.id, code, accessToken };
    });
    if ('dupe' in res) throw new HttpError(409, `coupon code ${code} already exists — pass a different code`);
    return c.json(res, 200);
  }),
);

// ── detail (orders attributed + amounts + settlement history) ────────────────
adminAffiliate.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/affiliates/{id}', summary: 'Affiliate detail',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.any()) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { id } = c.req.valid('param');
    const out = await withStore(st.storeId, async (tx) => {
      const [a] = await tx.select().from(s.affiliate).where(eq(s.affiliate.id, id)).limit(1);
      if (!a) return null;
      const [promo] = await tx.select({ code: s.promotion.code, enabled: s.promotion.enabled }).from(s.promotion).where(eq(s.promotion.id, a.promotionId)).limit(1);
      const amt = await affiliateAmounts(tx, a.promotionId);
      // Only commission-earning states, newest first, on the same net basis the
      // totals use (subtotal - discount): unpaid / cancelled / refunded orders
      // are not part of what is owed, so they are not listed here either.
      const orders = await tx.select({ code: s.order.code, subtotal: s.order.subtotal, discountTotal: s.order.discountTotal, state: s.order.state, placedAt: s.order.placedAt, createdAt: s.order.createdAt })
        .from(s.order).where(and(eq(s.order.promotionId, a.promotionId), inArray(s.order.state, [...COMMISSION_STATES])))
        .orderBy(desc(sql`coalesce(${s.order.placedAt}, ${s.order.createdAt})`)).limit(AFFILIATE_ORDER_LIMIT);
      const settlements = await tx.select().from(s.affiliateSettle).where(eq(s.affiliateSettle.promotionId, a.promotionId)).orderBy(desc(s.affiliateSettle.settledAt));
      const topSellers = await affiliateTopSellers(tx, st.storeId, a.promotionId);
      return {
        id: a.id, email: a.email, code: promo?.code, status: couponStatus(promo?.enabled ?? false), accessToken: a.accessToken, commissionPct: COMMISSION_PCT, ...amt,
        topSellers,
        orders: orders.map((o) => ({
          code: o.code, state: o.state, subtotal: o.subtotal, discountTotal: o.discountTotal,
          basis: commissionBasis(o), commission: Math.round(commissionBasis(o) * (COMMISSION_PCT / 100)),
          placedAt: o.placedAt?.toISOString() ?? null, createdAt: o.createdAt.toISOString(),
        })),
        settlements: settlements.map((sx) => ({ amountCents: sx.amountCents, periodStartAt: sx.periodStartAt?.toISOString() ?? null, periodEndAt: sx.periodEndAt.toISOString(), settledAt: sx.settledAt.toISOString(), txRef: sx.txRef, notes: sx.notes })),
      };
    });
    if (!out) throw new HttpError(404, 'affiliate not found');
    return c.json(out, 200);
  }),
);

// ── stats by date range, with per-SKU sales (G8) ─────────────────────────────
const SkuRow = z.object({ sku: z.string(), name: z.string(), units: z.number().int(), orders: z.number().int(), revenue: money, commission: money });
const StatsOut = z.object({
  range: z.object({ from: z.string().nullable(), to: z.string().nullable() }),
  commissionPct: z.number(),
  totals: z.object({ orders: z.number().int(), units: z.number().int(), revenue: money, commission: money }),
  bySku: z.array(SkuRow),
});

adminAffiliate.openapi(
  createRoute({
    method: 'get', path: '/v1/admin/affiliates/{id}/stats', summary: 'Affiliate sales for a date range, with per-SKU units, revenue and commission',
    request: {
      params: z.object({ id: z.string().uuid() }),
      // Inclusive UTC days (same convention as the order export). Omit both for lifetime.
      query: z.object({ from: z.string().optional(), to: z.string().optional() }),
    },
    responses: { 200: { description: 'OK', content: J(StatsOut) }, 400: { description: 'Bad range', ...errBody }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c);
    const { id } = c.req.valid('param');
    const range = c.req.valid('query');
    const bad = dayRangeError(range);
    if (bad) throw new HttpError(400, bad);
    const out = await withStore(st.storeId, async (tx) => {
      const [a] = await tx.select({ promotionId: s.affiliate.promotionId }).from(s.affiliate)
        .where(and(eq(s.affiliate.id, id), eq(s.affiliate.storeId, st.storeId))).limit(1);
      if (!a) return null;
      return affiliateRangeStats(tx, st.storeId, a.promotionId, range, COMMISSION_PCT);
    });
    if (!out) throw new HttpError(404, 'affiliate not found');
    return c.json({ ...out, commissionPct: COMMISSION_PCT }, 200);
  }),
);

// ── bind a promotion to an affiliate email (promotion.affiliate_email) ───────
// The marketing lane's POST/PATCH /v1/admin/discounts (/v1/admin/promotions
// is now a deprecated alias for the same handler) should call
// syncPromotionAffiliate() after saving; until that call-site lands this
// endpoint is how an operator binds/unbinds a coupon to an affiliate recipient
// (bind → onboard mail; rebind → rotate + mail; clear → binding removed, the
// affiliate row stays but stops tracking new orders via the promotion).
adminAffiliate.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/affiliates/link', summary: 'Bind a promotion to an affiliate email (or clear with email:null)',
    request: { body: { content: J(z.object({ promotionId: z.string().uuid(), email: z.string().email().nullable() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ result: z.string() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const b = c.req.valid('json');
    const res = await withStore(st.storeId, async (tx) => {
      const upd = await tx.execute(sql`UPDATE promotion SET affiliate_email = ${b.email} WHERE id = ${b.promotionId} RETURNING id`);
      if (!upd.rows.length) return { kind: 'missing' as const };
      if (!b.email) return { kind: 'unbound' as const };
      return syncPromotionAffiliate(tx, st.storeId, b.promotionId, admin.email);
    });
    if (res.kind === 'missing') throw new HttpError(404, 'promotion not found');
    return c.json({ result: res.kind }, 200);
  }),
);

// ── recipient change (rotates the dashboard token — old link dies) ───────────
adminAffiliate.openapi(
  createRoute({
    method: 'patch', path: '/v1/admin/affiliates/{id}', summary: 'Reassign affiliate recipient (rotates access token)',
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({ email: z.string().email() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ id: z.string(), email: z.string(), code: z.string().nullable() })) }, 404: { description: 'Not found', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    const st = requireStore(admin, c); requireWrite(st);
    const { id } = c.req.valid('param');
    const b = c.req.valid('json');
    // reassignAffiliate: same-email saves are a no-op; a changed email rotates
    // the access token (invalidating the previous recipient's dashboard link)
    // and enqueues the rotation mail in this tx.
    const out = await withStore(st.storeId, (tx) => reassignAffiliate(tx, st.storeId, id, b.email, admin.email));
    if (!out) throw new HttpError(404, 'affiliate not found');
    return c.json(out, 200);
  }),
);

// ── settle (server-recomputes unsettled; validates amount) ───────────────────
adminAffiliate.openapi(
  createRoute({
    method: 'post', path: '/v1/admin/affiliates/{id}/settle', summary: 'Record an affiliate payout',
    request: { params: z.object({ id: z.string() }), body: { content: J(z.object({ amountCents: money.optional(), txRef: z.string().optional(), notes: z.string().optional() })) } },
    responses: { 200: { description: 'OK', content: J(z.object({ settled: money })) }, 404: { description: 'Not found', ...errBody }, 409: { description: 'Bad amount', ...errBody }, 401: { description: 'Unauthorized', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    const { admin } = await requireAdmin(c);
    // SEC: settling a payout moves money outside the order/refund ledger — gate
    // it behind an explicit permission rather than the generic write role so a
    // plain 'staff' member can't record arbitrary affiliate payouts.
    const st = requireStore(admin, c); requireWrite(st); requirePermission(st, 'affiliate_payouts');
    const { id } = c.req.valid('param');
    const b = c.req.valid('json');
    const res = await withStore(st.storeId, async (tx) => {
      const [a] = await tx.select().from(s.affiliate).where(eq(s.affiliate.id, id)).limit(1);
      if (!a) return { kind: 'notfound' as const };
      const amt = await affiliateAmounts(tx, a.promotionId);
      const pay = b.amountCents ?? amt.unsettled; // default: settle all outstanding
      if (pay <= 0 || pay > amt.unsettled) return { kind: 'bad' as const, max: amt.unsettled };
      // DD affiliate-payout.service.ts: the period starts where the previous
      // settle ended (null for the first payout) and ends now.
      const [prev] = await tx.select({ periodEndAt: s.affiliateSettle.periodEndAt }).from(s.affiliateSettle)
        .where(eq(s.affiliateSettle.promotionId, a.promotionId)).orderBy(desc(s.affiliateSettle.periodEndAt)).limit(1);
      const txRef = b.txRef?.trim() || null;
      const notes = b.notes?.trim() || null;
      await tx.insert(s.affiliateSettle).values({ storeId: st.storeId, promotionId: a.promotionId, amountCents: pay, periodStartAt: prev?.periodEndAt ?? null, periodEndAt: new Date(), txRef, notes });
      await tx.insert(s.auditLog).values({ storeId: st.storeId, actor: admin.email, entity: 'affiliate', entityId: a.id, action: 'settle', data: { amountCents: pay, txRef, notes } });
      return { kind: 'ok' as const, settled: pay };
    });
    if (res.kind === 'notfound') throw new HttpError(404, 'affiliate not found');
    if (res.kind === 'bad') throw new HttpError(409, `payout must be 1..${res.max} cents (outstanding)`);
    return c.json({ settled: res.settled }, 200);
  }),
);

// ── public self-serve dashboard (token-gated, no admin auth) ─────────────────
// Shape matches the storefront's AffiliateStatsResult contract (packages/
// storefront src/providers/shop/affiliate/affiliate.ts) — this is the REST
// replacement for the old Vendure affiliateStatsByToken GraphQL query.
// Order codes are redacted to their last 4 chars; nothing else here is
// sensitive (the token itself already gates access to one affiliate's data).
adminAffiliate.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/affiliate', summary: 'Affiliate self-serve stats (by access token)',
    request: { query: z.object({ t: z.string() }) },
    responses: { 200: { description: 'OK', content: J(z.any()) }, 404: { description: 'Not found', ...errBody }, 429: { description: 'Rate limited', ...errBody } },
  }),
  async (c) => guard(c, async () => {
    // DD affiliate-shop.resolver.ts: 30 requests / minute / IP, then a token
    // shorter than 16 chars is never valid (the token is the only credential).
    const retry = await rateLimitBackend().consume('aff-stats', clientIp(c), AFFILIATE_STATS_RATE.windowMs, AFFILIATE_STATS_RATE.max);
    if (retry > 0) { c.header('Retry-After', String(retry)); throw new HttpError(429, 'Too many requests. Try again in a minute.', 'RATE_LIMITED'); }
    const slug = c.req.header('x-store-slug') ?? devDefaultStore();
    const ctx = await resolveStore(slug);
    const { t } = c.req.valid('query');
    if (t.length < AFFILIATE_MIN_TOKEN_LENGTH) throw new HttpError(404, 'invalid affiliate link');
    const out = await withStore(ctx.id, async (tx) => {
      const [a] = await tx.select().from(s.affiliate).where(eq(s.affiliate.accessToken, t)).limit(1);
      if (!a) return null;
      const [promo] = await tx.select({ code: s.promotion.code }).from(s.promotion).where(eq(s.promotion.id, a.promotionId)).limit(1);
      const amt = await affiliateAmounts(tx, a.promotionId);
      const orderRows = await tx.select({ id: s.order.id, code: s.order.code, subtotal: s.order.subtotal, discountTotal: s.order.discountTotal, state: s.order.state, placedAt: s.order.placedAt, createdAt: s.order.createdAt })
        .from(s.order).where(and(eq(s.order.promotionId, a.promotionId), inArray(s.order.state, [...COMMISSION_STATES])))
        .orderBy(desc(sql`coalesce(${s.order.placedAt}, ${s.order.createdAt})`)).limit(AFFILIATE_ORDER_LIMIT);
      const orderIds = orderRows.map((o) => o.id);
      const itemCountRows = orderIds.length
        ? await tx.select({ orderId: s.orderLine.orderId, qty: sql<number>`sum(${s.orderLine.quantity})::int` })
            .from(s.orderLine).where(inArray(s.orderLine.orderId, orderIds)).groupBy(s.orderLine.orderId)
        : [];
      const itemCounts = new Map(itemCountRows.map((r) => [r.orderId, r.qty]));
      const settlementRows = await tx.select().from(s.affiliateSettle).where(eq(s.affiliateSettle.promotionId, a.promotionId)).orderBy(desc(s.affiliateSettle.settledAt));
      const topSellers = await affiliateTopSellers(tx, ctx.id, a.promotionId);
      // DD: the covered range runs from the oldest to the newest listed order.
      const placed = orderRows.map((o) => (o.placedAt ?? o.createdAt).toISOString());
      return {
        success: true as const,
        email: a.email,
        couponCode: promo?.code ?? null,
        rate: COMMISSION_PCT / 100,
        currency: ctx.currency,
        totals: {
          earnedUsd: amt.earned / 100,
          paidUsd: amt.settled / 100,
          owedUsd: amt.unsettled / 100,
          orderCount: amt.orders,
          rangeStart: placed.length ? placed[placed.length - 1]! : null,
          rangeEnd: placed.length ? placed[0]! : null,
        },
        orders: orderRows.map((o) => ({
          redactedCode: o.code.slice(-4).toUpperCase(),
          placedAt: (o.placedAt ?? o.createdAt).toISOString(),
          itemCount: itemCounts.get(o.id) ?? 0,
          subtotalUsd: commissionBasis(o) / 100,
          commissionUsd: Math.round(commissionBasis(o) * (COMMISSION_PCT / 100)) / 100,
          state: o.state,
        })),
        // Top 3 SKUs by quantity (DD getStats topRows).
        topProducts: topSellers.map((p) => ({ name: p.name, sku: p.sku, qtySold: p.qtySold, revenueUsd: p.revenue / 100 })),
        settles: settlementRows.map((sx) => ({
          amountUsd: sx.amountCents / 100,
          periodStartAt: sx.periodStartAt?.toISOString() ?? null,
          periodEndAt: sx.periodEndAt.toISOString(),
          settledAt: sx.settledAt.toISOString(),
          txRef: sx.txRef ?? null,
        })),
      };
    });
    if (!out) throw new HttpError(404, 'invalid affiliate link');
    return c.json(out, 200);
  }),
);
