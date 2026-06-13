import { randomUUID } from 'node:crypto';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { withStore, type Tx } from '../db/client.js';
import { resolveStoreFromCtx } from './store-context.js';
import { type StoreCtx } from '../store-context.js';
import * as s from '../db/schema.js';
import { calculateOrderTotals, type Promotion } from '../money/totals.js';
import { evaluateCoupon } from '../money/coupon.js';
import { selectAutomaticPromotion } from '../money/auto-discount.js';
import { customerToken, resolveCustomer } from '../auth/session.js';
import { normalizeEmail } from '../auth/email.js';

/** Price selection (rulebook §2): preorder > sale > base. */
function selectUnitPrice(v: { price: number; salePrice: number | null; isPreOrder: boolean; preOrderPrice: number | null }): number {
  if (v.isPreOrder && v.preOrderPrice != null) return v.preOrderPrice;
  if (v.salePrice != null) return v.salePrice;
  return v.price;
}

type PricedCart = {
  currency: string;
  lines: Array<{ sku: string; name: string; unitPrice: number; quantity: number; lineSubtotal: number; lineDiscount: number; lineTotal: number; available: boolean }>;
  subtotal: number; discountTotal: number; shippingTotal: number; taxTotal: number; grandTotal: number;
  unavailable: string[];
  coupon: { code: string; applied: boolean; reason?: string } | null;
};

/**
 * Server-authoritative cart pricing — the single source of truth shared by the
 * stateless estimate, the persisted cart GET, and any line mutation. Never
 * trusts client-supplied prices: re-reads each variant, re-selects the price,
 * re-validates the coupon. Must run inside a withStore tx.
 */
async function priceCart(
  tx: Tx,
  st: StoreCtx,
  items: Array<{ sku: string; quantity: number }>,
  opts: { couponCode?: string; shipping?: number; token?: string | null } = {},
): Promise<PricedCart> {
  const skus = [...new Set(items.map((i) => i.sku))];
  const variants = skus.length
    ? await tx
        .select({
          sku: s.productVariant.sku, name: s.productVariant.name, price: s.productVariant.price,
          salePrice: s.productVariant.salePrice, isPreOrder: s.productVariant.isPreOrder,
          preOrderPrice: s.productVariant.preOrderPrice, enabled: s.productVariant.enabled,
        })
        .from(s.productVariant)
        .where(and(inArray(s.productVariant.sku, skus), isNull(s.productVariant.deletedAt)))
    : [];
  const bySku = new Map(variants.map((v) => [v.sku, v]));

  const unavailable: string[] = [];
  const priced = items.map((i) => {
    const v = bySku.get(i.sku);
    const available = !!v && v.enabled;
    if (!available) unavailable.push(i.sku);
    return { sku: i.sku, name: v?.name ?? '(unavailable)', unitPrice: v ? selectUnitPrice(v) : 0, quantity: i.quantity, available };
  });

  let promotion: Promotion | undefined;
  let coupon: { code: string; applied: boolean; reason?: string } | null = null;
  const availSubtotal = priced.filter((p) => p.available).reduce((a, p) => a + p.unitPrice * p.quantity, 0);
  const now = new Date();
  const timeValid = and(or(isNull(s.promotion.startsAt), lte(s.promotion.startsAt, now)), or(isNull(s.promotion.endsAt), gte(s.promotion.endsAt, now)));
  const activeVerifications = opts.token ? (await resolveCustomer(tx, opts.token))?.activeVerifications ?? [] : [];
  if (opts.couponCode) {
    const [promo] = await tx
      .select()
      .from(s.promotion)
      .where(and(eq(s.promotion.code, opts.couponCode), eq(s.promotion.enabled, true), timeValid))
      .limit(1);
    if (!promo) {
      coupon = { code: opts.couponCode, applied: false, reason: 'invalid or expired code' };
    } else {
      const ev = evaluateCoupon({ type: promo.type, value: promo.value, conditions: promo.conditions }, { subtotal: availSubtotal, activeVerifications });
      if (ev.valid && ev.promotion) { promotion = ev.promotion; coupon = { code: opts.couponCode, applied: true }; }
      else coupon = { code: opts.couponCode, applied: false, reason: ev.reason };
    }
  } else {
    // No code → preview the best eligible AUTOMATIC promotion (estimate only;
    // checkout re-applies it authoritatively with usage-limit enforcement).
    const autos = await tx
      .select()
      .from(s.promotion)
      .where(and(isNull(s.promotion.code), eq(s.promotion.enabled, true), timeValid));
    const best = selectAutomaticPromotion(
      autos.map((a) => ({ id: a.id, type: a.type, value: a.value, conditions: a.conditions, priority: a.priority })),
      { subtotal: availSubtotal, activeVerifications },
    );
    if (best) promotion = { type: best.type, value: best.value };
  }

  const totals = calculateOrderTotals({
    lines: priced.filter((p) => p.available).map((p) => ({ unitPrice: p.unitPrice, quantity: p.quantity })),
    shipping: opts.shipping ?? 0, taxRate: st.taxRate, taxInclusive: st.taxInclusive, shippingTaxable: st.shippingTaxable, promotion,
  });

  let idx = 0;
  const lines = priced.map((p) => {
    if (!p.available) return { ...p, lineSubtotal: 0, lineDiscount: 0, lineTotal: 0 };
    const t = totals.lines[idx++]!;
    return { ...p, lineSubtotal: t.lineSubtotal, lineDiscount: t.lineDiscount, lineTotal: t.lineTotal };
  });

  return {
    currency: st.currency, lines,
    subtotal: totals.subtotal, discountTotal: totals.discountTotal, shippingTotal: totals.shippingTotal,
    taxTotal: totals.taxTotal, grandTotal: totals.grandTotal, unavailable, coupon,
  };
}

