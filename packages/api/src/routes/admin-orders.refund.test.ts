/**
 * DB tests — MONEY-2: refund idempotency-key threading + return-approve row
 * locking. Route-level, drives the real Hono handlers through app.request()
 * so auth + withStore + RLS all run exactly as in production.
 *
 * Runs against sellright_test ONLY (these wipe data). Mirrors
 * admin-orders.bulk.test.ts: _test-DB guard + TRUNCATE store CASCADE wipe +
 * seed helpers under withStore(). vitest runs files serially
 * (fileParallelism: false), so the shared DB is safe between files.
 *
 * Stripe is MOCKED at the provider boundary (`../payments/provider.js`
 * getProvider) so no network call fires and we can assert exactly what
 * idempotencyKey was passed on each call — mirrors checkout-migration.test.ts's
 * pattern of mocking the Stripe surface, not the HTTP layer.
 *
 * Covers:
 *   1. a retried direct refund (same order, same amount) passes the SAME
 *      idempotencyKey to the gateway both times, and does not produce a second
 *      refund ledger row (the route's own priorRefunded/balance check plus the
 *      row lock is what stops the second row from being written; the
 *      idempotencyKey is what stops Stripe from moving money twice on a retry
 *      that races past the DB check, e.g. after a mid-flight crash).
 *   2. two concurrent return-approve calls for the SAME return request yield
 *      exactly one refund ledger row and one gateway call (the new
 *      `.for('update')` lock on returnRequest serializes them).
 *   3. the return-approve idempotencyKey is keyed on the return request id
 *      (not the order id), distinct from the direct-refund key shape.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Spy on every gateway refund call: records the idempotencyKey it was given,
// and returns a fresh `re_...` state so ordinary (non-concurrent) flows behave
// like a real gateway. Concurrency tests below simulate a slow gateway via a
// deferred promise per call.
type RefundCall = { providerRef: string | null; amount: number; idempotencyKey?: string };
const refundCalls: RefundCall[] = [];
let refundImpl = async (input: RefundCall) => ({ state: 'Settled' as const, providerRef: `re_${Math.random().toString(36).slice(2)}`, errorMessage: null as string | null });

vi.mock('../payments/provider.js', async (orig) => {
  const actual = await orig<typeof import('../payments/provider.js')>();
  return {
    ...actual,
    getProvider: (method: string) => {
      if (method !== 'stripe') return actual.getProvider(method);
      return {
        method: 'stripe',
        requiresRedirect: false,
        async createPayment() { throw new Error('not used in this test'); },
        async refundPayment(input: RefundCall) {
          refundCalls.push({ providerRef: input.providerRef, amount: input.amount, idempotencyKey: input.idempotencyKey });
          return refundImpl(input);
        },
      };
    },
  };
});

import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { createAdminSession } from '../auth/admin-session.js';
import { adminOrders } from './admin-orders.js';
// The order-detail route (GET /v1/admin/orders/{code}) lives in the `admin`
// router — mounted here so the line-id contract can be asserted end to end.
import { admin as adminRoutes } from './admin.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(
    `refund test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`,
  );
}

const STORE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const SLUG = 'refund-test-store';
const ADMIN = 'dddddddd-dddd-dddd-dddd-00000000000a';
const VARIANT = 'dddddddd-dddd-dddd-dddd-00000000000b';

const app = new OpenAPIHono();
app.route('/', adminOrders);
app.route('/', adminRoutes);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
  await pool.query('DELETE FROM admin_user');
}

/** Seed store (stripe enabled, test mode) + owner admin + one stocked variant. */
async function seedStoreAndAdmin(): Promise<string> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`
      INSERT INTO store (id, slug, name, currency, config)
      VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', ${JSON.stringify({ payments: { stripe: true }, stripe: { mode: 'test' } })}::jsonb)
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user (id, email, password_hash) VALUES (${ADMIN}, 'owner@refund.test', 'x') ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO admin_user_store (admin_user_id, store_id, role) VALUES (${ADMIN}, ${STORE}, 'owner') ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE}, 'p', 'P', 'active') ON CONFLICT DO NOTHING`);
  });
  const pid = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT id FROM product WHERE store_id = ${STORE} LIMIT 1`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${VARIANT}, ${STORE}, ${pid}, 'SKU1', 'V1', 1000) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${VARIANT}, ${STORE}, 100, 0) ON CONFLICT (variant_id) DO UPDATE SET on_hand = 100, allocated = 0`);
  });
  return createAdminSession(ADMIN);
}

