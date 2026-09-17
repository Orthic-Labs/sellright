import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, count, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { withStore, type Tx } from '../db/client.js';
import { resolveStoreFromCtx } from './store-context.js';
import * as s from '../db/schema.js';
import { calculateOrderTotals, type Promotion } from '../money/totals.js';
import { evaluateCoupon, productFacetIds } from '../money/coupon.js';
import { selectAutomaticPromotion } from '../money/auto-discount.js';
import { resolveTaxRate } from '../money/tax.js';
import { selectUnitPrice, variantPriceRuleFromConfig } from '../money/pricing.js';
import { applyGiftCard } from '../money/gift-card.js';
import { emitEvent } from '../webhooks/emit.js';
import { customerToken, resolveCustomer } from '../auth/session.js';
import { normalizeEmail } from '../auth/email.js';
import { reserveStockOrThrow, StockReservationError, validateReservableItems } from '../orders/stock-reservation.js';
import { isMethodEligible, shippingRate, ShippingUnavailableError } from '../shipping/calculator.js';
import { pickEmailAppKey } from '../email/dispatch.js';
import { orderConfirmation as orderConfirmationTpl } from '../email/templates.js';
import { enqueueEmail } from '../email/outbox.js';
import { enqueuePush, buildOrderPushPayload, buildOrderLiveActivityPayload } from '../push/outbox.js';
import { env } from '../env.js';
import { clientIp, loginRetryAfter } from '../auth/rate-limit.js';
import { issueLicensesForPaidOrder } from '../licensing/issue.js';
import { bootstrapAccountAndQueueAccessMail } from '../licensing/account-bootstrap.js';
import { legalReceiptForOrder, type OrderLegalReceipt } from '../legal/acceptance.js';
import { legalManifestForApp } from '../legal/manifests.js';
import { cartResponse, CartOut } from './cart.js';

/** Mirror of email/dispatch.ts::parseAppMap — duplicated here to avoid an
 * internal export just for the outbox enqueue path. */
function parseAppFromMap(raw: string | undefined, appKey: string | null | undefined): string | undefined {
  const key = appKey?.trim().toLowerCase();
  if (!key || !raw?.trim()) return undefined;
  for (const entry of raw.split(/[,\n;]/)) {
    const idx = entry.indexOf('=');
    if (idx <= 0) continue;
    if (entry.slice(0, idx).trim().toLowerCase() === key) return entry.slice(idx + 1).trim();
  }
  return undefined;
}

/**
 * Canonical address shape for the order snapshot — matches the `address` table
 * (line1/line2/country), so the snapshot and the saved-address book agree.
 * Accepts either the canonical keys OR the storefront's Vendure-ish ones
 * (streetLine1/countryCode) and maps to canonical. Unknown extras are dropped.
 */
function normalizeAddress(a: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!a) return null;
  const g = (k: string) => (a[k] != null ? String(a[k]) : null);
  return {
    fullName: g('fullName') ?? ([g('firstName'), g('lastName')].filter(Boolean).join(' ') || null),
    line1: g('line1') ?? g('streetLine1'),
    line2: g('line2') ?? g('streetLine2'),
    city: g('city'),
    province: g('province') ?? g('state'),
    postalCode: g('postalCode') ?? g('postal_code') ?? g('zip'),
    country: g('country') ?? g('countryCode'),
    phone: g('phone') ?? g('phoneNumber'),
  };
}

const orderCode = () => ('SR' + randomUUID().replace(/-/g, '').slice(0, 10)).toUpperCase();

/**
 * CART-01: stable fingerprint of the semantic checkout payload, persisted on
 * the order (metadata.checkoutFingerprint) so an Idempotency-Key replay can be
 * validated — the same key with a CHANGED payload is a 409 conflict, not a
 * silent replay of an order the client didn't mean to resubmit.
 *
 * Canonicalized: items are sorted (a retry may serialize a differently-ordered
 * local cart) and addresses go through normalizeAddress (drops unknown extras,
 * unifies key aliases). Client `items` are EXCLUDED when cartToken is present
 * — with a server cart the items are derived from the cart itself (never the
 * client list), so a retry carrying a stale local list still replays.
 */
/** Canonicalize a client JSON claim for fingerprinting: object keys sorted
 *  recursively so a semantically-identical resubmission hashes the same even
 *  if the client serialized keys in a different order. */
function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stableJson(v)]),
    );
  }
  return value ?? null;
}

