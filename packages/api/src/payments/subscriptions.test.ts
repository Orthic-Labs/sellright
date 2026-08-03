/**
 * DB test — subscription renewals must write their OWN payment ledger row.
 *
 * Before this fix, `extendRenewal` only extended the license + wrote an
 * auditLog row; ONLY `settleFirstCycle` ever called `applyPaymentResult` /
 * inserted into `s.payment`. So a subscription on cycle 4 had exactly one
 * payment row (cycle 1's), and admin-orders.ts's refund route (which targets
 * the most recent Settled payment for the order) could only ever refund the
 * FIRST month's charge — every later cycle's money was effectively
 * unrefundable.
 *
 * DB-gated with skipIf rather than a hard throw: this file is a NEW file, and
 * (per the task's explicit scope) package.json cannot be edited to register
 * it in the `test` script's --exclude list / `test:db`'s file list. skipIf
 * keeps `pnpm test` green with no DB (tests report skipped, not failed) while
 * still running for real under a genuine `_test` DATABASE_URL.
 *
 * Runs against sellright_test ONLY (TRUNCATEs). Mirrors
 * routes/admin-orders.refund.test.ts's seeding style (raw SQL via
 * withStore/tx.execute) since this module has no HTTP route of its own —
 * onInvoicePaid is called directly with a real tx, exactly as
 * routes/payment-webhooks.ts calls it in production.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { onInvoicePaid, type InvoiceLike } from './subscriptions.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
const isTestDb = /_test(\b|$|\?)/.test(DB);

const STORE = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const SLUG = 'sub-renewal-test-store';
const VARIANT = 'ffffffff-ffff-ffff-ffff-00000000000b';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

/** Seed a store + a 30-day-license variant + a Paid backing order + one
 *  license already issued for it + a `subscription` row already linked to
 *  that license (i.e. cycle 1 has already settled — the exact precondition
 *  under which `onInvoicePaid` dispatches to `extendRenewal`, not
 *  `settleFirstCycle`). Returns ids needed to drive + assert renewals. */
async function seedActiveSubscription(stripeSubId: string): Promise<{ orderId: string; licenseId: string }> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`
      INSERT INTO store (id, slug, name, currency, config)
      VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING`);
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE}, 'p', 'P', 'active') ON CONFLICT DO NOTHING`);
  });
  const pid = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT id FROM product WHERE store_id = ${STORE} LIMIT 1`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`
      INSERT INTO product_variant (id, store_id, product_id, sku, name, price, license_duration_days, updates_duration_days)
      VALUES (${VARIANT}, ${STORE}, ${pid}, 'SUB1', 'Subscription plan', 1000, 30, 30)
      ON CONFLICT (id) DO NOTHING`);
  });
  const orderId = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO "order" (id, store_id, code, state, currency, grand_total)
      VALUES (gen_random_uuid(), ${STORE}, ${'SUB-' + stripeSubId}, 'Paid'::order_state, 'USD', 1000)
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  const lineId = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO order_line (id, store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, ${VARIANT}, 'SUB1', 'Subscription plan', 1, 1000, 1000, 1000, 0)
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  // Cycle 1 already settled: a payment row + an issued license, mirroring
  // what settleFirstCycle would have produced.
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`
      INSERT INTO payment (id, store_id, order_id, amount, method, state, provider_ref)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, 1000, 'stripe', 'Settled', ${'pi_cycle1_' + stripeSubId})`);
  });
  const licenseId = await withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO license (id, store_id, order_id, order_line_id, app_key, license_key, status)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, ${lineId}, 'sellright', ${'LIC-' + stripeSubId}, 'active')
      RETURNING id`);
    return (r.rows[0] as { id: string }).id;
  });
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`
      INSERT INTO subscription (id, store_id, order_id, license_id, stripe_subscription_id, status)
      VALUES (gen_random_uuid(), ${STORE}, ${orderId}, ${licenseId}, ${stripeSubId}, 'active')`);
  });
  return { orderId, licenseId };
}

async function settledPaymentCount(orderId: string): Promise<number> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT count(*)::int AS n FROM payment WHERE order_id = ${orderId} AND state = 'Settled'`);
    return (r.rows[0] as { n: number }).n;
  });
}

