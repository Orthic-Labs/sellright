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
import { loyaltySettingsFromConfig, pointsToCents } from '../money/loyalty.js';
import { ledgerPage, loyaltyBalance } from '../loyalty/ledger.js';

export const loyalty = new OpenAPIHono();

export const PublicLoyaltySettings = z.object({
  enabled: z.boolean(),
  earnRatePerDollar: z.number().int(),
  pointsPerDollarOff: z.number().int(),
  minRedeemPoints: z.number().int(),
  maxRedeemPercentOfSubtotal: z.number().int().nullable(),
  expiryDays: z.number().int().nullable(),
});

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
          })),
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
      return { bal, rows };
    });
    if (!out) return errJson(c, 401, 'NOT_AUTHENTICATED', 'not authenticated');
    if (out === 'unverified') return errJson(c, 403, 'EMAIL_NOT_VERIFIED', 'Verify your email before accessing loyalty points.');
    return c.json({
      program,
      currency: st.currency,
      balance: out.bal.balance,
      available: out.bal.available,
      availableValue: pointsToCents(out.bal.available, program.pointsPerDollarOff),
      // Internal actor/reason strings are admin-only; the shopper sees kinds.
      activity: out.rows.map((r) => ({
        kind: r.kind, points: r.points, createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt?.toISOString() ?? null, orderCode: r.orderCode ?? null,
      })),
    }, 200);
  },
);