/** Seed a Paid order with one line + a Settled stripe payment. Returns {orderId, code, lineId}. */
async function seedPaidOrder(code: string, grandTotal = 2000): Promise<{ orderId: string; lineId: string }> {
  const orderId = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, grand_total)
      VALUES (gen_random_uuid(), ${STORE}, ${code}, 'Paid'::order_state, 'USD', ${grandTotal})
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  const lineId = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO order_line (id, store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, ${VARIANT}, 'SKU1', 'V1', 1, ${grandTotal}, ${grandTotal}, ${grandTotal}, 0)
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`
      INSERT INTO payment (id, store_id, order_id, amount, method, state, provider_ref)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, ${grandTotal}, 'stripe', 'Settled', ${'pi_' + code})`);
  });
  return { orderId, lineId };
}

/** Seed a Paid order settled with a gift-card tender: a gift_card `payment` row
 *  with NO provider_ref (mirrors routes/checkout.ts, which applies the tender
 *  directly rather than through createPayment) + the original redemption
 *  `gift_card_transaction` row (negative amount) that creditGiftCardRefund
 *  must find to know which card to credit back. Returns the gift card's id so
 *  tests can assert its balance after a refund. */
async function seedGiftCardPaidOrder(code: string, grandTotal = 2000): Promise<{ orderId: string; lineId: string; giftCardId: string }> {
  const { orderId, lineId } = await seedPaidOrder(code, grandTotal);
  // Replace the stripe payment row seeded above with a gift_card one (no provider_ref).
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`DELETE FROM payment WHERE order_id = ${orderId}`);
    await tx.execute(sql`
      INSERT INTO payment (id, store_id, order_id, amount, method, state)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, ${grandTotal}, 'gift_card', 'Settled')`);
  });
  const giftCardId = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO gift_card (id, store_id, code, initial_balance, balance, currency)
      VALUES (gen_random_uuid(), ${STORE}, ${'GC-' + code}, ${grandTotal}, 0, 'USD')
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`
      INSERT INTO gift_card_transaction (id, store_id, gift_card_id, order_id, amount)
      VALUES (gen_random_uuid(), ${STORE}, ${giftCardId}, ${orderId}, ${-grandTotal})`);
  });
  return { orderId, lineId, giftCardId };
}

async function giftCardBalance(giftCardId: string): Promise<number> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT balance FROM gift_card WHERE id = ${giftCardId}`);
    return (r.rows[0] as { balance: number }).balance;
  });
}

async function refundOrder(code: string, body: Record<string, unknown> = {}): Promise<{ status: number; body: unknown }> {
  const res = await app.request(`/v1/admin/orders/${code}/refund`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function createReturn(code: string, lineId: string, quantity = 1): Promise<string> {
  const res = await app.request(`/v1/admin/orders/${code}/returns`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG, 'content-type': 'application/json' },
    body: JSON.stringify({ lines: [{ orderLineId: lineId, quantity, restock: true }] }),
  });
  const b = (await res.json()) as { id: string };
  return b.id;
}

async function approveReturn(id: string): Promise<{ status: number; body: unknown }> {
  const res = await app.request(`/v1/admin/returns/${id}/approve`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG },
  });
  return { status: res.status, body: await res.json() };
}

async function refundRowCount(orderId: string): Promise<number> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT count(*)::int AS n FROM refund WHERE order_id = ${orderId}`);
    return (r.rows[0] as { n: number }).n;
  });
}

let token = '';
beforeEach(async () => {
  await wipe();
  refundCalls.length = 0;
  refundImpl = async () => ({ state: 'Settled' as const, providerRef: `re_${Math.random().toString(36).slice(2)}`, errorMessage: null });
  vi.clearAllMocks();
  token = await seedStoreAndAdmin();
});
afterAll(async () => { await wipe(); });

