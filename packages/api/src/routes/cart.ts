import { shippingLabelSql } from '../lib/shipping-label.js';
import { createHash, randomUUID } from 'node:crypto';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { and, asc, eq, gt, gte, inArray, isNull, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import { withStore, type Tx } from '../db/client.js';
import { resolveStoreFromCtx } from './store-context.js';
import { type StoreCtx } from '../store-context.js';
import * as s from '../db/schema.js';
import { resolvePromotionStack } from '../money/promotion-resolver.js';
import { canonicalCouponCodes, PromotionStackError } from '../money/promotion-stack.js';
import { shippingRate, type ShippingCalculator } from '../shipping/calculator.js';
import { loyaltyBalance } from '../loyalty/ledger.js';
import { couponItemsFromFacts, loadCouponMatchContext } from '../money/coupon-context.js';
import { resolveTaxRate } from '../money/tax.js';
import { selectUnitPrice, variantPriceRuleFromConfig } from '../money/pricing.js';
import { earnableCents, loyaltySettingsFromConfig, multiplierBonusPoints, pointsEarned, planRedemption } from '../money/loyalty.js';
import { customerToken, resolveCustomer, resolveLegacySession } from '../auth/session.js';
import { normalizeEmail } from '../auth/email.js';
import { env } from '../env.js';
import { legacyCustomerToken } from '../auth/cookies.js';
import { digest } from '../import/artifacts.js';
import { cartExpiry, cartLifecycleFromConfig } from '../cart/ttl.js';
import { clientIp } from '../auth/rate-limit.js';
import { consumeCartAttempt } from './apps.limit.js';
import { MAX_CART_LINES, CartTooLargeError, boundedCartItems, cartTooLargeFields, normalizeCartLines, type CartBoundReason } from '../cart/bounds.js';
import { apiErrorSchema, errJson } from '../lib/api-error.js';

/** Per-store effective-price rule (see money/pricing.ts) — resolved from
 *  store.config.pricing.variantRule so cart and checkout price identically. */
const priceRule = (st: StoreCtx) => variantPriceRuleFromConfig(st.config);

/** Deployment-default cart lifecycle + per-store config.cart overrides (CART-04). */
const lifecycle = (st: StoreCtx) =>
  cartLifecycleFromConfig(st.config, {
    abandonAfterHours: env.CART_ABANDON_HOURS,
    ttlDays: env.CART_TTL_DAYS,
    retentionDays: env.CART_RETENTION_DAYS,
  });

export type PricedCart = {
  pricingIntent: 'preview' | 'checkout'; couponCodes: string[]; quoteHash: string; shippingMethodCode: string | null; pointsDiscount: number;
  coupons: Array<{ code: string; kind?: string; applied: boolean; reason?: string; appliedAmount: number; availableAmount?: number; remainingAmount?: number }>;
  currency: string;
  lines: Array<{ sku: string; name: string; unitPrice: number; quantity: number; lineSubtotal: number; lineDiscount: number; lineTotal: number; available: boolean; availableQuantity: number | null; isPreOrder: boolean; shipDate: string | null; shipDateLabel: string | null; image: string | null }>;
  subtotal: number; discountTotal: number; shippingTotal: number; taxTotal: number; grandTotal: number;
  unavailable: string[];
  coupon: { code: string; applied: boolean; reason?: string } | null;
};

/** True for the fulfillment types reserveStockOrThrow (orders/stock-reservation.ts)
 *  actually decrements stock for — pre-order and non-physical items are never
 *  stock-limited, so cart availability must match that rule exactly or a cart
 *  line could show "in stock" while checkout's reservation would reject it. */
export function isStockLimited(v: { isPreOrder: boolean; fulfillmentType: string | null }): boolean {
  return !v.isPreOrder && (v.fulfillmentType ?? 'physical') === 'physical';
}

/**
 * Server-authoritative cart pricing — the single source of truth shared by the
 * stateless estimate, the persisted cart GET, and any line mutation. Never
 * trusts client-supplied prices: re-reads each variant, re-selects the price,
 * re-validates the coupon. Must run inside a withStore tx.
 */
export async function priceCart(
  tx: Tx,
  st: StoreCtx,
  items: Array<{ sku: string; quantity: number }>,
  opts: { couponCode?: string; couponCodes?: string[]; pricingIntent?: 'preview' | 'checkout'; shipping?: number; shippingMethodCode?: string; redeemPoints?: number; token?: string | null; shipCountry?: string | null } = {},
): Promise<PricedCart> {
  const skus = [...new Set(items.map((i) => i.sku))];
  // Live stock join — never cached, never read from a search index. A row
  // missing from `stock` for a stock-limited variant leaves onHand/allocated
  // null, which the availability check below treats as zero (fail closed).
  const variants = skus.length
    ? await tx
        .select({
          sku: s.productVariant.sku, name: s.productVariant.name, price: s.productVariant.price, productId: s.productVariant.productId,
          salePrice: s.productVariant.salePrice, isPreOrder: s.productVariant.isPreOrder,
          shipDate: s.productVariant.shipDate, shipDateLabel: shippingLabelSql(s.productVariant.metafields),
          preOrderPrice: s.productVariant.preOrderPrice, enabled: s.productVariant.enabled,
          fulfillmentType: s.productVariant.fulfillmentType,
          onHand: s.stock.onHand, allocated: s.stock.allocated,
          // Display image: first variant asset by position, else the product's featured asset.
          image: sql<string | null>`coalesce(
            (select a.path from variant_asset va join asset a on a.id = va.asset_id where va.variant_id = ${s.productVariant.id} order by va.position asc, a.id asc limit 1),
            (select a.path from product p join asset a on a.id = p.featured_asset_id where p.id = ${s.productVariant.productId}))`,
        })
        .from(s.productVariant)
        .leftJoin(s.stock, eq(s.stock.variantId, s.productVariant.id))
        .where(and(inArray(s.productVariant.sku, skus), isNull(s.productVariant.deletedAt)))
    : [];
  const bySku = new Map(variants.map((v) => [v.sku, v]));

  const unavailable: string[] = [];
  const priced = items.map((i) => {
    const v = bySku.get(i.sku);
    // availableQuantity is null for anything not stock-limited (digital,
    // license, update_pass, pre-order) — those are never quantity-capped by
    // `stock`. For a stock-limited variant, missing stock row => 0 (fail
    // closed), never "in stock by default".
    const availableQuantity = v && isStockLimited(v) ? Math.max(0, (v.onHand ?? 0) - (v.allocated ?? 0)) : null;
    const available = !!v && v.enabled && (availableQuantity === null || availableQuantity >= i.quantity);
    if (!available) unavailable.push(i.sku);
    return { sku: i.sku, name: v?.name ?? '(unavailable)', unitPrice: v ? selectUnitPrice(v, priceRule(st)) : 0, quantity: i.quantity, available, availableQuantity, isPreOrder: v?.isPreOrder ?? false, shipDate: v?.shipDate?.toISOString() ?? null, shipDateLabel: v?.shipDateLabel ?? null, image: v?.image ?? null };
  });

  const couponCodes = canonicalCouponCodes(opts.couponCodes ?? (opts.couponCode ? [opts.couponCode] : []));
  const customer = opts.token ? await resolveCustomer(tx, opts.token) : null;
  const activeVerifications = customer?.activeVerifications ?? [];
  const couponFacts = await loadCouponMatchContext(tx, variants.map((v) => v.productId));
  const couponItems = couponItemsFromFacts(
    items.filter((i) => bySku.has(i.sku)).map((i) => ({ quantity: i.quantity, productId: bySku.get(i.sku)?.productId ?? null })), couponFacts);
  // Destination tax parity with checkout (checkout.ts): the ship-to country's
  // zone overrides the store flat rate. When the cart doesn't know a
  // shipCountry yet (no address captured pre-checkout), fall back to the flat
  // store rate — same as before this fix — so the estimate is still a number,
  // just not destination-final until an address is known.
  let taxRate = st.taxRate;
  if (opts.shipCountry) {
    const taxZones = await tx
      .select({ countries: s.taxZone.countries, rate: s.taxZone.rate, priority: s.taxZone.priority })
      .from(s.taxZone)
      .where(eq(s.taxZone.enabled, true));
    taxRate = resolveTaxRate(taxZones, opts.shipCountry, st.taxRate);
  }

  const selectedMethod = opts.shippingMethodCode
    ? (await tx.select().from(s.shippingMethod).where(and(eq(s.shippingMethod.code, opts.shippingMethodCode), eq(s.shippingMethod.enabled, true))).limit(1))[0]
    : undefined;
  const calculator = selectedMethod?.calculator as ShippingCalculator | undefined;
  const stackInput = {
    storeId: st.id, customerId: customer?.id, couponCodes, selectedCreditOnly: opts.pricingIntent === 'checkout', phase: 'AddingItems' as const,
    currency: st.currency, pricesIncludeTax: st.taxInclusive,
    lines: priced.filter(p => p.available).map((p, index) => ({ key: `${index}:${p.sku}`, quantity: p.quantity, placedQuantity: p.quantity,
      unitListPrice: p.unitPrice, priceIncludesTax: st.taxInclusive, taxRateBps: taxRate })),
    shipping: calculator ? shippingRate(calculator) : opts.shipping ?? 0,
    shippingTaxRateBps: calculator?.taxRate ?? (st.shippingTaxable ? taxRate : 0),
    shippingIncludesTax: calculator?.taxInclusive ?? st.taxInclusive,
    couponContext: { activeVerifications, items: couponItems },
  };
  let totals = await resolvePromotionStack(tx, stackInput);
  if (opts.redeemPoints && customer?.emailVerified) {
    const settings = loyaltySettingsFromConfig(st.config);
    const plan = planRedemption({ settings, requestedPoints: opts.redeemPoints,
      availablePoints: (await loyaltyBalance(tx, customer.id)).available,
      discountableCents: totals.subtotal - totals.discountTotal });
    if (plan.ok) totals = await resolvePromotionStack(tx, { ...stackInput, pointsDiscount: plan.discountCents });
  }
  const coupons = totals.coupons.map(coupon => ({ ...coupon, appliedAmount: coupon.appliedAmount ?? 0 }));
  const first = coupons[0];
  const coupon = first ? { code: first.code, applied: first.applied, ...(first.reason ? { reason: first.reason } : {}) } : null;

  let idx = 0;
  const lines = priced.map((p) => {
    if (!p.available) return { ...p, lineSubtotal: 0, lineDiscount: 0, lineTotal: 0 };
    const t = totals.lines[idx++]!;
    return { ...p, lineSubtotal: t.lineSubtotal, lineDiscount: t.lineDiscount, lineTotal: t.lineTotal };
  });

  // LOYALTY-1: preview of the points this cart would earn (same base as the
  // checkout snapshot: merchandise after discounts, excl. shipping + tax).
  // Omitted entirely while the store's program is off. Estimate only —
  // checkout computes the authoritative number and only registered
  // customers are credited.
  const loyalty = loyaltySettingsFromConfig(st.config);
  const earnBase = earnableCents({ subtotal: totals.subtotal, discountTotal: totals.discountTotal, taxRate, taxInclusive: st.taxInclusive });
  const pointsToEarn = loyalty.enabled
    ? pointsEarned(earnBase, loyalty.earnRatePerDollar) + multiplierBonusPoints({
      lines: priced.filter((p) => p.available).map((p) => ({ productId: bySku.get(p.sku)?.productId ?? '', cents: p.unitPrice * p.quantity })),
      subtotal: totals.subtotal, earnableCents: earnBase, earnRatePerDollar: loyalty.earnRatePerDollar, multipliers: loyalty.productMultipliers,
    })
    : undefined;
  return {
    currency: st.currency, lines, pricingIntent: opts.pricingIntent ?? 'preview', couponCodes: coupons.map(coupon => coupon.code), coupons, quoteHash: totals.quoteHash, shippingMethodCode: selectedMethod?.code ?? null, pointsDiscount: totals.pointsDiscount,
    subtotal: totals.subtotal, discountTotal: totals.discountTotal, shippingTotal: totals.shippingTotal,
    taxTotal: totals.taxTotal, grandTotal: totals.grandTotal, unavailable, coupon,
    ...(pointsToEarn !== undefined ? { pointsToEarn } : {}),
  };
}

const EstimateItem = z.object({ sku: z.string(), quantity: z.number().int().min(1) });
const LineOut = z.object({
  sku: z.string(), name: z.string(), unitPrice: z.number().int(), quantity: z.number().int(),
  lineSubtotal: z.number().int(), lineDiscount: z.number().int(), lineTotal: z.number().int(),
  isPreOrder: z.boolean().optional(), shipDate: z.string().nullable().optional(), shipDateLabel: z.string().nullable().optional(),
  image: z.string().nullable().optional(),
  available: z.boolean(),
  // Live (on_hand - allocated), never cached. null = not stock-limited
  // (digital/license/update_pass/pre-order) rather than "unlimited stock".
  availableQuantity: z.number().int().nullable(),
});
export const CouponCodes = z.array(z.string().min(1).max(255)).max(100);
export const CouponCodesQuery = z.string().transform((value, ctx) => {
  try { return CouponCodes.parse(JSON.parse(value)); } catch { ctx.addIssue({ code: 'custom', message: 'couponCodes must be a JSON string array' }); return z.NEVER; }
}).optional();
export const EstimateOut = z.object({
  pricingIntent: z.enum(['preview', 'checkout']), couponCodes: CouponCodes, quoteHash: z.string(), shippingMethodCode: z.string().nullable(), pointsDiscount: z.number().int(),
  coupons: z.array(z.object({ code: z.string(), kind: z.string().optional(), applied: z.boolean(), reason: z.string().optional(), appliedAmount: z.number().int(), availableAmount: z.number().int().optional(), remainingAmount: z.number().int().optional() })),
  currency: z.string(),
  lines: z.array(LineOut),
  subtotal: z.number().int(), discountTotal: z.number().int(), shippingTotal: z.number().int(),
  taxTotal: z.number().int(), grandTotal: z.number().int(),
  unavailable: z.array(z.string()),
  coupon: z.object({ code: z.string(), applied: z.boolean(), reason: z.string().optional() }).nullable(),
  /** Present only when the store's loyalty program is enabled. */
  pointsToEarn: z.number().int().optional(),
});

export const cart = new OpenAPIHono();
const publicCartBudget: import('hono').MiddlewareHandler = async (c, next) => {
  const st = await resolveStoreFromCtx(c);
  const retry = await consumeCartAttempt(st.id, clientIp(c));
  if (retry > 0) return errJson(c, 429, 'RATE_LIMITED', `too many attempts — try again in ${retry}s`);
  await next();
};
// Hono's wildcard matches the root too; register once to consume once.
cart.use('/v1/shop/cart/*', publicCartBudget);
export function promotionStackErrorJson(c: Context, error: PromotionStackError) {
  return error.code === 'CREDIT_AMOUNT_CHANGED'
    ? errJson(c, 409, 'CREDIT_AMOUNT_CHANGED', error.message)
    : errJson(c, 409, 'CREDIT_ALLOCATION_INVALID', error.message);
}
cart.onError((error, c) => {
  if (error instanceof PromotionStackError) return promotionStackErrorJson(c, error);
  if (error instanceof CartTooLargeError) return errJson(c, 409, 'CART_TOO_LARGE', error.message, { extra: cartTooLargeFields(error) });
  throw error;
});

// POST /v1/shop/cart/estimate — server re-prices the cart (never trusts client prices)
cart.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/cart/estimate',
    summary: 'Estimate cart totals (server-priced)',
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({ items: z.array(EstimateItem).min(1).max(MAX_CART_LINES), shipping: z.number().int().min(0).default(0), couponCode: z.string().optional(), couponCodes: CouponCodes.optional(), pricingIntent: z.enum(['preview', 'checkout']).optional(), shippingMethodCode: z.string().optional(), redeemPoints: z.number().int().min(1).optional(), shipCountry: z.string().optional() }),
          },
        },
      },
    },
    responses: {
      200: { description: 'Estimate', content: { 'application/json': { schema: EstimateOut } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { items, ...quoteOptions } = c.req.valid('json');
    const token = customerToken(c);
    const result = await withStore(st.id, (tx) => priceCart(tx, st, items, { ...quoteOptions, token }));
    return c.json(result, 200);
  },
);

// ── Persisted cart (first-class checkout resource) ────────────────────────────
// A cart is identified by an opaque `token` the client stores (cookie/localStorage).
// All pricing is server-authoritative (priceCart). Lines snapshot the SKU so they
// survive variant deletion; variantId is kept when resolvable for stock joins.

const CartLineIn = z.object({ sku: z.string(), quantity: z.number().int().min(0) });
export const CartOut = EstimateOut.extend({
  token: z.string(),
  status: z.string(),
  email: z.string().nullable(),
  customerId: z.string().nullable(),
  // Monotonic optimistic-concurrency counter (CART-03). Echo it back as
  // expectedRevision on every non-append mutation (set/remove a line,
  // identity attach, merge, checkout conversion); only the blind append path
  // may omit it (see mutationBlocker's contract note).
  revision: z.number().int(),
});
/** Machine-readable reason on a 409: 'converted'/'merged' = terminal cart,
 *  'stale' = expectedRevision mismatch, 'revision_required' = the mutation
 *  needs a base revision it didn't carry. */
export const CartConflictCode = z.enum(['converted', 'merged', 'stale', 'revision_required']);
export type CartConflictCode = z.infer<typeof CartConflictCode>;
/** 409 body for terminal-guard, missing-revision, and stale-revision
 *  rejections: the code + current revision + a freshly re-priced snapshot so
 *  the client can recover. */
export const CartConflictOut = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
  }),
  code: CartConflictCode,
  revision: z.number().int(),
  cart: CartOut,
});
const CartTooLargeOut = apiErrorSchema().extend({
  status: z.string(), revision: z.number().int(), code: CartConflictCode.optional(),
});
/** Initial legacy transfer is absolute, one-shot & transactionally receipted. */
const LegacyMigrationIn = z.object({
  claimId: z.string().uuid(),
  // null means no browser snapshot; [] is an authoritative empty browser cart.
  items: z.array(z.object({ variantId: z.string().regex(/^\d{1,20}$/), quantity: z.number().int().min(1).max(9999) })).max(200).nullable(),
  couponCode: z.string().max(200).nullable().optional(),
  couponCodes: CouponCodes.optional(),
  countryCode: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
}).strict();
cart.openapi(createRoute({ method: 'post', path: '/v1/shop/cart/legacy-migration',
  summary: 'Adopt a frozen Vendure cart or reconcile a browser snapshot once',
  request: { body: { content: { 'application/json': { schema: LegacyMigrationIn } } } },
  responses: {
    200: { description: 'Committed receipt', content: { 'application/json': { schema: z.object({
      receipt: z.string(), cart: CartOut.nullable(), couponCode: z.string().nullable(), countryCode: z.string().nullable(),
      unresolved: z.array(z.object({ variantId: z.string(), quantity: z.number().int() })),
    }) } } },
    429: { description: 'Rate limited', content: { 'application/json': { schema: apiErrorSchema() } } },
    409: { description: 'Source cart already changed', content: { 'application/json': { schema: apiErrorSchema() } } },
  },
}), async c => {
  const st = await resolveStoreFromCtx(c);
  const body = c.req.valid('json');
  const authToken = customerToken(c);
  const sourceToken = authToken ?? legacyCustomerToken(c);
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const claimHash = hash(body.claimId);
  const payloadHash = digest({ items: body.items, couponCode: body.couponCode ?? null, countryCode: body.countryCode ?? null,
    ...(body.couponCodes !== undefined ? { couponCodes: body.couponCodes } : {}) });
  const result = await withStore(st.id, async tx => {
    // Serializes first insert as well as retry. Cart row lock below is shared with all ordinary mutations.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`legacy-cart:${st.id}:${claimHash}`}, 0))`);
    const [existing] = await tx.select().from(s.legacyCartClaim).where(and(eq(s.legacyCartClaim.storeId, st.id), eq(s.legacyCartClaim.claimHash, claimHash)));
    if (existing && existing.payloadHash !== payloadHash) return { conflict: true } as const;
    const [grant] = sourceToken ? await tx.select().from(s.legacySessionGrant).where(and(
      eq(s.legacySessionGrant.storeId, st.id), eq(s.legacySessionGrant.tokenHash, hash(sourceToken)),
      gt(s.legacySessionGrant.expiresAt, new Date()),
    )).for('update') : [];
    // Authenticated grants require the SAME still-live target session; logout/reset must not resurrect access.
    if (grant?.authenticated && (!authToken || !await resolveLegacySession(tx, st.id, authToken))) return { conflict: true } as const;
    if (existing?.grantId && grant?.id !== existing.grantId) return { conflict: true } as const;
    if (!existing && grant && body.items !== null) {
      const [claimed] = await tx.select({ id: s.legacyCartClaim.id }).from(s.legacyCartClaim).where(and(eq(s.legacyCartClaim.grantId, grant.id), eq(s.legacyCartClaim.sourceOnly, false)));
      if (claimed) return { conflict: true } as const;
    }
    const receipt = existing;
    const cartId = receipt ? receipt.cartId : grant?.cartId;
    let [row] = cartId ? await tx.select().from(s.cart).where(and(
      eq(s.cart.storeId, st.id), eq(s.cart.id, cartId),
    )).for('update') : [];
    const localCouponCodes = canonicalCouponCodes(body.couponCodes ?? (body.couponCode ? [body.couponCode] : []));
    const couponCode = receipt ? receipt.couponCode : body.items !== null ? localCouponCodes[0] ?? null : grant?.couponCode ?? null;
    const countryCode = receipt?.countryCode ?? body.countryCode ?? grant?.countryCode ?? null;
    // Every replay checks the locked cart before returning its capability. A finished cart stays retired.
    const usable = row && ['active', 'abandoned'].includes(row.status) && row.expiresAt !== null && row.expiresAt.getTime() > Date.now();
    if (receipt) {
      if (receipt.retiredAt || !usable) {
        if (!receipt.retiredAt) await tx.update(s.legacyCartClaim).set({ retiredAt: new Date(), cartId: null }).where(eq(s.legacyCartClaim.id, receipt.id));
        return { receipt: body.claimId, cart: null, couponCode: null, countryCode, unresolved: receipt.unresolved };
      }
      return { receipt: body.claimId, cart: await cartResponse(tx, st, row!, undefined, authToken, countryCode),
        couponCode, countryCode, unresolved: receipt.unresolved };
    }
    if (body.items === null) {
      // A new tab/claim cannot re-adopt a source cart after its first durable adoption.
      const [consumed] = grant ? await tx.select({ id: s.legacyCartClaim.id }).from(s.legacyCartClaim).where(and(
        eq(s.legacyCartClaim.grantId, grant.id), eq(s.legacyCartClaim.sourceOnly, true),
      )) : [];
      if (consumed) return { receipt: body.claimId, cart: null, couponCode: null, countryCode, unresolved: [] };
      await tx.insert(s.legacyCartClaim).values({ id: randomUUID(), storeId: st.id, claimHash, payloadHash,
        grantId: grant?.id ?? null, sourceOnly: true, cartId: usable ? row!.id : null,
        retiredAt: usable ? null : new Date(), couponCode, countryCode });
      return { receipt: body.claimId,
        cart: usable ? await cartResponse(tx, st, row!, undefined, authToken, countryCode) : null,
        couponCode, countryCode, unresolved: [] };
    }
    const quantities = new Map<string, number>();
    for (const item of body.items) {
      const quantity = (quantities.get(item.variantId) ?? 0) + item.quantity;
      if (quantity > 9999) return { conflict: true } as const;
      quantities.set(item.variantId, quantity);
    }
    if (row && (!usable || row.revision !== 0)) return { conflict: true } as const;
    if (row) {
      const [claimed] = await tx.select({ id: s.legacyCartClaim.id }).from(s.legacyCartClaim).where(and(eq(s.legacyCartClaim.cartId, row.id), eq(s.legacyCartClaim.sourceOnly, false)));
      if (claimed) return { conflict: true } as const;
    } else {
      const customer = authToken ? await resolveCustomer(tx, authToken) : null;
      [row] = await tx.insert(s.cart).values({ storeId: st.id, token: randomUUID(), customerId: grant?.customerId ?? customer?.id ?? null,
        expiresAt: cartExpiry(new Date(), lifecycle(st).ttlDays) }).returning();
    }
    if (!row) throw new Error('Cart insert failed');
    const unresolved: Array<{ variantId: string; quantity: number }> = [];
    const lines: Array<{ sku: string; quantity: number }> = [];
    for (const [variantId, quantity] of quantities) {
      const variants = await tx.select({ sku: s.productVariant.sku }).from(s.productVariant).where(and(
        eq(s.productVariant.storeId, st.id), sql`${s.productVariant.metafields}->>'vendureId' = ${variantId}`,
      ));
      if (variants.length !== 1) {
        unresolved.push({ variantId, quantity });
        lines.push({ sku: `vendure-unresolved:${variantId}`, quantity });
      } else lines.push({ sku: variants[0]!.sku, quantity });
    }
    // Local blob & source active order describe ONE cart. Replace, never append.
    await tx.delete(s.cartLine).where(and(eq(s.cartLine.storeId, st.id), eq(s.cartLine.cartId, row.id)));
    row = (await applyLines(tx, st, row, lines))!;
    [row] = await tx.update(s.cart).set({ couponCodes: localCouponCodes }).where(eq(s.cart.id, row.id)).returning();
    if (!row) throw new Error('Cart coupon update failed');
    await tx.insert(s.legacyCartClaim).values({ id: randomUUID(), storeId: st.id, claimHash, payloadHash,
      grantId: grant?.id ?? null, cartId: row.id, couponCode, countryCode, unresolved });
    return { receipt: body.claimId, cart: await cartResponse(tx, st, row, undefined, authToken, countryCode),
      couponCode, countryCode, unresolved };
  });
  c.header('Cache-Control', 'no-store');
  if ('conflict' in result) return errJson(c, 409, 'LEGACY_MIGRATION_CONFLICT', 'Saved cart changed; preserve browser cart & retry after reconciliation');
  return c.json(result, 200);
});

