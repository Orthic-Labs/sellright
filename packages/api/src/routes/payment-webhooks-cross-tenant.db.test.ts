/**
 * SECURITY (post-review fix, WS-A): a store's own DB-stored Stripe webhook
 * secret cryptographically proves only "signed by THIS store's credential" —
 * never "about this store". Before this fix, the fallback that tries every
 * store's own secret would verify the signature, then trust the (attacker-
 * controlled, since the body isn't otherwise authenticated) event body's
 * metadata.storeId or payment ref to pick which store to process the event
 * against. A store holding its own legitimately-configured webhook secret
 * (auto-provisioned or manually pasted — see the plan's "manual webhook-
 * secret fallback field") could therefore forge an event that settles a
 * DIFFERENT store's order.
 *
 * Covers:
 *   1. an event signed with store A's secret but claiming (via
 *      metadata.storeId) to belong to store B is REJECTED (ack, 200, never
 *      processed) — store B's order is untouched, and an audit_log row is
 *      written under store A (whose credential was used).
 *   2. store A's OWN event (same secret, own storeId) still settles normally
 *      — the fix must not break the legitimate same-tenant DB-secret path.
 *
 * Runs against sellright_test ONLY (TRUNCATEs data). Mirrors
 * payment-webhooks.route.test.ts's seeding + signing pattern.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { encryptSecret } from '../security/secret-crypto.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`payment-webhooks-cross-tenant test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const { paymentWebhooks } = await import('./payment-webhooks.js');
const { OpenAPIHono } = await import('@hono/zod-openapi');
const app = new OpenAPIHono();
app.route('/', paymentWebhooks);

const STORE_A = 'cccccccc-0000-0000-0000-0000000008a1';
const STORE_B = 'cccccccc-0000-0000-0000-0000000008b1';
const SLUG_A = 'cross-tenant-store-a';
const SLUG_B = 'cross-tenant-store-b';
const SECRET_A = 'whsec_store_a_own_secret_for_this_suite_only';

async function wipe() { await pool.query('TRUNCATE store CASCADE'); }

async function seedStore(storeId: string, slug: string): Promise<{ orderId: string; code: string }> {
  const code = 'SR' + Math.random().toString(16).slice(2, 12).toUpperCase();
  const orderId = await withStore(storeId, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${storeId}, ${slug}, ${slug}, 'USD', ${JSON.stringify({ payments: { stripe: true }, stripe: { mode: 'test' } })}::jsonb) ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config`);
    const [o] = await tx.insert(s.order).values({
      storeId, code, state: 'PendingPayment', currency: 'USD', grandTotal: 1500,
    }).returning({ id: s.order.id });
    return o!.id;
  });
  return { orderId, code };
}

async function seedStoreAWebhookSecret() {
  const purpose = `store:${STORE_A}:stripe:test:webhookSecret`;
  const sealed = encryptSecret(SECRET_A, { purpose });
  await withStore(STORE_A, (tx) => tx.insert(s.storeSecret).values({
    storeId: STORE_A, provider: 'stripe', mode: 'test', field: 'webhookSecret',
    keyVersion: sealed.v, iv: sealed.iv, ciphertext: sealed.ct, authTag: sealed.tag,
    last4: SECRET_A.slice(-4),
  }));
}

function sign(payload: string, secret: string): string {
  return new Stripe('sk_test_dummy_signing_only').webhooks.generateTestHeaderString({ payload, secret });
}

function piSucceededEvent(opts: { id: string; orderCode: string; storeId: string; amount?: number }) {
  return {
    id: opts.id,
    object: 'event',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: `pi_${opts.orderCode}`,
        object: 'payment_intent',
        amount: opts.amount ?? 1500,
        currency: 'usd',
        status: 'succeeded',
        metadata: { orderCode: opts.orderCode, storeId: opts.storeId },
      },
    },
  } as const;
}

const hdr = (sig: string, slug: string) => ({ 'content-type': 'application/json', 'x-store-slug': slug, 'stripe-signature': sig });

describe('POST /v1/webhooks/stripe — cross-tenant DB-secret forgery is rejected', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_SECRET_KEY_TEST', 'STRIPE_SECRET_KEY_LIVE', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_WEBHOOK_SECRET_TEST', 'STRIPE_WEBHOOK_SECRET_LIVE', 'SELLRIGHT_MASTER_KEY']) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    process.env.SELLRIGHT_MASTER_KEY = 'c'.repeat(64);
    await wipe();
    // store_secret has an FK to store — the row must exist before we can
    // attach a secret to it. Both stores are (re)inserted per-test via
    // seedStore(); a bare insert here just satisfies the FK ahead of that.
    await pool.query(
      `INSERT INTO store (id, slug, name, currency, config) VALUES ($1, $2, $2, 'USD', $3::jsonb) ON CONFLICT (id) DO NOTHING`,
      [STORE_A, SLUG_A, JSON.stringify({ payments: { stripe: true }, stripe: { mode: 'test' } })],
    );
    await seedStoreAWebhookSecret();
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await wipe();
    await pool.end();
  });

  it("rejects an event signed with store A's secret that claims to belong to store B — store B's order is untouched", async () => {
    await seedStore(STORE_A, SLUG_A); // store A must exist for the secret lookup loop to find it
    const { orderId: orderBId, code: codeB } = await seedStore(STORE_B, SLUG_B);

    // Forged: signed with A's own secret, but metadata.storeId claims to be B,
    // targeting B's real order code — exactly the attack this fix closes.
    const payload = JSON.stringify(piSucceededEvent({ id: 'evt_forged_cross_tenant', orderCode: codeB, storeId: STORE_B }));
    const sig = sign(payload, SECRET_A);

    const res = await app.request('/v1/webhooks/stripe', { method: 'POST', headers: hdr(sig, SLUG_B), body: payload });
    expect(res.status).toBe(200); // ack-and-ignore, never a 5xx retry loop

    const orderB = await withStore(STORE_B, async (tx) => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.id, orderBId)).limit(1);
      return o;
    });
    expect(orderB!.state).toBe('PendingPayment'); // untouched — the forged event never settled it

    const paymentsB = await withStore(STORE_B, (tx) => tx.select().from(s.payment).where(eq(s.payment.orderId, orderBId)));
    expect(paymentsB).toHaveLength(0);

    // The rejection is audited under A (the credential that was used), not B.
    const auditA = await withStore(STORE_A, (tx) => tx.select().from(s.auditLog).where(eq(s.auditLog.storeId, STORE_A)));
    expect(auditA.some((a) => a.action === 'cross_tenant_signature_rejected')).toBe(true);
  });

  it("still settles store A's OWN event, signed with its own secret and referencing its own order", async () => {
    const { orderId: orderAId, code: codeA } = await seedStore(STORE_A, SLUG_A);

    const payload = JSON.stringify(piSucceededEvent({ id: 'evt_own_store_a', orderCode: codeA, storeId: STORE_A }));
    const sig = sign(payload, SECRET_A);

    const res = await app.request('/v1/webhooks/stripe', { method: 'POST', headers: hdr(sig, SLUG_A), body: payload });
    expect(res.status).toBe(200);

    const orderA = await withStore(STORE_A, async (tx) => {
      const [o] = await tx.select().from(s.order).where(eq(s.order.id, orderAId)).limit(1);
      return o;
    });
    expect(orderA!.state).toBe('Paid');

    const paymentsA = await withStore(STORE_A, (tx) => tx.select().from(s.payment).where(eq(s.payment.orderId, orderAId)));
    expect(paymentsA).toHaveLength(1);
  });
});
