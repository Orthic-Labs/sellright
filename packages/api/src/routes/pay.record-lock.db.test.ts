/**
 * X-45: the /pay record step runs after the gateway has already charged. If another
 * transaction holds the order row for longer than the 5 s lock_timeout used by the
 * prepare step, the record must wait and commit, never answer 409 PAYMENT_RETRY.
 * Stripe is mocked at the seam (mint / retrieve / createPayment hook); everything else
 * is real. Runs against a *_test DB only (TRUNCATEs store CASCADE).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const intents = new Map<string, Record<string, unknown>>();
// Runs inside the gateway call, i.e. after the prepare tx committed and before the record tx.
let beforeGatewayResult: (() => Promise<void>) | null = null;
vi.mock('../payments/stripe.js', async (orig) => {
  const actual = await orig<typeof import('../payments/stripe.js')>();
  return {
    ...actual,
    resolveStripeUsable: async () => true,
    stripeModeFromConfig: () => 'test' as const,
    createPaymentIntent: vi.fn(async (o: { orderCode: string; amount: number; currency: string; idempotencyKey?: string }) => {
      const intentId = `pi_${o.idempotencyKey}`;
      if (!intents.has(intentId)) {
        intents.set(intentId, { id: intentId, amount: o.amount, currency: o.currency.toLowerCase(), status: 'requires_payment_method', metadata: { orderCode: o.orderCode }, latest_charge: null });
      }
      return { clientSecret: `${intentId}_secret`, intentId };
    }),
    stripeProvider: {
      ...actual.stripeProvider,
      createPayment: vi.fn(async (input: Parameters<typeof actual.stripeProvider.createPayment>[0]) => {
        const hook = beforeGatewayResult;
        beforeGatewayResult = null;
        if (hook) await hook();
        const id = typeof input.token === 'string' ? input.token : '';
        const pi = intents.get(id);
        if (!pi) return { state: 'Failed' as const, providerRef: id || null, errorMessage: 'No such payment_intent' };
        return actual.verifyIntent(pi as unknown as Parameters<typeof actual.verifyIntent>[0], input);
      }),
    },
  };
});
vi.mock('../payments/provider.js', async (orig) => {
  const actual = await orig<typeof import('../payments/provider.js')>();
  return { ...actual, isPaymentMethodEnabled: () => true };
});
vi.mock('../manifest/stock-hook.js', () => ({ onStockChanged: () => undefined }));

import { OpenAPIHono } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { pay } from './pay.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`pay record-lock test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'e2000000-0000-0000-0000-0000000e2045';
const SLUG = 'payrecordlock-test';
const RT = 'rt_pay_record_lock_receipt_token_abcdefgh';
const app = new OpenAPIHono();
app.route('/', pay);

beforeEach(async () => {
  await pool.query('TRUNCATE store CASCADE');
  intents.clear();
  beforeGatewayResult = null;
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', ${JSON.stringify({ payments: { stripe: true }, stripe: { mode: 'test' } })}::jsonb)`);
  });
});
afterAll(async () => { await pool.query('TRUNCATE store CASCADE'); await pool.end(); });

const hdr = () => ({ 'content-type': 'application/json', 'x-store-slug': SLUG, 'x-receipt-token': RT });
const intent = (code: string) => app.request(`/v1/shop/orders/${code}/payment-intent`, { method: 'POST', headers: hdr() });
const payWith = (code: string, token: string) =>
  app.request(`/v1/shop/orders/${code}/pay`, { method: 'POST', headers: hdr(), body: JSON.stringify({ method: 'stripe', token }) });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The prepare-style lock_timeout is 5 s and the plan is retried 3 times (4 tries = ~20 s), so
// a single 5 s wait is absorbed by a retry. The hold must outlast the whole retry budget.
const HOLD_MS = 21_000;

async function makeOrder(code: string, grandTotal: number): Promise<string> {
  return withStore(STORE, async (tx) => {
    const [ord] = await tx.insert(s.order).values({
      storeId: STORE, code, state: 'PendingPayment', currency: 'USD', receiptToken: RT, subtotal: grandTotal, grandTotal,
    }).returning({ id: s.order.id });
    return ord!.id;
  });
}

describe('X-45 /pay record step waits for a long order-lock holder', () => {
  it('commits the settled payment after a 21 s holder of the order row (no 409 PAYMENT_RETRY)', async () => {
    const orderId = await makeOrder('RL45', 1000);
    const { intentId } = await (await intent('RL45')).json() as { intentId: string };
    const pi = intents.get(intentId)!;
    intents.set(intentId, { ...pi, status: 'succeeded', latest_charge: 'ch_rl45' });

    // Another transaction takes the order row after the prepare committed and holds it past lock_timeout.
    let holder: Promise<void> = Promise.resolve();
    beforeGatewayResult = async () => {
      let locked!: () => void;
      const lockedSignal = new Promise<void>((r) => { locked = r; });
      holder = withStore(STORE, async (tx) => {
        await tx.select({ id: s.order.id }).from(s.order).where(eq(s.order.id, orderId)).for('update');
        locked();
        await pause(HOLD_MS);
      });
      await lockedSignal;
    };

    const started = Date.now();
    const res = await payWith('RL45', intentId);
    const elapsed = Date.now() - started;
    await holder;

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'Paid', payment: 'Settled' });
    expect(elapsed).toBeGreaterThanOrEqual(HOLD_MS - 1000);
    const rows = await withStore(STORE, (tx) => tx.select().from(s.payment).where(eq(s.payment.orderId, orderId)));
    expect(rows.filter((p) => p.providerRef === intentId)).toHaveLength(1);
    const [order] = await withStore(STORE, (tx) => tx.select().from(s.order).where(eq(s.order.id, orderId)));
    expect(order!.state).toBe('Paid');
  }, 45000);
});
