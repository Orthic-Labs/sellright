/**
 * SR-CLIENT-1 (storefront-client audit): DB integration tests for
 * POST /v1/shop/orders/{code}/gateway-payment and its .../verify sibling.
 *
 * These two routes were plain, undocumented Hono handlers (no zod-openapi
 * schema at all — absent from /v1/openapi.json, so the generated typed
 * client couldn't cover the checkout payment path). Converted to
 * `createRoute` + `.openapi()` with the structured error envelope
 * (`{ error: { code, message } }`); this file is the first test coverage
 * either route has had.
 *
 * Mirrors checkout.route.test.ts's conventions: real Hono handler via
 * app.request(), withStore seeds, TRUNCATE store CASCADE wipe. Runs against
 * sellright_test ONLY.
 *
 * Covers:
 *   1. missing Idempotency-Key on start -> 400 IDEMPOTENCY_KEY_REQUIRED
 *   2. invalid body on start -> 400 INVALID_PAYMENT_REQUEST
 *   3. no gateway configured on start -> 409 PAYMENT_METHOD_DISABLED
 *      (GatewayPaymentError mapped through the new envelope, code slugified
 *      from its message)
 *   4. verify with a non-UUID attempt id -> 404 PAYMENT_NOT_FOUND
 *   5. verify with a well-formed but unknown attempt id -> 404 (readGatewayAttempt's
 *      GatewayPaymentError, same envelope shape)
 *   6. every error response also carries `requestId` (lib/api-error.ts)
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { requestIdMiddleware } from '../lib/request-id.js';
import { gatewayPayments } from './gateway-payments.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`gateway-payments.route test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'bbbbbbbb-2222-2222-2222-222222222222';
const SLUG = 'gwp-route-test-store';
const ORDER_CODE = 'GWP-ROUTE-1';
const RECEIPT_TOKEN = 'gwp-route-receipt-token';

const app = new OpenAPIHono();
// requestId assertions below (every error response also carries `requestId`)
// need the same middleware the real app.ts registers globally — a minimal
// route-only test app doesn't get it for free (see api-error.test.ts's
// appWithRoute helper for the same pattern).
app.use('*', requestIdMiddleware());
app.route('/', gatewayPayments);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

/** Seed a store with NO gateway configured (config: {}) and one PendingPayment
 *  order — enough to exercise ownedOrder() + isPaymentMethodEnabled()'s
 *  fail-closed default. */
async function seed(): Promise<void> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, grand_total, receipt_token)
      VALUES (gen_random_uuid(), ${STORE}, ${ORDER_CODE}, 'PendingPayment'::order_state, 'USD', 5000, ${RECEIPT_TOKEN})
      ON CONFLICT (store_id, code) DO NOTHING
    `);
  });
}

beforeEach(seed);
afterAll(async () => { await wipe(); await pool.end(); });

function post(path: string, opts: { headers?: Record<string, string>; body?: unknown } = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-store-slug': SLUG, ...opts.headers },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

describe('POST /v1/shop/orders/{code}/gateway-payment', () => {
  it('400s with IDEMPOTENCY_KEY_REQUIRED when the header is missing', async () => {
    const res = await post(`/v1/shop/orders/${ORDER_CODE}/gateway-payment`, {
      body: { method: 'nmi', token: 'tok_test' },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string; param?: string; requestId?: string } };
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(body.error.param).toBe('idempotency-key');
    expect(body.error.requestId).toEqual(expect.any(String));
    expect(res.headers.get('x-request-id')).toBe(body.error.requestId);
  });

  it('400s with INVALID_PAYMENT_REQUEST on a malformed body', async () => {
    const res = await post(`/v1/shop/orders/${ORDER_CODE}/gateway-payment`, {
      headers: { 'idempotency-key': 'idem-1' },
      body: { method: 'not-a-real-method' },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_PAYMENT_REQUEST');
  });

  it('409s with PAYMENT_METHOD_DISABLED when no gateway is configured (fail closed)', async () => {
    const res = await post(`/v1/shop/orders/${ORDER_CODE}/gateway-payment`, {
      headers: { 'idempotency-key': 'idem-2' },
      body: { method: 'nmi', token: 'tok_test' },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('PAYMENT_METHOD_DISABLED');
    expect(body.error.message).toBe('Payment method disabled');
  });
});

describe('POST /v1/shop/orders/{code}/gateway-payment/{attempt}/verify', () => {
  it('404s with PAYMENT_NOT_FOUND for a non-UUID attempt id (never reaches the DB)', async () => {
    const res = await post(`/v1/shop/orders/${ORDER_CODE}/gateway-payment/not-a-uuid/verify`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('PAYMENT_NOT_FOUND');
    expect(body.error.message).toBe('Payment not found');
  });

  it('404s for a well-formed but unknown attempt id, via the GatewayPaymentError catch branch', async () => {
    const unknownAttempt = '00000000-0000-4000-8000-000000000000';
    const res = await post(`/v1/shop/orders/${ORDER_CODE}/gateway-payment/${unknownAttempt}/verify`, {
      headers: { 'x-receipt-token': RECEIPT_TOKEN },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string; requestId?: string } };
    expect(body.error.code).toBe('PAYMENT_NOT_FOUND');
    expect(body.error.requestId).toEqual(expect.any(String));
  });
});