type CartRow = typeof s.cart.$inferSelect;

/** Map each SKU to its (live) variant id, for cart_line.variantId. */
async function variantIdsBySku(tx: Tx, skus: string[]): Promise<Map<string, string>> {
  if (!skus.length) return new Map();
  const rows = await tx
    .select({ sku: s.productVariant.sku, id: s.productVariant.id })
    .from(s.productVariant)
    .where(and(inArray(s.productVariant.sku, skus), isNull(s.productVariant.deletedAt)));
  return new Map(rows.map((r) => [r.sku, r.id]));
}

/** Build the full cart response (meta + server-priced lines). Exported so
 *  checkout can return the same snapshot on stale-write conflicts. */
export async function cartResponse(tx: Tx, st: StoreCtx, cartRow: CartRow, couponCode?: string | string[], token?: string | null, shipCountry?: string | null, quoteOptions: { pricingIntent?: 'preview' | 'checkout'; shippingMethodCode?: string; redeemPoints?: number; conflictCode?: CartBoundReason } = {}): Promise<z.infer<typeof CartOut>> {
  const items = await boundedCartItems(tx, cartRow, quoteOptions.conflictCode);
  const codes = Array.isArray(couponCode) ? couponCode : couponCode !== undefined ? [couponCode] : cartRow.couponCodes;
  const priced = await priceCart(tx, st, items, { couponCodes: codes, token, shipCountry, ...quoteOptions });
  // Terminal carts are historical facts; their credit bearer codes stay private.
  const caller = token ? await resolveCustomer(tx, token) : null;
  if (['converted', 'merged'].includes(cartRow.status) || (cartRow.customerId && caller?.id !== cartRow.customerId)) {
    const creditPromotions = await tx.select({ code: s.promotion.code }).from(s.promotion).where(eq(s.promotion.type, 'account_credit'));
    const privateCodes = new Set(creditPromotions.flatMap(promotion => promotion.code ? [promotion.code.toLowerCase()] : []));
    priced.couponCodes = priced.couponCodes.filter(code => !privateCodes.has(code.toLowerCase()));
    priced.coupons = priced.coupons.filter(c => !privateCodes.has(c.code.toLowerCase()));
    if (priced.coupon && privateCodes.has(priced.coupon.code.toLowerCase())) priced.coupon = null;
  }
  return { ...priced, token: cartRow.token, status: cartRow.status, email: cartRow.email, customerId: cartRow.customerId, revision: cartRow.revision };
}