function checkoutFingerprint(body: {
  items: Array<{ sku: string; quantity: number }>;
  cartToken?: string;
  couponCode?: string;
  giftCardCode?: string;
  shippingMethodCode?: string;
  email?: string;
  shippingAddress?: Record<string, unknown>;
  billingAddress?: Record<string, unknown>;
  legalAcceptance?: Record<string, unknown>;
}): string {
  const items = body.cartToken
    ? null
    : [...body.items]
        .map((i) => ({ sku: i.sku, quantity: i.quantity }))
        .sort((a, b) => a.sku.localeCompare(b.sku) || a.quantity - b.quantity);
  return createHash('sha256').update(JSON.stringify({
    v: 1,
    cartToken: body.cartToken ?? null,
    items,
    couponCode: body.couponCode ?? null,
    giftCardCode: body.giftCardCode ?? null,
    shippingMethodCode: body.shippingMethodCode ?? null,
    email: body.email ? normalizeEmail(body.email) : null,
    shippingAddress: normalizeAddress(body.shippingAddress),
    billingAddress: normalizeAddress(body.billingAddress),
    // The legal-acceptance claim is part of the semantic payload: a replayed
    // key carrying a DIFFERENT acceptance is a payload mismatch (409), never a
    // silent re-verification skip.
    legalAcceptance: stableJson(body.legalAcceptance),
  })).digest('hex');
}

/** Does this stored order satisfy a replay of `fingerprint`? A stored
 *  fingerprint always validates; orders predating fingerprinting have none
 *  and replay as before (scoped legacy compatibility — the window where an
 *  old key could be replayed with a mutated payload is bounded by the fact
 *  that keys were already treated as single-use). */
export function fingerprintMatches(orderMetadata: unknown, fingerprint: string): boolean {
  const stored = (orderMetadata as { checkoutFingerprint?: unknown } | null)?.checkoutFingerprint;
  return typeof stored !== 'string' || stored === fingerprint;
}

/** Uniform replay payload for "this checkout already produced an order" —
 *  used by both the Idempotency-Key replay and the converted-cart recovery
 *  paths so retries always describe the same order. giftCardApplied is
 *  re-derived from the settled gift_card tender rows so the replay matches
 *  the original response. */
async function orderReplayResult(
  tx: Tx,
  o: { id: string; code: string; state: string; grandTotal: number; discountTotal: number; receiptToken: string | null },
) {
  const r = await tx.execute(sql`SELECT coalesce(sum(amount), 0)::int AS applied FROM payment WHERE order_id = ${o.id} AND method = 'gift_card' AND state = 'Settled'`);
  const giftCardApplied = Number((r.rows[0] as { applied: number } | undefined)?.applied ?? 0);
  return {
    code: o.code, state: o.state, grandTotal: o.grandTotal, discountTotal: o.discountTotal,
    couponApplied: o.discountTotal > 0, giftCardApplied, replay: true as const, receiptToken: o.receiptToken ?? '',
  };
}

export const checkout = new OpenAPIHono();