const EstimateItem = z.object({ sku: z.string(), quantity: z.number().int().min(1) });
const LineOut = z.object({
  sku: z.string(), name: z.string(), unitPrice: z.number().int(), quantity: z.number().int(),
  lineSubtotal: z.number().int(), lineDiscount: z.number().int(), lineTotal: z.number().int(),
  available: z.boolean(),
});
const EstimateOut = z.object({
  currency: z.string(),
  lines: z.array(LineOut),
  subtotal: z.number().int(), discountTotal: z.number().int(), shippingTotal: z.number().int(),
  taxTotal: z.number().int(), grandTotal: z.number().int(),
  unavailable: z.array(z.string()),
  coupon: z.object({ code: z.string(), applied: z.boolean(), reason: z.string().optional() }).nullable(),
});

export const cart = new OpenAPIHono();

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
            schema: z.object({ items: z.array(EstimateItem).min(1), shipping: z.number().int().min(0).default(0), couponCode: z.string().optional() }),
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
    const { items, shipping, couponCode } = c.req.valid('json');
    const token = customerToken(c);
    const result = await withStore(st.id, (tx) => priceCart(tx, st, items, { couponCode, shipping, token }));
    return c.json(result, 200);
  },
);

// ── Persisted cart (first-class checkout resource) ────────────────────────────
// A cart is identified by an opaque `token` the client stores (cookie/localStorage).
// All pricing is server-authoritative (priceCart). Lines snapshot the SKU so they
// survive variant deletion; variantId is kept when resolvable for stock joins.