const CONFLICT_COPY: Record<CartConflictCode, string> = {
  converted: 'cart already converted to an order',
  merged: 'cart was merged into another cart',
  stale: 'cart changed — refresh and retry',
  revision_required: 'expectedRevision is required for this mutation — read the cart and echo its revision',
};

/** 409 body for a rejected cart mutation: the CURRENT revision + repriced
 *  snapshot so the caller can merge and retry (CART-03) or learn the cart is
 *  terminal (CART-02/CART-05). */
async function cartConflict(c: Context, tx: Tx, st: StoreCtx, row: CartRow, code: CartConflictCode, authToken?: string | null, shipCountry?: string | null, quoteOptions: { pricingIntent?: 'preview' | 'checkout'; shippingMethodCode?: string; redeemPoints?: number } = {}) {
  const requestId = (c.var as { requestId?: string } | undefined)?.requestId;
  return {
    error: { code: code.toUpperCase(), message: CONFLICT_COPY[code], ...(requestId ? { requestId } : {}) },
    code, revision: row.revision, cart: await cartResponse(tx, st, row, undefined, authToken, shipCountry, { ...quoteOptions, conflictCode: code }),
  };
}

/**
 * Upsert/remove cart lines (quantity 0 removes in 'set' mode). The caller
 * must hold a FOR UPDATE lock on `cartRow` and have already run the
 * terminal/stale guards. Touches updatedAt, extends the TTL, bumps the
 * revision, and re-activates a cart the abandonment job flipped to
 * 'abandoned' — a returning shopper resumes it.
 *
 * `mode` is the revision-contract switch:
 *  - 'set'       — absolute write; quantity 0 deletes the row. Only ever run
 *                  after the caller proved its base via expectedRevision.
 *  - 'increment' — blind append (no base revision): an existing SKU row is
 *                  summed (quantity += incoming) so concurrent adds commute
 *                  instead of last-writer-wins losing one. Quantity-0 lines
 *                  are contractually unreachable here (the route 409s them)
 *                  and are skipped defensively.
 *
 * A converted or merged cart is terminal: the UPDATE's status whitelist
 * ('active'/'abandoned' only) means a racing conversion or merge can never
 * be overwritten or resurrected; returns the updated row or null if the cart
 * was concurrently retired (defensive — unreachable while the caller holds
 * the row lock).
 */
