import { randomUUID } from 'node:crypto';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { withStore, type Tx } from '../db/client.js';
import { resolveStoreFromCtx } from './store-context.js';
import { type StoreCtx } from '../store-context.js';
import * as s from '../db/schema.js';
import { calculateOrderTotals, type Promotion } from '../money/totals.js';
import { evaluateCoupon, productFacetIds } from '../money/coupon.js';
import { selectAutomaticPromotion } from '../money/auto-discount.js';
import { resolveTaxRate } from '../money/tax.js';
import { selectUnitPrice, variantPriceRuleFromConfig } from '../money/pricing.js';
import { customerToken, resolveCustomer } from '../auth/session.js';
import { normalizeEmail } from '../auth/email.js';
import { env } from '../env.js';
import { cartExpiry, cartLifecycleFromConfig } from '../cart/ttl.js';

/** Per-store effective-price rule (see money/pricing.ts) — resolved from
 *  store.config.pricing.variantRule so cart and checkout price identically. */
const priceRule = (st: StoreCtx) => variantPriceRuleFromConfig(st.config);

/** Deployment-default cart lifecycle + per-store config.cart overrides (CART-04). */
const lifecycle = (st: StoreCtx) =>
  cartLifecycleFromConfig(st.config, { abandonAfterHours: env.CART_ABANDON_HOURS, ttlDays: env.CART_TTL_DAYS });

type PricedCart = {
  currency: string;
  lines: Array<{ sku: string; name: string; unitPrice: number; quantity: number; lineSubtotal: number; lineDiscount: number; lineTotal: number; available: boolean; availableQuantity: number | null }>;
  subtotal: number; discountTotal: number; shippingTotal: number; taxTotal: number; grandTotal: number;
  unavailable: string[];
  coupon: { code: string; applied: boolean; reason?: string } | null;
};

/** True for the fulfillment types reserveStockOrThrow (orders/stock-reservation.ts)
 *  actually decrements stock for — pre-order and non-physical items are never
 *  stock-limited, so cart availability must match that rule exactly or a cart
 *  line could show "in stock" while checkout's reservation would reject it. */