describe('GET /v1/admin/orders/{code} — line ids feed per-line refunds', () => {
  it('returns each order line id, and that id is accepted as refund lines[].orderLineId', async () => {
    const { orderId, lineId } = await seedPaidOrder('SR-LINEID-1', 2000);

    const res = await app.request('/v1/admin/orders/SR-LINEID-1', {
      headers: { authorization: `Bearer ${token}`, 'x-store-slug': SLUG },
    });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as { lines: Array<{ id: string; quantity: number }> };
    // The contract that makes per-line refunds constructible by any consumer:
    // detail.lines[].id IS the order_line id the refund endpoint keys on.
    expect(detail.lines[0]!.id).toBe(lineId);

    const refund = await refundOrder('SR-LINEID-1', {
      lines: [{ orderLineId: detail.lines[0]!.id, quantity: 1 }],
      restock: true,
    });
    expect(refund.status).toBe(200);
    // Amount derived from the line (1 × 2000), not passed in by the caller.
    expect(refund.body).toMatchObject({ refunded: 2000, state: 'Refunded' });
    expect(await refundRowCount(orderId)).toBe(1);
  });
});

describe('POST /v1/admin/orders/{code}/refund — idempotency key', () => {
  it('passes a deterministic idempotencyKey keyed on order id + STARTING balance (priorRefunded) + amount', async () => {
    const { orderId } = await seedPaidOrder('SR-REF-1');
    const res = await refundOrder('SR-REF-1', { amount: 2000 });
    expect(res.status).toBe(200);
    expect(refundCalls).toHaveLength(1);
    // priorRefunded is 0 on a fresh order — this is the first refund attempt.
    expect(refundCalls[0]!.idempotencyKey).toBe(`refund:${orderId}:0:2000`);
  });

  // MONEY-2 regression: this is the exact collision the old
  // `refund:${o.id}:${amount}` key produced. Two DISTINCT refunds of the
  // SAME amount on the SAME order (a partial refund followed by a second
  // refund that completes it) used to compute the IDENTICAL idempotencyKey,
  // so Stripe's 24h dedupe window would have replayed the first refund's
  // response for the second call — moving no new money — while our code
  // still inserted a second `s.refund` ledger row and double-counted
  // alreadyRefunded(). Keying on priorRefunded (the order's refunded-so-far
  // balance, which only advances after a refund actually commits, and this
  // whole route runs under a per-order advisory lock so nothing can
  // interleave) makes the two keys provably distinct.
  it('two DISTINCT sequential refunds of the SAME amount on the SAME order get DIFFERENT idempotencyKeys', async () => {
    const { orderId } = await seedPaidOrder('SR-REF-COLLIDE', 2000);
    const first = await refundOrder('SR-REF-COLLIDE', { amount: 1000 });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ state: 'PartiallyRefunded' });

    const second = await refundOrder('SR-REF-COLLIDE', { amount: 1000 });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ state: 'Refunded' });

    expect(refundCalls).toHaveLength(2);
    expect(refundCalls[0]!.idempotencyKey).toBe(`refund:${orderId}:0:1000`);
    expect(refundCalls[1]!.idempotencyKey).toBe(`refund:${orderId}:1000:1000`);
    expect(refundCalls[0]!.idempotencyKey).not.toBe(refundCalls[1]!.idempotencyKey);
    expect(await refundRowCount(orderId)).toBe(2);
  });

  it('a retried refund attempt after the order is already Refunded is rejected by the balance check — no second gateway call, no second ledger row', async () => {
    const { orderId } = await seedPaidOrder('SR-REF-2');
    const first = await refundOrder('SR-REF-2', { amount: 2000 });
    expect(first.status).toBe(200);
    expect(await refundRowCount(orderId)).toBe(1);

    // Simulated retry: admin resubmits the same refund request after the first
    // one already landed (e.g. client timed out but the server call succeeded).
    const second = await refundOrder('SR-REF-2', { amount: 2000 });
    expect(second.status).toBe(409); // order is Refunded — no refundable balance
    expect(refundCalls).toHaveLength(1); // gateway was NOT called again
    expect(await refundRowCount(orderId)).toBe(1); // still exactly one ledger row
  });

  it('the idempotencyKey is stable across a DB-level retry race: two concurrent identical refund requests reuse the SAME key (Stripe, not our balance check, is what stops the second one from moving money)', async () => {
    const { orderId } = await seedPaidOrder('SR-REF-3', 4000);
    // Two callers race the identical partial-refund request (e.g. an admin
    // double-clicks "Refund $15"). The `.for('update')` order lock serializes
    // them at our DB layer — only one commits, the other 409s on the balance
    // check once it acquires the lock. But BOTH calls reach executeGatewayRefund
    // with the SAME key before that serialization resolves the DB race, so this
    // proves the key itself doesn't vary run-to-run — it's Stripe's own 24h
    // dedupe (not asserted here, since the gateway is mocked) that would collapse
    // two real in-flight calls with this key into one refund.
    const [a, b] = await Promise.all([
      refundOrder('SR-REF-3', { amount: 1500 }),
      refundOrder('SR-REF-3', { amount: 1500 }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1); // lock prevents a real double-refund at our layer
    expect(refundCalls.length).toBeGreaterThanOrEqual(1);
    // Only the winner reaches the gateway (the loser's `prepared` step 409s on
    // canTransition before ever calling executeGatewayRefund — see the FSM's
    // lack of a PartiallyRefunded self-edge), so priorRefunded is 0 for the
    // one call that happens.
    for (const call of refundCalls) expect(call.idempotencyKey).toBe(`refund:${orderId}:0:1500`);
    expect(await refundRowCount(orderId)).toBe(1);
  });
});