const CartLineIn = z.object({ sku: z.string(), quantity: z.number().int().min(0) });
const CartOut = EstimateOut.extend({
  token: z.string(),
  status: z.string(),
  email: z.string().nullable(),
  customerId: z.string().nullable(),
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

/** Load a cart's lines as priceable items. */
async function cartItems(tx: Tx, cartId: string): Promise<Array<{ sku: string; quantity: number }>> {
  const rows = await tx.select({ sku: s.cartLine.sku, quantity: s.cartLine.quantity }).from(s.cartLine).where(eq(s.cartLine.cartId, cartId));
  return rows.map((r) => ({ sku: r.sku, quantity: r.quantity }));
}

/** Build the full cart response (meta + server-priced lines). */
async function cartResponse(tx: Tx, st: StoreCtx, cartRow: CartRow, couponCode?: string, token?: string | null): Promise<z.infer<typeof CartOut>> {
  const items = await cartItems(tx, cartRow.id);
  const priced = await priceCart(tx, st, items, { couponCode, token });
  return { ...priced, token: cartRow.token, status: cartRow.status, email: cartRow.email, customerId: cartRow.customerId };
}

/** Upsert/remove cart lines (quantity 0 removes). Touches updatedAt. */
async function applyLines(tx: Tx, st: StoreCtx, cartId: string, lines: Array<{ sku: string; quantity: number }>): Promise<void> {
  const vids = await variantIdsBySku(tx, lines.filter((l) => l.quantity > 0).map((l) => l.sku));
  for (const l of lines) {
    if (l.quantity <= 0) {
      await tx.delete(s.cartLine).where(and(eq(s.cartLine.cartId, cartId), eq(s.cartLine.sku, l.sku)));
      continue;
    }
    await tx
      .insert(s.cartLine)
      .values({ storeId: st.id, cartId, sku: l.sku, variantId: vids.get(l.sku) ?? null, quantity: l.quantity })
      .onConflictDoUpdate({ target: [s.cartLine.cartId, s.cartLine.sku], set: { quantity: l.quantity, variantId: vids.get(l.sku) ?? null } });
  }
  await tx.update(s.cart).set({ updatedAt: new Date() }).where(eq(s.cart.id, cartId));
}

// POST /v1/shop/cart — create a cart, optionally seeded with lines.
cart.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/cart', summary: 'Create a cart',
    request: { body: { content: { 'application/json': { schema: z.object({ items: z.array(CartLineIn).optional(), email: z.string().email().optional(), couponCode: z.string().optional() }) } } } },
    responses: { 200: { description: 'Cart', content: { 'application/json': { schema: CartOut } } } },
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
        .values({ storeId: st.id, token, customerId: customer?.id ?? null, email: body.email ? normalizeEmail(body.email) : null })
        .returning();
      const seed = (body.items ?? []).filter((l) => l.quantity > 0);
      if (seed.length) await applyLines(tx, st, row!.id, seed);
      return cartResponse(tx, st, row!, body.couponCode, authTok);
    });
    return c.json(out, 200);
  },
);

// GET /v1/shop/cart/{token} — fetch a cart, server-repriced.
cart.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/cart/{token}', summary: 'Get a cart',
    request: { params: z.object({ token: z.string() }), query: z.object({ couponCode: z.string().optional() }) },
    responses: { 200: { description: 'Cart', content: { 'application/json': { schema: CartOut } } }, 404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.string() }) } } } },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { token } = c.req.valid('param');
    const { couponCode } = c.req.valid('query');
    const authTok = customerToken(c);
    const out = await withStore(st.id, async (tx) => {
      const [row] = await tx.select().from(s.cart).where(eq(s.cart.token, token)).limit(1);
      if (!row) return null;
      return cartResponse(tx, st, row, couponCode, authTok);
    });
    if (!out) return c.json({ error: 'cart not found' }, 404);
    return c.json(out, 200);
  },
);

// PATCH /v1/shop/cart/{token}/lines — upsert/remove lines (quantity 0 removes).
cart.openapi(
  createRoute({
    method: 'patch', path: '/v1/shop/cart/{token}/lines', summary: 'Update cart lines',
    request: { params: z.object({ token: z.string() }), body: { content: { 'application/json': { schema: z.object({ lines: z.array(CartLineIn).min(1), couponCode: z.string().optional() }) } } } },
    responses: { 200: { description: 'Cart', content: { 'application/json': { schema: CartOut } } }, 404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.string() }) } } } },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { token } = c.req.valid('param');
    const body = c.req.valid('json');
    const authTok = customerToken(c);
    const out = await withStore(st.id, async (tx) => {
      const [row] = await tx.select().from(s.cart).where(eq(s.cart.token, token)).limit(1);
      if (!row) return null;
      await applyLines(tx, st, row.id, body.lines);
      return cartResponse(tx, st, row, body.couponCode, authTok);
    });
    if (!out) return c.json({ error: 'cart not found' }, 404);
    return c.json(out, 200);
  },
);