function isStockLimited(v: { isPreOrder: boolean; fulfillmentType: string | null }): boolean {
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
  opts: { couponCode?: string; shipping?: number; token?: string | null; shipCountry?: string | null } = {},
): Promise<PricedCart> {
  const skus = [...new Set(items.map((i) => i.sku))];
  // Live stock join — never cached, never read from a search index. A row
  // missing from `stock` for a stock-limited variant leaves onHand/allocated
  // null, which the availability check below treats as zero (fail closed).
  const variants = skus.length
    ? await tx
        .select({
          sku: s.productVariant.sku, name: s.productVariant.name, price: s.productVariant.price, metafields: s.productVariant.metafields,
          salePrice: s.productVariant.salePrice, isPreOrder: s.productVariant.isPreOrder,
          preOrderPrice: s.productVariant.preOrderPrice, enabled: s.productVariant.enabled,
          fulfillmentType: s.productVariant.fulfillmentType,
          onHand: s.stock.onHand, allocated: s.stock.allocated,
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
    return { sku: i.sku, name: v?.name ?? '(unavailable)', unitPrice: v ? selectUnitPrice(v, priceRule(st)) : 0, quantity: i.quantity, available, availableQuantity };
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
      const ev = evaluateCoupon({ type: promo.type, value: promo.value, conditions: promo.conditions }, { subtotal: availSubtotal, activeVerifications, items: items.filter(i => bySku.has(i.sku)).map(i => ({ quantity: i.quantity, facetValueIds: productFacetIds(bySku.get(i.sku)?.metafields) })) });
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
      { subtotal: availSubtotal, activeVerifications, items: items.filter(i => bySku.has(i.sku)).map(i => ({ quantity: i.quantity, facetValueIds: productFacetIds(bySku.get(i.sku)?.metafields) })) },
    );
    if (best) promotion = { type: best.type, value: best.value };
  }

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

  const totals = calculateOrderTotals({
    lines: priced.filter((p) => p.available).map((p) => ({ unitPrice: p.unitPrice, quantity: p.quantity })),
    shipping: opts.shipping ?? 0, taxRate, taxInclusive: st.taxInclusive, shippingTaxable: st.shippingTaxable, promotion,
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
  // Live (on_hand - allocated), never cached. null = not stock-limited
  // (digital/license/update_pass/pre-order) rather than "unlimited stock".
  availableQuantity: z.number().int().nullable(),
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
            schema: z.object({ items: z.array(EstimateItem).min(1), shipping: z.number().int().min(0).default(0), couponCode: z.string().optional(), shipCountry: z.string().optional() }),
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
    const { items, shipping, couponCode, shipCountry } = c.req.valid('json');
    const token = customerToken(c);
    const result = await withStore(st.id, (tx) => priceCart(tx, st, items, { couponCode, shipping, token, shipCountry }));
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
  error: z.string(),
  code: CartConflictCode,
  revision: z.number().int(),
  cart: CartOut,
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

/** Build the full cart response (meta + server-priced lines). Exported so
 *  checkout can return the same snapshot on stale-write conflicts. */
export async function cartResponse(tx: Tx, st: StoreCtx, cartRow: CartRow, couponCode?: string, token?: string | null, shipCountry?: string | null): Promise<z.infer<typeof CartOut>> {
  const items = await cartItems(tx, cartRow.id);
  const priced = await priceCart(tx, st, items, { couponCode, token, shipCountry });
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
async function cartConflict(tx: Tx, st: StoreCtx, row: CartRow, code: CartConflictCode, couponCode?: string, authToken?: string | null, shipCountry?: string | null) {
  return { error: CONFLICT_COPY[code], code, revision: row.revision, cart: await cartResponse(tx, st, row, couponCode, authToken, shipCountry) };
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
async function applyLines(tx: Tx, st: StoreCtx, cartRow: CartRow, lines: Array<{ sku: string; quantity: number }>, opts: { mode?: 'set' | 'increment' } = {}): Promise<CartRow | null> {
  const mode = opts.mode ?? 'set';
  const vids = await variantIdsBySku(tx, lines.filter((l) => l.quantity > 0).map((l) => l.sku));
  for (const l of lines) {
    if (l.quantity <= 0) {
      if (mode === 'increment') continue; // removes require a base revision — unreachable by contract
      await tx.delete(s.cartLine).where(and(eq(s.cartLine.cartId, cartRow.id), eq(s.cartLine.sku, l.sku)));
      continue;
    }
    await tx
      .insert(s.cartLine)
      .values({ storeId: st.id, cartId: cartRow.id, sku: l.sku, variantId: vids.get(l.sku) ?? null, quantity: l.quantity })
      .onConflictDoUpdate({
        target: [s.cartLine.cartId, s.cartLine.sku],
        set: mode === 'increment'
          ? { quantity: sql`${s.cartLine.quantity} + ${l.quantity}`, variantId: vids.get(l.sku) ?? null }
          : { quantity: l.quantity, variantId: vids.get(l.sku) ?? null },
      });
  }
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
        .values({ storeId: st.id, token, customerId: customer?.id ?? null, email: body.email ? normalizeEmail(body.email) : null, expiresAt: cartExpiry(new Date(), lifecycle(st).ttlDays) })
        .returning();
      const seed = (body.items ?? []).filter((l) => l.quantity > 0);
      const cur = seed.length ? (await applyLines(tx, st, row!, seed)) ?? row! : row!;
      return cartResponse(tx, st, cur, body.couponCode, authTok);
    });
    return c.json(out, 200);
  },
);

// GET /v1/shop/cart/{token} — fetch a cart, server-repriced.
cart.openapi(
  createRoute({
    method: 'get', path: '/v1/shop/cart/{token}', summary: 'Get a cart',
    request: { params: z.object({ token: z.string() }), query: z.object({ couponCode: z.string().optional(), shipCountry: z.string().optional() }) },
    responses: { 200: { description: 'Cart', content: { 'application/json': { schema: CartOut } } }, 404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.string() }) } } } },
  }),
  async (c) => {
    const st = await resolveStoreFromCtx(c);
    const { token } = c.req.valid('param');
    const { couponCode, shipCountry } = c.req.valid('query');
    const authTok = customerToken(c);
    const out = await withStore(st.id, async (tx) => {
      const [row] = await tx.select().from(s.cart).where(eq(s.cart.token, token)).limit(1);
      if (!row) return null;
      return cartResponse(tx, st, row, couponCode, authTok, shipCountry);
    });
    if (!out) return c.json({ error: 'cart not found' }, 404);
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
    request: { params: z.object({ token: z.string() }), body: { content: { 'application/json': { schema: z.object({ lines: z.array(CartLineIn).min(1), couponCode: z.string().optional(), shipCountry: z.string().optional(), expectedRevision: z.number().int().optional() }) } } } },
    responses: {
      200: { description: 'Cart', content: { 'application/json': { schema: CartOut } } },
      404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      409: { description: 'Terminal, missing-revision, or stale cart', content: { 'application/json': { schema: CartConflictOut } } },
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
      const appendsOnly = body.lines.every((l) => l.quantity > 0);
      const block = mutationBlocker(row, body.expectedRevision, { revisionRequired: !appendsOnly });
      if (block === 'missing') return { code: 404 as const };
      if (block) return { code: 409 as const, body: await cartConflict(tx, st, row!, block, body.couponCode, authTok, body.shipCountry) };
      const updated = await applyLines(tx, st, row!, body.lines, { mode: body.expectedRevision == null ? 'increment' : 'set' });
      if (!updated) return { code: 409 as const, body: await cartConflict(tx, st, row!, 'converted', body.couponCode, authTok, body.shipCountry) };
      return { code: 200 as const, body: await cartResponse(tx, st, updated, body.couponCode, authTok, body.shipCountry) };
    });
    if (out.code === 404) return c.json({ error: 'cart not found' }, 404);
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
      404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      409: { description: 'Converted or stale cart', content: { 'application/json': { schema: CartConflictOut } } },
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
      if (block) return { code: 409 as const, body: await cartConflict(tx, st, row!, block) };
      const norm = normalizeEmail(email);
      const [acct] = await tx.select({ id: s.customer.id }).from(s.customer).where(eq(s.customer.email, norm)).limit(1);
      const [updated] = await tx
        .update(s.cart)
        .set({ email: norm, customerId: row!.customerId ?? acct?.id ?? null, updatedAt: new Date(), revision: sql`${s.cart.revision} + 1` })
        .where(and(eq(s.cart.id, row!.id), inArray(s.cart.status, ['active', 'abandoned'])))
        .returning();
      if (!updated) return { code: 409 as const, body: await cartConflict(tx, st, row!, 'converted') };
      return { code: 200 as const, body: await cartResponse(tx, st, updated) };
    });
    if (out.code === 404) return c.json({ error: 'cart not found' }, 404);
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
      401: { description: 'Auth required', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      404: { description: 'Not found', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      409: { description: 'Converted or stale cart', content: { 'application/json': { schema: CartConflictOut } } },
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

      // Lock the target plus every foldable cart in id order — one lock set,
      // one acquisition order, no cross-merge deadlock. FOR UPDATE re-reads
      // the latest committed row, so a cart converted mid-wait is re-filtered.
      const locked = await tx
        .select()
        .from(s.cart)
        .where(or(
          eq(s.cart.id, found.id),
          and(eq(s.cart.customerId, customer.id), eq(s.cart.status, 'active'), isNull(s.cart.convertedOrderId)),
        ))
        .orderBy(asc(s.cart.id))
        .for('update');
      const row = locked.find((r) => r.id === found.id);
      const block = mutationBlocker(row, expectedRevision, { revisionRequired: true });
      if (block === 'missing') return { code: 404 as const };
      if (block) return { code: 409 as const, body: await cartConflict(tx, st, row!, block, undefined, authTok) };

      // Other active carts owned by this customer → fold their lines in (sum
      // on conflict), then retire them as 'merged'. The fold is a MOVE: the
      // donor's cart_line rows are deleted and 'merged' is terminal, so the
      // donor can never be re-edited and re-merged into a later cart to
      // duplicate quantities (the old retire-as-'abandoned'-with-lines bug).
      const others = locked.filter((o) => o.id !== row!.id);
      for (const o of others) {
        const lines = await cartItems(tx, o.id);
        for (const l of lines) {
          await tx
            .insert(s.cartLine)
            .values({ storeId: st.id, cartId: row!.id, sku: l.sku, variantId: (await variantIdsBySku(tx, [l.sku])).get(l.sku) ?? null, quantity: l.quantity })
            .onConflictDoUpdate({ target: [s.cartLine.cartId, s.cartLine.sku], set: { quantity: sql`${s.cartLine.quantity} + ${l.quantity}` } });
        }
        await tx.delete(s.cartLine).where(eq(s.cartLine.cartId, o.id));
        // Conditional on still-active + unconverted: a cart racing a checkout
        // conversion is never flipped back once its order exists. A merged
        // donor keeps its original expiresAt — the TTL purge reaps the empty
        // row when it lapses (status 'merged' is purgeable, see
        // cart-maintenance.ts).
        await tx.update(s.cart).set({ status: 'merged', updatedAt: new Date(), revision: sql`${s.cart.revision} + 1` })
          .where(and(eq(s.cart.id, o.id), eq(s.cart.status, 'active'), isNull(s.cart.convertedOrderId)));
      }

      const [updated] = await tx.update(s.cart).set({ customerId: customer.id, updatedAt: new Date(), revision: sql`${s.cart.revision} + 1` })
        .where(and(eq(s.cart.id, row!.id), inArray(s.cart.status, ['active', 'abandoned'])))
        .returning();
      if (!updated) return { code: 409 as const, body: await cartConflict(tx, st, row!, 'converted', undefined, authTok) };
      return { code: 200 as const, body: await cartResponse(tx, st, updated, undefined, authTok) };
    });
    if (res.code === 401) return c.json({ error: 'authentication required to merge' }, 401);
    if (res.code === 404) return c.json({ error: 'cart not found' }, 404);
    if (res.code === 409) return c.json(res.body, 409);
    return c.json(res.body, 200);
  },
);