async function writeCartLines(tx: Tx, st: StoreCtx, cartId: string, lines: Array<{ sku: string; quantity: number }>, mode: 'set' | 'increment' | 'merge') {
  const removed = lines.filter(line => line.quantity <= 0).map(line => line.sku);
  if (removed.length && mode === 'set') await tx.delete(s.cartLine).where(and(eq(s.cartLine.cartId, cartId), inArray(s.cartLine.sku, removed)));
  const positive = lines.filter(line => line.quantity > 0);
  if (!positive.length) return;
  const vids = await variantIdsBySku(tx, positive.map(line => line.sku));
  await tx.insert(s.cartLine).values(positive.map(line => ({ storeId: st.id, cartId, ...line, variantId: vids.get(line.sku) ?? null })))
    .onConflictDoUpdate({ target: [s.cartLine.cartId, s.cartLine.sku], set: {
      quantity: mode === 'set' ? sql`excluded.quantity` : sql`${s.cartLine.quantity} + excluded.quantity`,
      // Merge moves quantities only; an existing target keeps its historical
      // variant association even if this SKU now resolves elsewhere or nowhere.
      ...(mode === 'merge' ? {} : { variantId: sql`excluded.variant_id` }),
    } });
}

async function applyLines(tx: Tx, st: StoreCtx, cartRow: CartRow, lines: Array<{ sku: string; quantity: number }>, opts: { mode?: 'set' | 'increment' } = {}): Promise<CartRow | null> {
  const mode = opts.mode ?? 'set';
  const normalized = normalizeCartLines(lines, mode);
  // Exclude final removals in SQL so oversized imported carts can be reduced
  // without loading their full historical contents. Unknown SKUs count too.
  const removed = normalized.filter(line => line.quantity <= 0).map(line => line.sku);
  const remaining = await tx.select({ sku: s.cartLine.sku }).from(s.cartLine)
    .where(and(eq(s.cartLine.cartId, cartRow.id), removed.length ? notInArray(s.cartLine.sku, removed) : undefined))
    .limit(MAX_CART_LINES + 1);
  const projected = new Set(remaining.map(line => line.sku));
  for (const line of normalized) if (line.quantity > 0) projected.add(line.sku);
  if (remaining.length > MAX_CART_LINES || projected.size > MAX_CART_LINES) throw new CartTooLargeError(cartRow);
  await writeCartLines(tx, st, cartRow.id, normalized, mode);
  const now = new Date();
  const [updated] = await tx
    .update(s.cart)
    .set({ updatedAt: now, expiresAt: cartExpiry(now, lifecycle(st).ttlDays), status: 'active', revision: sql`${s.cart.revision} + 1` })
    .where(and(eq(s.cart.id, cartRow.id), inArray(s.cart.status, ['active', 'abandoned'])))
    .returning();
  return updated ?? null;
}