// PATCH /v1/shop/cart/{token} — capture identity (abandoned-cart recovery).
// Stores the email on the cart and links an existing account if one matches.
cart.openapi(
  createRoute({
    method: 'patch', path: '/v1/shop/cart/{token}', summary: 'Capture cart identity (email)',
    request: { params: z.object({ token: z.string() }), body: { content: { 'application/json': { schema: z.object({ email: z.string().email() }) } } } },
    responses: { 200: { description: 'Cart', content: { 'application/json': { schema: CartOut } } }, 404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.string() }) } } } },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { token } = c.req.valid('param');
    const { email } = c.req.valid('json');
    const out = await withStore(st.id, async (tx) => {
      const [row] = await tx.select().from(s.cart).where(eq(s.cart.token, token)).limit(1);
      if (!row) return null;
      const norm = normalizeEmail(email);
      const [acct] = await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.email, norm)).limit(1);
      const [updated] = await tx
        .update(s.cart)
        .set({ email: norm, customerId: row.customerId ?? acct?.id ?? null, updatedAt: new Date() })
        .where(eq(s.cart.id, row.id))
        .returning();
      return cartResponse(tx, st, updated!);
    });
    if (!out) return c.json({ error: 'cart not found' }, 404);
    return c.json(out, 200);
  },
);

// POST /v1/shop/cart/{token}/merge — on login, claim the guest cart for the
// authenticated customer and fold their other active carts into it.
cart.openapi(
  createRoute({
    method: 'post', path: '/v1/shop/cart/{token}/merge', summary: 'Merge guest cart into the logged-in customer',
    request: { params: z.object({ token: z.string() }) },
    responses: { 200: { description: 'Cart', content: { 'application/json': { schema: CartOut } } }, 401: { description: 'Auth required', content: { 'application/json': { schema: z.object({ error: z.string() }) } } }, 404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.string() }) } } } },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { token } = c.req.valid('param');
    const authTok = customerToken(c);
    const res = await withStore(st.id, async (tx) => {
      const customer = authTok ? await resolveCustomer(tx, authTok) : null;
      if (!customer) return { code: 401 as const };
      const [row] = await tx.select().from(s.cart).where(eq(s.cart.token, token)).limit(1);
      if (!row) return { code: 404 as const };

      // Other active carts owned by this customer → fold their lines in (sum), then retire them.
      const others = await tx
        .select()
        .from(s.cart)
        .where(and(eq(s.cart.customerId, customer.id), eq(s.cart.status, 'active'), isNull(s.cart.convertedOrderId)));
      for (const o of others) {
        if (o.id === row.id) continue;
        const lines = await cartItems(tx, o.id);
        for (const l of lines) {
          await tx
            .insert(s.cartLine)
            .values({ storeId: st.id, cartId: row.id, sku: l.sku, variantId: (await variantIdsBySku(tx, [l.sku])).get(l.sku) ?? null, quantity: l.quantity })
            .onConflictDoUpdate({ target: [s.cartLine.cartId, s.cartLine.sku], set: { quantity: sql`${s.cartLine.quantity} + ${l.quantity}` } });
        }
        await tx.update(s.cart).set({ status: 'abandoned', updatedAt: new Date() }).where(eq(s.cart.id, o.id));
      }

      const [updated] = await tx.update(s.cart).set({ customerId: customer.id, updatedAt: new Date() }).where(eq(s.cart.id, row.id)).returning();
      return { code: 200 as const, body: await cartResponse(tx, st, updated!, undefined, authTok) };
    });
    if (res.code === 401) return c.json({ error: 'authentication required to merge' }, 401);
    if (res.code === 404) return c.json({ error: 'cart not found' }, 404);
    return c.json(res.body, 200);
  },
);