// POST /v1/shop/checkout — create an order from a cart (PendingPayment).
// Re-prices server-side, RE-VALIDATES the coupon server-side (never trusts the
// client), allocates stock atomically (no oversell), persists order + snapshot
// lines + promotion linkage/usage. Payment is a separate step on the order.
checkout.openapi(
  createRoute({
    method: 'post',
    path: '/v1/shop/checkout',
    summary: 'Create an order from a cart',
    request: {
      headers: z.object({ 'idempotency-key': z.string().optional() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({
              items: z.array(z.object({ sku: z.string(), quantity: z.number().int().min(1) })).min(1).max(200),
              // Server-authoritative shipping. The legacy numeric `shipping`
              // field remains accepted for client compatibility but is ignored:
              // physical carts require a configured method; non-physical carts
              // are always zero-shipping.
              shippingMethodCode: z.string().optional(),
              shipping: z.number().int().min(0).default(0),
              couponCode: z.string().optional(),
              giftCardCode: z.string().optional(), // applied as a tender against the order total
              cartToken: z.string().optional(), // when set, the cart is marked converted on success
              // CART-03: REQUIRED optimistic-concurrency check against
              // cart.revision whenever cartToken is present — the cart
              // conversion is a non-append mutation (see mutationBlocker's
              // contract note in cart.ts). Missing → 409 'revision_required';
              // mismatched → 409 'stale' + the current cart snapshot instead
              // of converting a cart the client no longer recognizes.
              expectedRevision: z.number().int().optional(),

              email: z.string().email().optional(),
              shippingAddress: z.record(z.string(), z.unknown()).optional(),
              billingAddress: z.record(z.string(), z.unknown()).optional(),
              // Legal acceptance claim — required only when the cart contains
              // a licensed product whose appKey has a manifest configured under
              // store.config.legalManifests; verified server-side, never trusted.
              legalAcceptance: z.record(z.string(), z.unknown()).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Order created',
        content: { 'application/json': { schema: z.object({ code: z.string(), state: z.string(), grandTotal: z.number().int(), discountTotal: z.number().int(), currency: z.string(), couponApplied: z.boolean(), giftCardApplied: z.number().int(), receiptToken: z.string() }) } },
      },
      409: { description: 'Out of stock / shipping unavailable / idempotency-payload or stale-cart conflict', content: { 'application/json': { schema: z.object({ error: z.string(), code: z.string().optional(), skus: z.array(z.string()).optional(), reason: z.string().optional(), revision: z.number().int().optional(), cart: CartOut.optional() }) } } },
      422: { description: 'Required legal acceptance is missing or invalid', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      429: { description: 'Rate limited', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const body = c.req.valid('json');
    const idemKey = c.req.header('idempotency-key') || null;
    const token = customerToken(c);
    // Rate-limit: throttle anonymous checkout spam (an authenticated customer
    // is bound by the same window — login is the friction point if it's a
    // bot behind a credential-stuffing script).
    const ip = clientIp(c);
    const checkoutBucket = `checkout:${token ?? ip}`;
    const checkoutRetry = loginRetryAfter(ip, checkoutBucket);
    if (checkoutRetry > 0) return c.json({ error: `too many checkouts — try again in ${checkoutRetry}s` }, 429);

    const fingerprint = checkoutFingerprint(body);

    type Result = { blocked: string[] } | { shippingError: string } | { cartError: string } | { legalError: string } | { cartConflict: { code: 'stale' | 'revision_required'; snapshot: z.infer<typeof CartOut> } } | { fingerprintConflict: true } | { code: string; state: string; grandTotal: number; discountTotal: number; couponApplied: boolean; replay?: boolean; giftCardApplied?: number; receiptToken: string };
    const out = await withStore(st.id, async (tx): Promise<Result> => {
      // Idempotency: same key -> the same order (also guarded by a unique index),
      // bound to the request fingerprint — a reused key with a different payload
      // is a conflict, not a replay of an order the client didn't resubmit.
      if (idemKey) {
        const [existing] = await tx
          .select({ id: s.order.id, code: s.order.code, state: s.order.state, grandTotal: s.order.grandTotal, discountTotal: s.order.discountTotal, receiptToken: s.order.receiptToken, metadata: s.order.metadata })
          .from(s.order)
          .where(eq(s.order.idempotencyKey, idemKey))
          .limit(1);
        if (existing) {
          if (!fingerprintMatches(existing.metadata, fingerprint)) return { fingerprintConflict: true };
          return orderReplayResult(tx, existing);
        }
      }

      // Server-authoritative cart: when a cartToken is present the server cart is
      // the source of truth — derive the items from it and NEVER fall back to the
      // client item list (a fallback re-opens trust-the-client; council P1). With
      // no token (legacy local-cart path) client items are used, still re-priced.
      let items = body.items;
      let cartRow: typeof s.cart.$inferSelect | null = null;
      if (body.cartToken) {
        // CART-01/02/03: FOR UPDATE serializes conversion against every other
        // cart writer (line edits, identity capture, merge, lifecycle jobs)
        // for the rest of this txn — concurrent same-cart submissions queue on
        // this row and the loser finds the cart already converted, replays the
        // order, and never creates a second one.
        const [row] = await tx.select().from(s.cart).where(eq(s.cart.token, body.cartToken)).limit(1).for('update');
        if (!row) return { cartError: 'cart is empty, invalid, or already checked out' };
        if (row.status === 'converted') {
          // Terminal cart: resume the ORIGINAL order (payment recovery /
          // lost-response retry) — one cart, one order, always.
          const [o] = row.convertedOrderId
            ? await tx
                .select({ id: s.order.id, code: s.order.code, state: s.order.state, grandTotal: s.order.grandTotal, discountTotal: s.order.discountTotal, receiptToken: s.order.receiptToken })
                .from(s.order)
                .where(and(eq(s.order.id, row.convertedOrderId), isNull(s.order.deletedAt)))
                .limit(1)
            : [];
          if (o) return orderReplayResult(tx, o);
          return { cartError: 'cart is empty, invalid, or already checked out' };
        }
        // 'merged' is terminal like 'converted' but has no order to resume —
        // its lines moved into another cart at merge time (CART-05).
        if (row.status === 'merged') {
          return { cartError: 'cart is empty, invalid, or already checked out' };
        }
        // The conversion is a non-append mutation: expectedRevision is
        // REQUIRED — a missing base 409s 'revision_required' (distinct from
        // 'stale'), a mismatched base 409s 'stale' + the current snapshot.
        const conflictShipCountry = (normalizeAddress(body.shippingAddress) as { country?: string } | null)?.country ?? null;
        if (body.expectedRevision == null) {
          return { cartConflict: { code: 'revision_required' as const, snapshot: await cartResponse(tx, st, row, body.couponCode, token, conflictShipCountry) } };
        }
        if (row.revision !== body.expectedRevision) {
          return { cartConflict: { code: 'stale' as const, snapshot: await cartResponse(tx, st, row, body.couponCode, token, conflictShipCountry) } };
        }
        const lines = await tx.select({ sku: s.cartLine.sku, quantity: s.cartLine.quantity }).from(s.cartLine).where(eq(s.cartLine.cartId, row.id));
        if (!lines.length) return { cartError: 'cart is empty, invalid, or already checked out' };
        items = lines.map((l) => ({ sku: l.sku, quantity: l.quantity })); // fail-closed
        cartRow = row;
      }
      const skus = [...new Set(items.map((i) => i.sku))];

      const variants = await tx
        .select()
        .from(s.productVariant)
        .where(and(inArray(s.productVariant.sku, skus), isNull(s.productVariant.deletedAt)));
      const bySku = new Map(variants.map((v) => [v.sku, v]));

      const blocked = validateReservableItems(items, bySku);
      if (blocked.length) return { blocked };

      // Legal acceptance (ported upstream from RightSites). A licensed variant
      // opts in via catalog metadata — fulfillment_type 'license'/'update_pass'
      // plus app_key — AND a manifest configured under
      // store.config.legalManifests[appKey]. The submitted claim is verified
      // byte-for-byte against the CONFIGURED manifest (client-supplied
      // ids/versions/hashes are never trusted) and the resulting receipt is
      // persisted on the order below. Licensed products with no configured
      // manifest require NOTHING — zero behavior change for merchants that
      // haven't opted in.
      let legalReceipt: OrderLegalReceipt | null = null;
      {
        const coveredAppKeys = new Set<string>();
        for (const v of variants) {
          if (!v.appKey || !['license', 'update_pass'].includes(v.fulfillmentType)) continue;
          if (legalManifestForApp(st.config, v.appKey)) coveredAppKeys.add(v.appKey);
        }
        // One receipt per order → all manifest-covered licensed items must
        // resolve to a single configured app (upstream's same constraint).
        if (coveredAppKeys.size > 1) {
          return { legalError: 'licensed checkout must contain one configured app' };
        }
        if (coveredAppKeys.size === 1) {
          const appKey = [...coveredAppKeys][0]!;
          try {
            legalReceipt = legalReceiptForOrder(legalManifestForApp(st.config, appKey)!, body.legalAcceptance, new Date());
          } catch (error) {
            return { legalError: error instanceof Error ? error.message : 'legal acceptance is invalid' };
          }
        }
      }
      await reserveStockOrThrow(tx, st.id, items, bySku);

      const priceRule = variantPriceRuleFromConfig(st.config);
      const priced = items.map((i) => {
        const v = bySku.get(i.sku)!;
        return { v, qty: i.quantity, unitPrice: selectUnitPrice(v, priceRule) };
      });

      // ── Shipping: always server-authoritative. Physical carts MUST use a
      // configured method; software/digital carts never need a shipping method
      // and are deterministically zero-shipping. Client-supplied body.shipping
      // is accepted for backwards wire compatibility but intentionally ignored.
      const subtotalCents = priced.reduce((a, p) => a + p.unitPrice * p.qty, 0);
      const shipCountry = (normalizeAddress(body.shippingAddress) as { country?: string } | null)?.country ?? null;
      const requiresShipping = priced.some((p) => p.v.fulfillmentType === 'physical');
      const methods = requiresShipping
        ? await tx.select().from(s.shippingMethod).where(eq(s.shippingMethod.enabled, true))
        : [];
      let shippingAmount: number;
      let shippingCalculator: import('../shipping/calculator.js').ShippingCalculator | undefined;
      if (!requiresShipping) {
        shippingAmount = 0;
      } else if (body.shippingMethodCode) {
        const m = methods.find((x) => x.code === body.shippingMethodCode);
        if (!m) throw new ShippingUnavailableError('method_not_found');
        shippingCalculator = m.calculator as import('../shipping/calculator.js').ShippingCalculator;
        shippingAmount = shippingRate(m.calculator);
      } else if (methods.length > 0) {
        // Methods exist but none chosen — force an explicit, validated selection.
        throw new ShippingUnavailableError('method_required');
      } else {
        // A physical order with no server shipping configuration is a store
        // misconfiguration, not permission for the shopper to choose the price.
        throw new ShippingUnavailableError('not_configured');
      }

      // Verification BENEFITS require an authenticated session — a guest can't
      // claim another account's verified status via the email field (that was a
      // real auth-bypass). But still LINK the order to an existing account by
      // email so guest-checkout order history + per-customer coupon limits work.
      const sessionCustomer = token ? await resolveCustomer(tx, token) : null;
      const activeVerifications = sessionCustomer?.activeVerifications ?? [];
      let customerId = sessionCustomer?.id ?? null;
      // WP9.5: guest auto-link by email. Keep the link (so abandoned-cart
      // recovery + per-customer coupon limits work) but mark how it was linked
      // in the order metadata. The account-order list filters on this so an
      // unverified-email link doesn't surface someone else's orders in their
      // account until the email is verified.
      let linkedVia: 'session' | 'email_match' | null = sessionCustomer ? 'session' : null;
      if (!customerId && body.email) {
        const [byEmail] = await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.email, normalizeEmail(body.email))).limit(1);
        customerId = byEmail?.id ?? null;
        if (customerId) linkedVia = 'email_match';
      }

      // ── Discount: explicit coupon OR best automatic; re-validate server-side
      //    + enforce usage limits ──────────────────────────────────────────────
      let promotion: Promotion | undefined;
      let promoId: string | null = null;
      {
        const now = new Date();
        const timeValid = and(
          or(isNull(s.promotion.startsAt), lte(s.promotion.startsAt, now)),
          or(isNull(s.promotion.endsAt), gte(s.promotion.endsAt, now)),
        );
        let promo: typeof s.promotion.$inferSelect | undefined;
        if (body.couponCode) {
          [promo] = await tx
            .select()
            .from(s.promotion)
            .where(and(eq(s.promotion.code, body.couponCode), eq(s.promotion.enabled, true), timeValid))
            .limit(1);
        } else {
          // No code → apply the best eligible AUTOMATIC promotion (code IS NULL).
          const autos = await tx
            .select()
            .from(s.promotion)
            .where(and(isNull(s.promotion.code), eq(s.promotion.enabled, true), timeValid));
          const best = selectAutomaticPromotion(
            autos.map((a) => ({ id: a.id, type: a.type, value: a.value, conditions: a.conditions, priority: a.priority })),
            { subtotal: subtotalCents, activeVerifications, items: priced.map(p => ({ quantity: p.qty, facetValueIds: productFacetIds(p.v.metafields) })) },
          );
          promo = best ? autos.find((a) => a.id === best.id) : undefined;
        }
        if (promo) {
          // Serialize concurrent redemptions of THIS promo: take a row lock and
          // re-read usedCount under it, so the global/per-customer limit checks
          // and the usedCount increment below can't race (check-then-increment).
          // The lock is held until the txn commits.
          const lockRes = await tx.execute(sql`SELECT used_count FROM promotion WHERE id = ${promo.id} FOR UPDATE`);
          const usedNow = (lockRes as unknown as { rows: Array<{ used_count: number }> }).rows[0]?.used_count ?? promo.usedCount;
          const globalOk = promo.usageLimit == null || usedNow < promo.usageLimit;
          let perCustomerOk = true;
          if (promo.perCustomerUsageLimit != null && customerId) {
            const usedRows = await tx
              .select({ n: count() })
              .from(s.promotionUsage)
              .where(and(eq(s.promotionUsage.promotionId, promo.id), eq(s.promotionUsage.customerId, customerId)));
            perCustomerOk = (usedRows[0]?.n ?? 0) < promo.perCustomerUsageLimit;
          }
          const ev = evaluateCoupon(
            { type: promo.type, value: promo.value, conditions: promo.conditions },
            { subtotal: subtotalCents, activeVerifications, items: priced.map(p => ({ quantity: p.qty, facetValueIds: productFacetIds(p.v.metafields) })) },
          );
          // Apply only if valid AND within limits; else proceed at full price
          // (server is authoritative — the returned grandTotal is the truth).
          if (globalOk && perCustomerOk && ev.valid && ev.promotion) { promotion = ev.promotion; promoId = promo.id; }
        }
      }

      // Destination tax: the ship-to country's zone overrides the store flat rate.
      const taxZones = await tx
        .select({ countries: s.taxZone.countries, rate: s.taxZone.rate, priority: s.taxZone.priority })
        .from(s.taxZone)
        .where(eq(s.taxZone.enabled, true));
      const taxRate = resolveTaxRate(taxZones, shipCountry, st.taxRate);

      const discounted = calculateOrderTotals({ lines: priced.map(p => ({ unitPrice: p.unitPrice, quantity: p.qty })),
        shipping: 0, taxRate, taxInclusive: st.taxInclusive, promotion });
      if (shippingCalculator && !isMethodEligible(shippingCalculator, { subtotal: subtotalCents, country: shipCountry,
        discountedSubtotalWithTax: discounted.grandTotal })) throw new ShippingUnavailableError('not_eligible');
      const totals = calculateOrderTotals({
        shippingTaxRate: shippingCalculator?.taxRate, shippingTaxInclusive: shippingCalculator?.taxInclusive,
        lines: priced.map((p) => ({ unitPrice: p.unitPrice, quantity: p.qty })),
        shipping: shippingAmount, taxRate, taxInclusive: st.taxInclusive, shippingTaxable: st.shippingTaxable, promotion,
      });

      const orderId = randomUUID();
      const code = orderCode();
      // High-entropy receipt token (32 bytes, base64url) → scopes the public
      // order-by-code read on the confirmation page (carried as ?rt=). Never
      // bare-code (P1): the order code is ~enumerable.
      const receiptToken = randomBytes(32).toString('base64url');
      await tx.insert(s.order).values({
        id: orderId, storeId: st.id, code, customerId, state: 'PendingPayment', currency: st.currency,
        idempotencyKey: idemKey, promotionId: promoId, receiptToken,
        subtotal: totals.subtotal, discountTotal: totals.discountTotal, shippingTotal: totals.shippingTotal,
        taxTotal: totals.taxTotal, grandTotal: totals.grandTotal,
        isPreOrder: priced.some((p) => p.v.isPreOrder),
        shippingAddress: normalizeAddress(body.shippingAddress), billingAddress: normalizeAddress(body.billingAddress),
        // WP9.5: attach the link provenance to the order metadata. The account
        // order-list endpoint reads this to suppress email_match-linked orders
        // until the customer verifies the email.
        metadata: { ...(linkedVia ? { linked_via: linkedVia } : {}),
          contact: { email: normalizeEmail(sessionCustomer?.email ?? body.email ?? '') },
          taxInclusive: st.taxInclusive,
          // CART-01: binds the idempotency key to this payload — a replay with
          // the same key but a different payload is a 409, not a silent replay.
          checkoutFingerprint: fingerprint,
          // Immutable legal-acceptance receipt (canonical configured values,
          // verified above) for manifest-configured licensed products.
          ...(legalReceipt ? { legal_acceptance: legalReceipt } : {}) },
      });
      await tx.insert(s.orderLine).values(
        priced.map((p, idx) => ({
          storeId: st.id, orderId, variantId: p.v.id, variantSku: p.v.sku, variantName: p.v.name,
          quantity: p.qty, unitPrice: p.unitPrice,
          lineSubtotal: totals.lines[idx]!.lineSubtotal, lineDiscount: totals.lines[idx]!.lineDiscount,
          lineTax: 0, lineTotal: totals.lines[idx]!.lineTotal,
        })),
      );

      // Record promotion usage + bump the global counter (idempotent on order).
      if (promoId) {
        await tx.insert(s.promotionUsage).values({ storeId: st.id, promotionId: promoId, customerId, orderId });
        await tx.update(s.promotion).set({ usedCount: sql`${s.promotion.usedCount} + 1` }).where(eq(s.promotion.id, promoId));
      }

      let giftCardApplied = 0;
      let paid = false;

      // A server-computed zero-total order has no payment operation to perform.
      // Settle it atomically here so the browser never has to invent a Paid
      // state and digital/license fulfillment follows the same issuance path as
      // a real settled tender. No synthetic zero-value payment ledger row is
      // created because no money moved.
      if (totals.grandTotal === 0) {
        const paidAt = new Date();
        await tx.update(s.order).set({ state: 'Paid', placedAt: paidAt, updatedAt: paidAt }).where(eq(s.order.id, orderId));
        await issueLicensesForPaidOrder(tx, { storeId: st.id, orderId, customerId, paidAt });
        paid = true;
      } else if (body.giftCardCode) {
        // Gift card / store credit is a tender, not a discount. The launch
        // invariant requires it to cover the full amount due; applyGiftCard
        // returns inapplicable without drawing when the balance is insufficient.
        const [gc] = await tx.select().from(s.giftCard).where(eq(s.giftCard.code, body.giftCardCode)).limit(1).for('update');
        if (gc) {
          const appn = applyGiftCard({ balance: gc.balance, enabled: gc.enabled, expiresAt: gc.expiresAt }, totals.grandTotal, new Date());
          if (appn.applicable) {
            await tx.insert(s.payment).values({ storeId: st.id, orderId, amount: appn.applied, method: 'gift_card', state: 'Settled' });
            await tx.update(s.giftCard).set({ balance: appn.newBalance, updatedAt: new Date() }).where(eq(s.giftCard.id, gc.id));
            await tx.insert(s.giftCardTransaction).values({ storeId: st.id, giftCardId: gc.id, orderId, amount: -appn.applied });
            giftCardApplied = appn.applied;
            if (appn.remainingDue <= 0) {
              const paidAt = new Date();
              await tx.update(s.order).set({ state: 'Paid', placedAt: paidAt, updatedAt: paidAt }).where(eq(s.order.id, orderId));
              await issueLicensesForPaidOrder(tx, { storeId: st.id, orderId, customerId, paidAt });
              paid = true;
            }
          }
        }
      }

      // Cart → order conversion (atomic with the order): retire the cart + emit
      // a lifecycle event so funnel analytics / recovery can mark it converted.
      // The row lock was taken above and the UPDATE is status-guarded, so this
      // is the single transition to 'converted' — convertedOrderId is written
      // exactly once and is never moved after this (CART-02).
      if (cartRow) {
        const [converted] = await tx
          .update(s.cart)
          .set({ status: 'converted', convertedOrderId: orderId, revision: sql`${s.cart.revision} + 1`, updatedAt: new Date() })
          .where(and(eq(s.cart.id, cartRow.id), inArray(s.cart.status, ['active', 'abandoned']), isNull(s.cart.convertedOrderId)))
          .returning({ id: s.cart.id });
        // Unreachable while the FOR UPDATE lock above is held; if it ever
        // fires we MUST roll back the just-inserted order rather than leave an
        // orphan with an unconverted cart — hence a throw, not a cartError.
        if (!converted) throw new Error('cart conversion raced — cart was already converted');
        await emitEvent(tx, st.id, 'cart.converted', { token: body.cartToken, orderId, code });
      }

      // Webhook events (transactional outbox — enqueued in the same txn).
      await emitEvent(tx, st.id, 'order.created', { code, grandTotal: totals.grandTotal, currency: st.currency });
      if (paid) await emitEvent(tx, st.id, 'order.paid', { code, grandTotal: totals.grandTotal, currency: st.currency });

      // Purchase → account bootstrap for the SYNCHRONOUS paid paths (zero-total
      // order, full gift-card cover): they settle here and never reach
      // payments/settle.ts's Paid branch (where enqueuePaidEffects runs this
      // for the async paths), so they call it directly. Idempotent per order —
      // a session/email-match checkout already carries customerId and no-ops —
      // and the claim mail is dedupeKey'd in the outbox.
      if (paid) {
        await bootstrapAccountAndQueueAccessMail(tx, { storeId: st.id, orderId, existingCustomerId: customerId });
      }

      // Mobile push, same txn / same reasoning as the email outbox below: a
      // rolled-back order must not ding anyone's phone. Only the money-real
      // event pushes — 'order.created' fires for unpaid/pending orders too, and
      // an alert per abandoned checkout attempt would train operators to ignore
      // the app. No-ops when no device is registered for the store.
      if (paid) {
        await enqueuePush(tx, st.id, {
          topic: 'order.paid',
          payload: buildOrderPushPayload({ topic: 'order.paid', code, grandTotal: totals.grandTotal, currency: st.currency }),
        });
        // Live Activity (Dynamic Island) for the same order — a separate token
        // family, so a device registered for both gets one alert AND one
        // activity. No-ops for devices below iOS 17.2 (they never register a
        // push-to-start token).
        await enqueuePush(tx, st.id, {
          topic: 'order.paid',
          kind: 'live_activity',
          payload: buildOrderLiveActivityPayload({
            code,
            grandTotal: totals.grandTotal,
            currency: st.currency,
            // `priced` is the server-repriced line set the order was actually
            // built from — body lines are client-supplied and may not exist on
            // the cart-token path at all.
            itemCount: priced.reduce((n, p) => n + p.qty, 0),
          }),
        });
      }

      // REL-4: order-confirmation email goes through the email outbox. Enqueue
      // inside this txn so a rollback drops the email too — never send for an
      // order that didn't actually pay. Best-effort recipient: the customer's
      // email if linked, else the guest email on the request. No SMTP at this
      // call site — the scheduler (jobs/scheduler.ts) delivers with retry +
      // dead-letter, mirroring the webhook_outbox claim.
      if (paid) {
        const [cust] = customerId
          ? await tx.select({ email: s.customer.email }).from(s.customer).where(eq(s.customer.id, customerId)).limit(1)
          : [];
        const recipient = normalizeEmail(cust?.email ?? body.email ?? '');
        if (recipient) {
          const lines = await tx
            .select({
              name: s.orderLine.variantName,
              quantity: s.orderLine.quantity,
              lineTotal: s.orderLine.lineTotal,
              appKey: s.productVariant.appKey,
            })
            .from(s.orderLine)
            .leftJoin(s.productVariant, eq(s.productVariant.id, s.orderLine.variantId))
            .where(eq(s.orderLine.orderId, orderId));
          const appKey = pickEmailAppKey(lines.map((line) => line.appKey));
          // Mirror dispatch.ts's emailCtx() — derive the same per-store sender
          // and storefront URL the inline path produced, so the rendered email
          // is byte-identical to before (constraint: do NOT change the body).
          const fromEmail = env.EMAIL_FROM_BY_APP
            ? parseAppFromMap(env.EMAIL_FROM_BY_APP, appKey) ?? env.SMTP_FROM
            : env.SMTP_FROM;
          const storefrontUrl = env.STOREFRONT_URL_BY_APP
            ? parseAppFromMap(env.STOREFRONT_URL_BY_APP, appKey) ?? env.STOREFRONT_URL
            : env.STOREFRONT_URL;
          const rendered = orderConfirmationTpl(
            { name: st.name, currency: st.currency, storefrontUrl, fromEmail },
            { code, grandTotal: totals.grandTotal, currency: st.currency, lines: lines.map(({ name, quantity, lineTotal }) => ({ name, quantity, lineTotal })) },
          );
          await enqueueEmail(tx, st.id, {
            kind: 'order_confirmation',
            recipient,
            payload: { to: recipient, from: fromEmail, subject: rendered.subject, html: rendered.html, text: rendered.text },
          });
        }
      }
      return { code, state: paid ? 'Paid' : 'PendingPayment', grandTotal: totals.grandTotal, discountTotal: totals.discountTotal, couponApplied: promoId != null, giftCardApplied, receiptToken };
    }).catch(async (e: unknown): Promise<Result> => {
      // Concurrent double-submit with the same Idempotency-Key: the unique
      // (store, key) index rejected the loser; its txn (incl. allocation) rolled
      // back. Return the winner's order in a fresh read — still fingerprint-bound.
      if (idemKey && (e as { code?: string })?.code === '23505') {
        return withStore(st.id, async (tx): Promise<Result> => {
          const [o] = await tx
            .select({ id: s.order.id, code: s.order.code, state: s.order.state, grandTotal: s.order.grandTotal, discountTotal: s.order.discountTotal, receiptToken: s.order.receiptToken, metadata: s.order.metadata })
            .from(s.order)
            .where(eq(s.order.idempotencyKey, idemKey))
            .limit(1);
          if (o) {
            if (!fingerprintMatches(o.metadata, fingerprint)) return { fingerprintConflict: true };
            return orderReplayResult(tx, o);
          }
          throw e;
        });
      }
      if (e instanceof StockReservationError) return { blocked: e.skus };
      if (e instanceof ShippingUnavailableError) return { shippingError: e.reason };
      throw e;
    });

    if ('shippingError' in out) return c.json({ error: 'shipping unavailable', reason: out.shippingError }, 409);
    if ('cartError' in out) return c.json({ error: out.cartError }, 409);
    if ('legalError' in out) return c.json({ error: out.legalError }, 422);
    if ('blocked' in out) return c.json({ error: 'unavailable or out of stock', skus: out.blocked }, 409);
    if ('fingerprintConflict' in out) return c.json({ error: 'idempotency-key was already used with a different payload', reason: 'payload_mismatch' }, 409);
    if ('cartConflict' in out) return c.json({
      error: out.cartConflict.code === 'revision_required'
        ? 'expectedRevision is required for checkout — read the cart and echo its revision'
        : 'cart changed — refresh and retry',
      code: out.cartConflict.code,
      revision: out.cartConflict.snapshot.revision,
      cart: out.cartConflict.snapshot,
    }, 409);

    return c.json({ code: out.code, state: out.state, grandTotal: out.grandTotal, discountTotal: out.discountTotal, currency: st.currency, couponApplied: out.couponApplied, giftCardApplied: out.giftCardApplied ?? 0, receiptToken: out.receiptToken }, 200);
  },
);