/** Shared guard for mutation routes: row must exist, not be terminal, and —
 *  when the caller passed expectedRevision — match it. Callers select the
 *  cart FOR UPDATE.
 *
 *  REVISION CONTRACT (explicit boundary): expectedRevision is REQUIRED on
 *  every non-append mutation — line quantity update or remove, identity/email
 *  attach, merge, and checkout's cart conversion. A missing expectedRevision
 *  on those is a 409 'revision_required' — NOT 'stale', since there is no
 *  base to compare — and callers pass `revisionRequired: true` (PATCH lines
 *  passes it only when the request isn't append-only). The ONE exception is
 *  the blind append path: a lines-PATCH whose lines are all quantity ≥ 1 may
 *  omit the revision because applyLines 'increment' mode is commutative — an
 *  existing SKU row is summed, never overwritten, so two blind writers can't
 *  lose each other's adds.
 *
 *  Terminal statuses 'converted' (has an order) and 'merged' (folded into
 *  another cart, lines moved out) reject every mutation — a 409 in both
 *  cases, and terminality is checked BEFORE the revision guard so a stale
 *  client learns the real reason. */
function mutationBlocker(row: CartRow | undefined, expectedRevision: number | undefined, opts: { revisionRequired: boolean }): 'missing' | CartConflictCode | null {
  if (!row) return 'missing';
  if (row.status === 'converted') return 'converted';
  if (row.status === 'merged') return 'merged';
  if (expectedRevision == null) return opts.revisionRequired ? 'revision_required' : null;
  if (row.revision !== expectedRevision) return 'stale';
  return null;
}

