/**
 * Shop-side loyalty points (LOYALTY-1). Read-only: points are only ever
 * SPENT through the checkout payload (`redeemPoints`, re-validated under a
 * per-customer lock inside the checkout transaction) and only ever EARNED by
 * the paid-order paths — there is no client-callable write here.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { withStore } from '../db/client.js';
import { resolveStoreFromCtx } from './store-context.js';
import { customerToken, resolveCustomer } from '../auth/session.js';
import { apiErrorSchema, errJson } from '../lib/api-error.js';
import { loyaltySettingsFromConfig, pointsToCents, type LoyaltySettings } from '../money/loyalty.js';
import { BONUS_LABELS, type BonusRule } from '../loyalty/bonus.js';
import { and, eq, isNull } from 'drizzle-orm';
import * as s from '../db/schema.js';
import { ledgerPage, loyaltyBalance } from '../loyalty/ledger.js';

export const loyalty = new OpenAPIHono();

export const PublicLoyaltySettings = z.object({
  enabled: z.boolean(),
  earnRatePerDollar: z.number().int(),
  pointsPerDollarOff: z.number().int(),
  minRedeemPoints: z.number().int(),
  maxRedeemPercentOfSubtotal: z.number().int().nullable(),
  expiryDays: z.number().int().nullable(),
  reviewBonusPoints: z.number().int(),
  reviewBonusVerifiedOnly: z.boolean(),
  signupBonusPoints: z.number().int(),
  firstOrderBonusPoints: z.number().int(),
  birthdayBonusPoints: z.number().int(),
  productMultipliers: z.array(z.object({ productId: z.string(), multiplier: z.number() })),
});

/** The shopper-visible slice of the program (never internal activation stamps). */
export function publicLoyalty(p: LoyaltySettings): z.infer<typeof PublicLoyaltySettings> {
  return {
    enabled: p.enabled, earnRatePerDollar: p.earnRatePerDollar, pointsPerDollarOff: p.pointsPerDollarOff,
    minRedeemPoints: p.minRedeemPoints, maxRedeemPercentOfSubtotal: p.maxRedeemPercentOfSubtotal, expiryDays: p.expiryDays,
    reviewBonusPoints: p.reviewBonusPoints, reviewBonusVerifiedOnly: p.reviewBonusVerifiedOnly,
    signupBonusPoints: p.signupBonusPoints > 0 && p.signupBonusSince ? p.signupBonusPoints : 0,
    firstOrderBonusPoints: p.firstOrderBonusPoints, birthdayBonusPoints: p.birthdayBonusPoints,
    productMultipliers: p.productMultipliers,
  };
}

loyalty.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/account/loyalty', summary: "Current customer's points balance + recent activity",
    responses: {
      200: {
        description: 'Balance', content: { 'application/json': { schema: z.object({
          program: PublicLoyaltySettings,
          currency: z.string(),
          balance: z.number().int(),
          available: z.number().int(),
          availableValue: z.number().int(), // cents the available points are worth
          activity: z.array(z.object({
            kind: z.string(), points: z.number().int(), createdAt: z.string(),
            expiresAt: z.string().nullable(), orderCode: z.string().nullable(),
            /** Shopper-facing description for bonus entries (e.g. "Review bonus"); null otherwise. */
            label: z.string().nullable(),
          })),
          birthday: z.object({ month: z.number().int(), day: z.number().int() }).nullable(),
        }) } },
      },
      403: { description: 'Mailbox unverified', content: { 'application/json': { schema: apiErrorSchema() } } },
      401: { description: 'Unauthenticated', content: { 'application/json': { schema: apiErrorSchema() } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const token = customerToken(c);
    const program = loyaltySettingsFromConfig(st.config);
    const out = await withStore(st.id, async (tx) => {
      const cust = token ? await resolveCustomer(tx, token) : null;
      if (!cust) return null;
      if (!cust.emailVerified) return 'unverified' as const;
      const bal = await loyaltyBalance(tx, cust.id);
      const rows = await ledgerPage(tx, cust.id, 25, cust);
      const [b] = await tx.select({ m: s.customer.birthMonth, d: s.customer.birthDay }).from(s.customer).where(eq(s.customer.id, cust.id)).limit(1);
      return { bal, rows, birthday: b?.m && b?.d ? { month: b.m, day: b.d } : null };
    });
    if (!out) return errJson(c, 401, 'NOT_AUTHENTICATED', 'not authenticated');
    if (out === 'unverified') return errJson(c, 403, 'EMAIL_NOT_VERIFIED', 'Verify your email before accessing loyalty points.');
    return c.json({
      program: publicLoyalty(program),
      currency: st.currency,
      balance: out.bal.balance,
      available: out.bal.available,
      availableValue: pointsToCents(out.bal.available, program.pointsPerDollarOff),
      // Internal actor/reason strings are admin-only; the shopper sees kinds.
      activity: out.rows.map((r) => ({
        kind: r.kind, points: r.points, createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt?.toISOString() ?? null, orderCode: r.orderCode ?? null,
        label: r.kind === 'bonus' ? (BONUS_LABELS[(r.metadata as { rule?: BonusRule } | null)?.rule as BonusRule] ?? 'Bonus') : null,
      })),
      birthday: out.birthday,
    }, 200);
  },
);

const daysIn = (month: number) => [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;

loyalty.openapi(
  createRoute({
    method: 'put', path: '/v1/shop/account/birthday', summary: 'Save the customer birthday (month + day) for the birthday bonus',
    request: { body: { content: { 'application/json': { schema: z.object({ month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) }) } } } },
    responses: {
      200: { description: 'Saved', content: { 'application/json': { schema: z.object({ month: z.number().int(), day: z.number().int() }) } } },
      400: { description: 'Invalid date', content: { 'application/json': { schema: apiErrorSchema() } } },
      401: { description: 'Unauthenticated', content: { 'application/json': { schema: apiErrorSchema() } } },
      403: { description: 'Mailbox unverified', content: { 'application/json': { schema: apiErrorSchema() } } },
      409: { description: 'Already set', content: { 'application/json': { schema: apiErrorSchema() } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const token = customerToken(c);
    const { month, day } = c.req.valid('json');
    if (day > daysIn(month)) return errJson(c, 400, 'INVALID_BIRTHDAY', 'that date does not exist');
    const out = await withStore(st.id, async (tx) => {
      const cust = token ? await resolveCustomer(tx, token) : null;
      if (!cust) return 'unauth' as const;
      if (!cust.emailVerified) return 'unverified' as const;
      // Set once: letting it change would let a shopper move their birthday
      // to claim the bonus on a chosen day. Support can correct it.
      const res = await tx.update(s.customer).set({ birthMonth: month, birthDay: day, updatedAt: new Date() })
        .where(and(eq(s.customer.id, cust.id), isNull(s.customer.birthMonth))).returning({ id: s.customer.id });
      return res.length ? 'ok' as const : 'set' as const;
    });
    if (out === 'unauth') return errJson(c, 401, 'NOT_AUTHENTICATED', 'not authenticated');
    if (out === 'unverified') return errJson(c, 403, 'EMAIL_NOT_VERIFIED', 'Verify your email first.');
    if (out === 'set') return errJson(c, 409, 'BIRTHDAY_ALREADY_SET', 'Your birthday is already saved. Contact support to change it.');
    return c.json({ month, day }, 200);
  },
);
