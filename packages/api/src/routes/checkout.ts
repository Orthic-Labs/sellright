import { randomBytes, randomUUID } from 'node:crypto';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, count, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { withStore } from '../db/client.js';
import { resolveStoreFromCtx } from './store-context.js';
import * as s from '../db/schema.js';
import { calculateOrderTotals, type Promotion } from '../money/totals.js';
import { evaluateCoupon } from '../money/coupon.js';
import { selectAutomaticPromotion } from '../money/auto-discount.js';
import { resolveTaxRate } from '../money/tax.js';
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

function selectUnitPrice(v: { price: number; salePrice: number | null; isPreOrder: boolean; preOrderPrice: number | null }): number {
  if (v.isPreOrder && v.preOrderPrice != null) return v.preOrderPrice;
  if (v.salePrice != null) return v.salePrice;
  return v.price;
}

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

              email: z.string().email().optional(),
              shippingAddress: z.record(z.string(), z.unknown()).optional(),
              billingAddress: z.record(z.string(), z.unknown()).optional(),
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
      409: { description: 'Out of stock / shipping unavailable', content: { 'application/json': { schema: z.object({ error: z.string(), skus: z.array(z.string()).optional(), reason: z.string().optional() }) } } },
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

    type Result = { blocked: string[] } | { shippingError: string } | { cartError: string } | { code: string; grandTotal: number; discountTotal: number; couponApplied: boolean; replay?: boolean; giftCardApplied?: number; paid?: boolean; receiptToken: string };
    const out = await withStore(st.id, async (tx): Promise<Result> => {
      // Idempotency: same key -> the same order (also guarded by a unique index).
      if (idemKey) {
        const [existing] = await tx
          .select({ code: s.order.code, state: s.order.state, grandTotal: s.order.grandTotal, discountTotal: s.order.discountTotal, receiptToken: s.order.receiptToken })
          .from(s.order)
          .where(eq(s.order.idempotencyKey, idemKey))
          .limit(1);
        if (existing) return { code: existing.code, grandTotal: existing.grandTotal, discountTotal: existing.discountTotal, couponApplied: existing.discountTotal > 0, replay: true, paid: existing.state === 'Paid', receiptToken: existing.receiptToken ?? '' };
      }

      // Server-authoritative cart: when a cartToken is present the server cart is
      // the source of truth — derive the items from it and NEVER fall back to the
      // client item list (a fallback re-opens trust-the-client; council P1). With
      // no token (legacy local-cart path) client items are used, still re-priced.
      let items = body.items;
      if (body.cartToken) {
        const [row] = await tx.select({ id: s.cart.id, status: s.cart.status }).from(s.cart).where(eq(s.cart.token, body.cartToken)).limit(1);
        if (!row || row.status === 'converted') return { cartError: 'cart is empty, invalid, or already checked out' };
        const lines = await tx.select({ sku: s.cartLine.sku, quantity: s.cartLine.quantity }).from(s.cartLine).where(eq(s.cartLine.cartId, row.id));
        if (!lines.length) return { cartError: 'cart is empty, invalid, or already checked out' };
        items = lines.map((l) => ({ sku: l.sku, quantity: l.quantity })); // fail-closed
      }
      const skus = [...new Set(items.map((i) => i.sku))];

      const variants = await tx
        .select()
        .from(s.productVariant)
        .where(and(inArray(s.productVariant.sku, skus), isNull(s.productVariant.deletedAt)));
      const bySku = new Map(variants.map((v) => [v.sku, v]));

      const blocked = validateReservableItems(items, bySku);
      if (blocked.length) return { blocked };
      await reserveStockOrThrow(tx, st.id, items, bySku);

      const priced = items.map((i) => {
        const v = bySku.get(i.sku)!;
        return { v, qty: i.quantity, unitPrice: selectUnitPrice(v) };
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
      if (!requiresShipping) {
        shippingAmount = 0;
      } else if (body.shippingMethodCode) {
        const m = methods.find((x) => x.code === body.shippingMethodCode);
        if (!m) throw new ShippingUnavailableError('method_not_found');
        if (!isMethodEligible(m.calculator, { subtotal: subtotalCents, country: shipCountry })) throw new ShippingUnavailableError('not_eligible');
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
            { subtotal: subtotalCents, activeVerifications },
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
            { subtotal: subtotalCents, activeVerifications },
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

      const totals = calculateOrderTotals({
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
        metadata: linkedVia ? { linked_via: linkedVia } : null,
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
      if (body.cartToken) {
        await tx.update(s.cart).set({ status: 'converted', convertedOrderId: orderId, updatedAt: new Date() }).where(eq(s.cart.token, body.cartToken));
        await emitEvent(tx, st.id, 'cart.converted', { token: body.cartToken, orderId, code });
      }

      // Webhook events (transactional outbox — enqueued in the same txn).
      await emitEvent(tx, st.id, 'order.created', { code, grandTotal: totals.grandTotal, currency: st.currency });
      if (paid) await emitEvent(tx, st.id, 'order.paid', { code, grandTotal: totals.grandTotal, currency: st.currency });

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
      return { code, grandTotal: totals.grandTotal, discountTotal: totals.discountTotal, couponApplied: promoId != null, giftCardApplied, paid, receiptToken };
    }).catch(async (e: unknown): Promise<Result> => {
      // Concurrent double-submit with the same Idempotency-Key: the unique
      // (store, key) index rejected the loser; its txn (incl. allocation) rolled
      // back. Return the winner's order in a fresh read.
      if (idemKey && (e as { code?: string })?.code === '23505') {
        return withStore(st.id, async (tx): Promise<Result> => {
          const [o] = await tx
            .select({ code: s.order.code, state: s.order.state, grandTotal: s.order.grandTotal, discountTotal: s.order.discountTotal, receiptToken: s.order.receiptToken })
            .from(s.order)
            .where(eq(s.order.idempotencyKey, idemKey))
            .limit(1);
          if (o) return { code: o.code, grandTotal: o.grandTotal, discountTotal: o.discountTotal, couponApplied: o.discountTotal > 0, replay: true, paid: o.state === 'Paid', receiptToken: o.receiptToken ?? '' };
          throw e;
        });
      }
      if (e instanceof StockReservationError) return { blocked: e.skus };
      if (e instanceof ShippingUnavailableError) return { shippingError: e.reason };
      throw e;
    });

    if ('shippingError' in out) return c.json({ error: 'shipping unavailable', reason: out.shippingError }, 409);
    if ('cartError' in out) return c.json({ error: out.cartError }, 409);
    if ('blocked' in out) return c.json({ error: 'unavailable or out of stock', skus: out.blocked }, 409);

    return c.json({ code: out.code, state: out.paid ? 'Paid' : 'PendingPayment', grandTotal: out.grandTotal, discountTotal: out.discountTotal, currency: st.currency, couponApplied: out.couponApplied, giftCardApplied: out.giftCardApplied ?? 0, receiptToken: out.receiptToken }, 200);
  },
);