// POST /v1/shop/cart — create a cart, optionally seeded with lines.
cart.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/cart', summary: 'Create a cart',
    request: { body: { content: { 'application/json': { schema: z.object({ items: z.array(CartLineIn).max(MAX_CART_LINES).optional(), email: z.string().email().optional(), couponCode: z.string().optional(), couponCodes: CouponCodes.optional() }) } } } },
    responses: {
      200: { description: 'Cart', content: { 'application/json': { schema: CartOut } } },
      429: { description: 'Rate limited', content: { 'application/json': { schema: apiErrorSchema() } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const body = c.req.valid('json');
    const authTok = customerToken(c);
    const out = await withStore(st.id, async (tx) => {
      const customer = authTok ? await resolveCustomer(tx, authTok) : null;
      const token = randomUUID();
      const [row] = await tx
        .insert(s.cart)
        .values({ storeId: st.id, token, couponCodes: canonicalCouponCodes(body.couponCodes ?? (body.couponCode ? [body.couponCode] : [])), customerId: customer?.id ?? null, email: body.email ? normalizeEmail(body.email) : null, expiresAt: cartExpiry(new Date(), lifecycle(st).ttlDays) })
        .returning();
      const seed = (body.items ?? []).filter((l) => l.quantity > 0);
      const cur = seed.length ? (await applyLines(tx, st, row!, seed)) ?? row! : row!;
      return cartResponse(tx, st, cur, body.couponCodes ?? body.couponCode, authTok);
    });
    return c.json(out, 200);
  },
);

// GET /v1/shop/cart/{token} — fetch a cart, server-repriced.
cart.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/cart/{token}', summary: 'Get a cart',
    request: { params: z.object({ token: z.string() }), query: z.object({ couponCode: z.string().optional(), couponCodes: CouponCodesQuery, pricingIntent: z.enum(['preview', 'checkout']).optional(), shippingMethodCode: z.string().optional(), redeemPoints: z.coerce.number().int().min(1).optional(), shipCountry: z.string().optional() }) },
    responses: { 200: { description: 'Cart', content: { 'application/json': { schema: CartOut } } }, 409: { description: 'Cart exceeds line budget', content: { 'application/json': { schema: CartTooLargeOut } } }, 404: { description: 'Not found', content: { 'application/json': { schema: apiErrorSchema() } } } },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { token } = c.req.valid('param');
    const { couponCode, couponCodes, shipCountry, shippingMethodCode, redeemPoints, pricingIntent } = c.req.valid('query');
    const authTok = customerToken(c);
    const out = await withStore(st.id, async (tx) => {
      const [row] = await tx.select().from(s.cart).where(eq(s.cart.token, token)).limit(1);
      if (!row) return null;
      return cartResponse(tx, st, row, couponCodes ?? couponCode, authTok, shipCountry, { shippingMethodCode, redeemPoints, pricingIntent });
    });
    if (!out) return errJson(c, 404, 'CART_NOT_FOUND', 'cart not found');
    return c.json(out, 200);
  },
);