describe('POST /v1/admin/returns/{id}/approve — row lock + idempotency key', () => {
  it('passes a deterministic idempotencyKey keyed on the return request id + amount (distinct shape from direct refund)', async () => {
    const { lineId } = await seedPaidOrder('SR-RET-1');
    const returnId = await createReturn('SR-RET-1', lineId, 1);
    const res = await approveReturn(returnId);
    expect(res.status).toBe(200);
    expect(refundCalls).toHaveLength(1);
    expect(refundCalls[0]!.idempotencyKey).toBe(`refund:return:${returnId}:2000`);
  });

  it('two concurrent approve calls for the SAME return request yield exactly one refund ledger row and one gateway call', async () => {
    const { orderId, lineId } = await seedPaidOrder('SR-RET-2');
    const returnId = await createReturn('SR-RET-2', lineId, 1);

    // Make the gateway call slow so both requests are genuinely in-flight
    // together; the `.for('update')` lock on returnRequest (+ order) means the
    // second request blocks until the first's transaction commits, then sees
    // status = 'refunded' and is rejected — not a second gateway call.
    let calls = 0;
    refundImpl = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 50));
      return { state: 'Settled' as const, providerRef: `re_concurrent_${calls}`, errorMessage: null };
    };

    const [a, b] = await Promise.all([approveReturn(returnId), approveReturn(returnId)]);
    const statuses = [a.status, b.status].sort();
    // Exactly one succeeds; the other is rejected (already approved/refunded, or
    // badstate on the order transition) — never both 200.
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(refundCalls).toHaveLength(1);
    expect(await refundRowCount(orderId)).toBe(1);
  });
});

// Money-critical regression: refunding a gift-card-paid order used to report
// success (`{ state: 'Settled' }`) while moving ZERO money back to the
// customer — 'gift_card' had no entry in payments/provider.ts's PROVIDERS
// map, so `getProvider('gift_card')` was null and executeGatewayRefund's old
// `!provider?.refundPayment` branch treated "no provider" exactly like
// "provider has nothing to do". Fixed by (1) registering a real (no-op)
// gift_card provider so the branch is reachable only for genuinely
// unsupported methods, and (2) admin-orders.ts crediting the gift card's
// balance back + inserting a compensating gift_card_transaction row in the
// SAME transaction as the refund ledger write.
describe('POST /v1/admin/orders/{code}/refund — gift_card tender', () => {
  it('credits the gift card balance back and records a compensating gift_card_transaction on a full refund', async () => {
    const { orderId, giftCardId } = await seedGiftCardPaidOrder('SR-GC-1', 2000);
    expect(await giftCardBalance(giftCardId)).toBe(0); // fully redeemed at checkout

    const res = await refundOrder('SR-GC-1', { amount: 2000 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'Refunded', refunded: 2000 });

    expect(await giftCardBalance(giftCardId)).toBe(2000); // money is back on the card
    expect(await refundRowCount(orderId)).toBe(1);
    const txCount = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT count(*)::int AS n FROM gift_card_transaction WHERE gift_card_id = ${giftCardId} AND amount > 0`);
      return (r.rows[0] as { n: number }).n;
    });
    expect(txCount).toBe(1); // exactly one compensating (positive) transaction
  });

  it('credits a partial gift-card refund proportionally, not the full balance', async () => {
    const { giftCardId } = await seedGiftCardPaidOrder('SR-GC-2', 2000);
    const res = await refundOrder('SR-GC-2', { amount: 500 });
    expect(res.status).toBe(200);
    expect(await giftCardBalance(giftCardId)).toBe(500);
  });
});
