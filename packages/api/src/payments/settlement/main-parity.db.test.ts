/**
 * Settlement review F2-F5, F7: behaviour that must match main (82d53dc) for existing stores. Each case
 * states main's observable result (payment row shape, audits, licence link, expiry, alerts) and asserts it
 * against the settlement chokepoint. Runs against a *_test database only (truncates).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../../db/client.js';
import * as s from '../../db/schema.js';
import { env } from '../../env.js';
import { onInvoicePaid, type InvoiceLike } from '../subscriptions.js';
import { recordSettlementOperation } from './record.js';
import { runEffectsPass } from './effects.js';
import { setInvoiceHistoryPolicy } from './invoice.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`settlement parity test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'ee000000-0000-0000-0000-0000000000f1';
const VARIANT = 'ee000000-0000-0000-0000-0000000000f2';
const SUB = 'sub_parity_1';
const DAY = 86_400_000;

async function wipe() { await pool.query('TRUNCATE store CASCADE'); }

interface Seeded { orderId: string; code: string; grandTotal: number }
async function seedOrder(opts: { code: string; state?: string; grandTotal?: number }): Promise<Seeded> {
  return withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, 'parity-store', 'Parity', 'USD', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    const prod = await tx.execute(sql`
      INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE}, ${'p-' + opts.code}, 'P', 'active') RETURNING id`);
    const productId = (prod.rows[0] as { id: string }).id;
    await tx.execute(sql`
      INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type, app_key, license_duration_days, updates_duration_days, stripe_price_id, billing_interval)
      VALUES (${VARIANT}, ${STORE}, ${productId}, 'PLAN', 'Plan', 1000, 'license', 'testapp', 30, 30, 'price_p', 'month') ON CONFLICT (id) DO NOTHING`);
    const grandTotal = opts.grandTotal ?? 1000;
    const o = await tx.execute(sql`
      INSERT INTO "order" (store_id, code, state, currency, grand_total, metadata)
      VALUES (${STORE}, ${opts.code}, ${opts.state ?? 'PendingPayment'}::order_state, 'USD', ${grandTotal}, '{}'::jsonb) RETURNING id`);
    const orderId = (o.rows[0] as { id: string }).id;
    await tx.execute(sql`
      INSERT INTO order_line (store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
      VALUES (${STORE}, ${orderId}, ${VARIANT}, 'PLAN', 'Plan', 1, ${grandTotal}, ${grandTotal}, ${grandTotal}, 0)`);
    return { orderId, code: opts.code, grandTotal };
  });
}
const seedSubscription = (orderId: string | null) => withStore(STORE, (tx) => tx.execute(sql`
  INSERT INTO subscription (store_id, order_id, stripe_subscription_id, status) VALUES (${STORE}, ${orderId}, ${SUB}, 'incomplete')`));

const invoice = (id: string, reason: string | null, pi: string, amount = 1000): InvoiceLike => ({
  id, subscription: SUB, customer: 'cus_p', payment_intent: pi, billing_reason: reason, amount_paid: amount, currency: 'usd',
  lines: { data: [{ price: { id: 'price_p' }, period: { end: 1_900_000_000 } }] },
});
const deliver = (inv: InvoiceLike) => withStore(STORE, (tx) => onInvoicePaid(tx, STORE, inv));
const licences = () => withStore(STORE, (tx) => tx.select().from(s.license));
const payments = () => withStore(STORE, (tx) => tx.select().from(s.payment));
const effects = () => withStore(STORE, (tx) => tx.select().from(s.orderPendingEffect));
const audits = (action: string) => withStore(STORE, (tx) => tx.select().from(s.auditLog).where(eq(s.auditLog.action, action)));
const subRow = () => withStore(STORE, async (tx) => (await tx.select().from(s.subscription).where(eq(s.subscription.stripeSubscriptionId, SUB)))[0]!);
const orderRow = (id: string) => withStore(STORE, async (tx) => (await tx.select().from(s.order).where(eq(s.order.id, id)))[0]!);
const dueNow = (kind: string) => withStore(STORE, (tx) => tx.execute(sql`UPDATE order_pending_effect SET next_attempt_at = now() - interval '1 second' WHERE effect_kind = ${kind}`));

beforeEach(async () => { await wipe(); setInvoiceHistoryPolicy(null); });
afterAll(async () => { setInvoiceHistoryPolicy(null); await wipe(); });

describe('F2 renewal and first-cycle payment rows match main', () => {
  it('first cycle: the Settled row carries no gateway mode and the order currency (main shape)', async () => {
    const { orderId } = await seedOrder({ code: 'PAR-FC' });
    await seedSubscription(orderId);
    await deliver(invoice('in_fc', 'subscription_create', 'pi_fc'));
    const [row] = (await payments()).filter((p) => p.providerRef === 'pi_fc');
    expect(row).toMatchObject({ state: 'Settled', method: 'stripe', amount: 1000, currency: 'USD', gatewayMode: null, gatewayAccount: null });
    expect(row!.metadata).toEqual({ stripeInvoiceId: 'in_fc', amountPaid: 1000 });
  });

  it('renewal: the ledger row has main shape (gateway mode and currency NULL, renewal metadata)', async () => {
    const { orderId } = await seedOrder({ code: 'PAR-RN' });
    await seedSubscription(orderId);
    await deliver(invoice('in_fc2', 'subscription_create', 'pi_fc2'));
    await deliver(invoice('in_rn', 'subscription_cycle', 'pi_rn'));
    const [row] = (await payments()).filter((p) => p.providerRef === 'pi_rn');
    expect(row).toMatchObject({ state: 'Settled', amount: 1000, gatewayMode: null, currency: null, gatewayAccount: null });
    expect(row!.metadata).toEqual({ stripeInvoiceId: 'in_rn', renewal: true });
  });

  it('renewal: a second invoice carrying the same payment reference is audited as a duplicate, not silent', async () => {
    const { orderId } = await seedOrder({ code: 'PAR-DUP' });
    await seedSubscription(orderId);
    await deliver(invoice('in_fc3', 'subscription_create', 'pi_fc3'));
    await deliver(invoice('in_rn1', 'subscription_cycle', 'pi_rn1'));
    await deliver(invoice('in_rn2', 'subscription_cycle', 'pi_rn1'));
    expect((await payments()).filter((p) => p.providerRef === 'pi_rn1').length).toBe(1);
    const dup = await audits('subscription_renewal_payment_duplicate');
    expect(dup.map((a) => a.data)).toEqual([{ invoiceId: 'in_rn2', providerRef: 'pi_rn1' }]);
  });
});

describe('F3 renewal on a revoked licence extends it as main did', () => {
  it('extends expiry and audits subscription_renewed; no terminal effect', async () => {
    const { orderId } = await seedOrder({ code: 'PAR-REV' });
    await seedSubscription(orderId);
    await deliver(invoice('in_rv1', 'subscription_create', 'pi_rv1'));
    const issued = (await licences())[0]!;
    await withStore(STORE, (tx) => tx.update(s.license).set({ status: 'revoked' }).where(eq(s.license.id, issued.id)));
    await deliver(invoice('in_rv2', 'subscription_cycle', 'pi_rv2'));
    await dueNow('license_extend');
    await runEffectsPass();
    const ext = (await effects()).find((r) => r.effectKind === 'license_extend')!;
    expect(ext.status).toBe('done');
    const lic = (await licences())[0]!;
    expect(lic.expiresAt!.getTime()).toBe(issued.expiresAt!.getTime() + 30 * DAY);
    expect((await audits('subscription_renewed')).length).toBe(1);
    expect((await effects()).some((r) => r.status === 'terminal')).toBe(false);
  });
});

describe('F4 subscription cycle with no linked licence issues the first cycle as main did', () => {
  it('issues the licence, links it to the subscription, and never queues an extension', async () => {
    const { orderId } = await seedOrder({ code: 'PAR-NL' });
    await seedSubscription(orderId);
    await deliver(invoice('in_nl', 'subscription_cycle', 'pi_nl'));
    const lics = await licences();
    expect(lics.length).toBe(1);
    expect((await subRow()).licenseId).toBe(lics[0]!.id);
    expect((await orderRow(orderId)).state).toBe('Paid');
    expect((await effects()).some((r) => r.effectKind === 'license_extend')).toBe(false);
    expect((await audits('subscription_activated')).length).toBe(1);
  });
});

describe('F5 first-cycle invoice on an order already in the paid lifecycle', () => {
  it('balance: balance_payment audit, deferred edit earn, no extension; licence only (re)linked', async () => {
    const { orderId } = await seedOrder({ code: 'PAR-PB', state: 'Paid' });
    await seedSubscription(orderId);
    await deliver(invoice('in_pb', 'subscription_create', 'pi_pb'));
    const bal = await audits('balance_payment');
    expect(bal.map((a) => a.data)).toEqual([{ amount: 1000, method: 'stripe', providerRef: 'pi_pb' }]);
    expect((await payments()).filter((p) => p.providerRef === 'pi_pb').length).toBe(1);
    const issues = (await effects()).filter((r) => r.effectKind === 'license_issue');
    expect(issues.every((r) => (r.payload as { issue?: boolean }).issue === false)).toBe(true);
    expect((await effects()).filter((r) => r.effectKind === 'edit_reconcile').map((r) => r.status)).toEqual(['done']);
    expect((await orderRow(orderId)).state).toBe('Paid');
  });

  it('overpayment on the paid order: MONEY-4 payment_after_cancel audit and alert, no balance audit', async () => {
    const { orderId } = await seedOrder({ code: 'PAR-OP', state: 'Paid' });
    await seedSubscription(orderId);
    await withStore(STORE, (tx) => tx.insert(s.payment).values({ storeId: STORE, orderId, amount: 1000, method: 'manual', providerRef: 'manual-prior', state: 'Settled' }));
    await deliver(invoice('in_op', 'subscription_create', 'pi_op'));
    expect((await audits('payment_after_cancel')).map((a) => a.data)).toEqual([expect.objectContaining({
      reason: 'settled_payment_on_non_payable_order', needsReconciliation: true, amount: 1000, providerRef: 'pi_op',
    })]);
    expect((await audits('balance_payment')).length).toBe(0);
    expect((await effects()).some((r) => r.effectKind === 'edit_reconcile')).toBe(false);
  });
});

describe('F7 order purge cancels the order\'s pending effects instead of leaving them to go terminal', () => {
  it('pending effects of the purged order are marked done with a cancellation reason; no admin_review', async () => {
    const { orderId } = await seedOrder({ code: 'PAR-PG' });
    await withStore(STORE, async (tx) => {
      // a deferred Paid transition that has not run yet
      await recordSettlementOperation(tx, {
        storeId: STORE, kind: 'order_paid_transition', operationId: orderId, orderId, effectMode: 'deferred',
        mutations: [{ type: 'order_paid', orderId, placedAt: new Date() }],
        effects: [{ kind: 'license_issue', payload: { orderId, customerId: null, paidAt: new Date().toISOString() } }],
      });
    });
    expect((await effects()).map((r) => r.status)).toEqual(['pending']);
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`DELETE FROM order_line WHERE order_id = ${orderId}`);
      await recordSettlementOperation(tx, { storeId: STORE, kind: 'order_purge', operationId: orderId, effects: [], mutations: [{ type: 'order_purge', orderId }] });
    });
    const after = await effects();
    expect(after.map((r) => [r.status, (r.result as { cancelled?: string } | null)?.cancelled])).toEqual([['done', 'order_purged']]);
    await dueNow('license_issue');
    await runEffectsPass();
    expect((await effects()).some((r) => r.effectKind === 'admin_review')).toBe(false);
    expect((await audits('effect_terminal')).length).toBe(0);
  });
});