// PATCH /v1/shop/cart/{token}/lines — upsert/remove lines (quantity 0 removes).
// CART-02/03: the cart row is taken FOR UPDATE so line edits serialize against
// checkout conversion; a terminal cart (converted/merged) rejects (never
// resurrected). Revision contract: an all-positive request is a blind APPEND —
// usable without expectedRevision and applied as commutative increments — while
// an absolute update or any remove (quantity 0) requires expectedRevision and
// applies as an absolute set. See mutationBlocker for the contract.
cart.openapi(
  createRoute({
    method: 'patch', path: '/v1/shop/cart/{token}/lines', summary: 'Update cart lines',
    request: { params: z.object({ token: z.string() }), body: { content: { 'application/json': { schema: z.object({ lines: z.array(CartLineIn).max(MAX_CART_LINES), couponCode: z.string().optional(), couponCodes: CouponCodes.optional(), pricingIntent: z.enum(['preview', 'checkout']).optional(), shippingMethodCode: z.string().optional(), redeemPoints: z.number().int().min(1).optional(), shipCountry: z.string().optional(), expectedRevision: z.number().int().optional() }) } } } },
    responses: {
      200: { description: 'Cart', content: { 'application/json': { schema: CartOut } } },
      404: { description: 'Not found', content: { 'application/json': { schema: apiErrorSchema() } } },
      409: { description: 'Terminal, missing-revision, or stale cart', content: { 'application/json': { schema: z.union([CartConflictOut, CartTooLargeOut]) } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { token } = c.req.valid('param');
    const body = c.req.valid('json');
    const authTok = customerToken(c);
    const out = await withStore(st.id, async (tx) => {
      const [row] = await tx.select().from(s.cart).where(eq(s.cart.token, token)).limit(1).for('update');
      // Append-only requests (every line quantity ≥ 1) commute and need no
      // base; a remove or absolute set is a non-append mutation and must
      // carry expectedRevision (409 'revision_required' when absent).
      const appendsOnly = body.couponCodes === undefined && body.couponCode === undefined && body.lines.length > 0 && body.lines.every((l) => l.quantity > 0);
      const quoteOptions = { pricingIntent: body.pricingIntent, shippingMethodCode: body.shippingMethodCode, redeemPoints: body.redeemPoints };
      const block = mutationBlocker(row, body.expectedRevision, { revisionRequired: !appendsOnly });
      if (block === 'missing') return { code: 404 as const };
      if (block) return { code: 409 as const, body: await cartConflict(c, tx, st, row!, block, authTok, body.shipCountry, quoteOptions) };
      let updated = await applyLines(tx, st, row!, body.lines, { mode: body.expectedRevision == null ? 'increment' : 'set' });
      if (!updated) return { code: 409 as const, body: await cartConflict(c, tx, st, row!, 'converted', authTok, body.shipCountry, quoteOptions) };
      if (body.couponCodes !== undefined || body.couponCode !== undefined) {
        const [couponUpdated] = await tx.update(s.cart).set({ couponCodes: canonicalCouponCodes(body.couponCodes ?? (body.couponCode ? [body.couponCode] : [])) }).where(eq(s.cart.id, updated.id)).returning();
        if (!couponUpdated) throw new Error('Cart coupon update failed');
        updated = couponUpdated;
      }
      return { code: 200 as const, body: await cartResponse(tx, st, updated, undefined, authTok, body.shipCountry, quoteOptions) };
    });
    if (out.code === 404) return errJson(c, 404, 'CART_NOT_FOUND', 'cart not found');
    if (out.code === 409) return c.json(out.body, 409);
    return c.json(out.body, 200);
  },
);

// PATCH /v1/shop/cart/{token} — capture identity (abandoned-cart recovery).
// Stores the email on the cart and links an existing account if one matches.
// NOTE: a captured email is NOT verified account ownership — it only marks
// where a recovery nudge would go (CART-04).
cart.openapi(
  createRoute({
    method: 'patch', path: '/v1/shop/cart/{token}', summary: 'Capture cart identity (email)',
    request: { params: z.object({ token: z.string() }), body: { content: { 'application/json': { schema: z.object({ email: z.string().email(), expectedRevision: z.number().int().optional() }) } } } },
    responses: {
      200: { description: 'Cart', content: { 'application/json': { schema: CartOut } } },
      404: { description: 'Not found', content: { 'application/json': { schema: apiErrorSchema() } } },
      409: { description: 'Converted or stale cart', content: { 'application/json': { schema: z.union([CartConflictOut, CartTooLargeOut]) } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { token } = c.req.valid('param');
    const { email, expectedRevision } = c.req.valid('json');
    const out = await withStore(st.id, async (tx) => {
      const [row] = await tx.select().from(s.cart).where(eq(s.cart.token, token)).limit(1).for('update');
      const block = mutationBlocker(row, expectedRevision, { revisionRequired: true });
      if (block === 'missing') return { code: 404 as const };
      if (block) return { code: 409 as const, body: await cartConflict(c, tx, st, row!, block) };
      await boundedCartItems(tx, row!);
      const norm = normalizeEmail(email);
      const [acct] = await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.email, norm)).limit(1);
      const [updated] = await tx
        .update(s.cart)
        .set({ email: norm, customerId: row!.customerId ?? acct?.id ?? null, updatedAt: new Date(), revision: sql`${s.cart.revision} + 1` })
        .where(and(eq(s.cart.id, row!.id), inArray(s.cart.status, ['active', 'abandoned'])))
        .returning();
      if (!updated) return { code: 409 as const, body: await cartConflict(c, tx, st, row!, 'converted') };
      return { code: 200 as const, body: await cartResponse(tx, st, updated) };
    });
    if (out.code === 404) return errJson(c, 404, 'CART_NOT_FOUND', 'cart not found');
    if (out.code === 409) return c.json(out.body, 409);
    return c.json(out.body, 200);
  },
);

// POST /v1/shop/cart/{token}/merge — on login, claim the guest cart for the
// authenticated customer and fold their other active carts into it.
// CART-02/03: the target + every foldable cart are locked FOR UPDATE in a
// canonical id order (two concurrent merges can't ABBA-deadlock, and a
// checkout conversion can't slip between the scan and the retire write). A
// converted target rejects; expectedRevision (query param) guards staleness.
cart.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/cart/{token}/merge', summary: 'Merge guest cart into the logged-in customer',
    request: { params: z.object({ token: z.string() }), query: z.object({ expectedRevision: z.coerce.number().int().optional() }) },
    responses: {
      200: { description: 'Cart', content: { 'application/json': { schema: CartOut } } },
      401: { description: 'Auth required', content: { 'application/json': { schema: apiErrorSchema() } } },
      404: { description: 'Not found', content: { 'application/json': { schema: apiErrorSchema() } } },
      409: { description: 'Converted or stale cart', content: { 'application/json': { schema: z.union([CartConflictOut, CartTooLargeOut]) } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { token } = c.req.valid('param');
    const { expectedRevision } = c.req.valid('query');
    const authTok = customerToken(c);
    const res = await withStore(st.id, async (tx) => {
      const customer = authTok ? await resolveCustomer(tx, authTok) : null;
      if (!customer) return { code: 401 as const };
      const [found] = await tx.select({ id: s.cart.id }).from(s.cart).where(eq(s.cart.token, token)).limit(1);
      if (!found) return { code: 404 as const };

      // Choose at most 201 total candidates, then acquire the same sorted
      // lock order as every merge. Never silently merge only the first 200.
      const candidates = await tx.select({ id: s.cart.id }).from(s.cart).where(and(
        ne(s.cart.id, found.id), eq(s.cart.customerId, customer.id), eq(s.cart.status, 'active'), isNull(s.cart.convertedOrderId),
      )).orderBy(asc(s.cart.id)).limit(MAX_CART_LINES);
      const chosenIds = [found.id, ...candidates.map(row => row.id)];
      const locked = await tx.select().from(s.cart).where(inArray(s.cart.id, chosenIds)).orderBy(asc(s.cart.id)).for('update');
      const row = locked.find(candidate => candidate.id === found.id);
      const block = mutationBlocker(row, expectedRevision, { revisionRequired: true });
      if (block === 'missing') return { code: 404 as const };
      if (block) return { code: 409 as const, body: await cartConflict(c, tx, st, row!, block, authTok) };
      if (chosenIds.length > MAX_CART_LINES) throw new CartTooLargeError(row!);
      // FOR UPDATE rechecks current eligibility after any lock wait.
      const others = locked.filter(other => other.id !== row!.id && other.customerId === customer.id && other.status === 'active' && other.convertedOrderId === null);
      const targetItems = await boundedCartItems(tx, row!);
      const union = new Set(targetItems.map(line => line.sku));
      const donorQuantities = new Map<string, number>();
      for (const other of others) {
        let lines;
        try { lines = await boundedCartItems(tx, other); } catch (error) {
          if (error instanceof CartTooLargeError) throw new CartTooLargeError(row!);
          throw error;
        }
        for (const line of lines) {
          union.add(line.sku);
          if (union.size > MAX_CART_LINES) throw new CartTooLargeError(row!);
          donorQuantities.set(line.sku, (donorQuantities.get(line.sku) ?? 0) + line.quantity);
        }
      }
      // No quantity, ownership, coupon, revision, or donor retirement changes
      // happen until every bounded donor and the complete union pass.
      await writeCartLines(tx, st, row!.id, [...donorQuantities].map(([sku, quantity]) => ({ sku, quantity })), 'merge');
      const donorIds = others.map(other => other.id);
      if (donorIds.length) {
        await tx.delete(s.cartLine).where(inArray(s.cartLine.cartId, donorIds));
        await tx.update(s.cart).set({ status: 'merged', updatedAt: new Date(), revision: sql`${s.cart.revision} + 1` })
          .where(and(inArray(s.cart.id, donorIds), eq(s.cart.status, 'active'), isNull(s.cart.convertedOrderId)));
      }

      const [updated] = await tx.update(s.cart).set({ customerId: customer.id, updatedAt: new Date(), revision: sql`${s.cart.revision} + 1` })
        .where(and(eq(s.cart.id, row!.id), inArray(s.cart.status, ['active', 'abandoned'])))
        .returning();
      if (!updated) return { code: 409 as const, body: await cartConflict(c, tx, st, row!, 'converted', authTok) };
      return { code: 200 as const, body: await cartResponse(tx, st, updated, undefined, authTok) };
    });
    if (res.code === 401) return errJson(c, 401, 'AUTH_REQUIRED', 'authentication required to merge');
    if (res.code === 404) return errJson(c, 404, 'CART_NOT_FOUND', 'cart not found');
    if (res.code === 409) return c.json(res.body, 409);
    return c.json(res.body, 200);
  },
);