async function paymentProviderRefs(orderId: string): Promise<string[]> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT provider_ref FROM payment WHERE order_id = ${orderId} ORDER BY created_at`);
    return r.rows.map((row) => (row as { provider_ref: string }).provider_ref);
  });
}

function invoice(subId: string, opts: { paymentIntent: string; invoiceId: string; amountPaid: number }): InvoiceLike {
  return {
    id: opts.invoiceId,
    subscription: subId,
    payment_intent: opts.paymentIntent,
    amount_paid: opts.amountPaid,
    lines: { data: [{ period: { end: Math.floor(Date.now() / 1000) + 30 * 86400 } }] },
  };
}

describe.skipIf(!isTestDb)('onInvoicePaid — renewal cycles write their own payment ledger row', () => {
  beforeEach(async () => { await wipe(); });
  afterAll(async () => { await wipe(); });

  it('a renewal invoice inserts a SECOND settled payment row distinct from cycle 1', async () => {
    const { orderId } = await seedActiveSubscription('sub_renewal_1');
    expect(await settledPaymentCount(orderId)).toBe(1); // cycle 1 only, from seeding

    await withStore(STORE, (tx) =>
      onInvoicePaid(tx, STORE, invoice('sub_renewal_1', { paymentIntent: 'pi_cycle2', invoiceId: 'in_cycle2', amountPaid: 1000 })));

    expect(await settledPaymentCount(orderId)).toBe(2); // cycle 1 + cycle 2
    const refs = await paymentProviderRefs(orderId);
    expect(refs).toEqual(expect.arrayContaining(['pi_cycle1_sub_renewal_1', 'pi_cycle2']));
    // The two cycles are DISTINCT rows — a refund keyed on "most recent
    // Settled payment" now targets pi_cycle2, not the month-1 charge.
    expect(new Set(refs).size).toBe(2);
  });

  it('a redelivered invoice.paid for the SAME renewal does not double-insert (idempotent on providerRef)', async () => {
    const { orderId } = await seedActiveSubscription('sub_renewal_2');
    const inv = invoice('sub_renewal_2', { paymentIntent: 'pi_cycle2_dup', invoiceId: 'in_cycle2_dup', amountPaid: 1000 });

    await withStore(STORE, (tx) => onInvoicePaid(tx, STORE, inv));
    expect(await settledPaymentCount(orderId)).toBe(2);

    // Simulated Stripe webhook redelivery of the identical invoice.paid event.
    await withStore(STORE, (tx) => onInvoicePaid(tx, STORE, inv));
    expect(await settledPaymentCount(orderId)).toBe(2); // still 2 — no duplicate row
  });

  it('three renewal cycles produce three distinct settled payment rows', async () => {
    const { orderId } = await seedActiveSubscription('sub_renewal_3');
    await withStore(STORE, (tx) => onInvoicePaid(tx, STORE, invoice('sub_renewal_3', { paymentIntent: 'pi_c2', invoiceId: 'in_c2', amountPaid: 1000 })));
    await withStore(STORE, (tx) => onInvoicePaid(tx, STORE, invoice('sub_renewal_3', { paymentIntent: 'pi_c3', invoiceId: 'in_c3', amountPaid: 1000 })));
    await withStore(STORE, (tx) => onInvoicePaid(tx, STORE, invoice('sub_renewal_3', { paymentIntent: 'pi_c4', invoiceId: 'in_c4', amountPaid: 1000 })));
    expect(await settledPaymentCount(orderId)).toBe(4); // cycle 1 (seeded) + 3 renewals
  });
});
