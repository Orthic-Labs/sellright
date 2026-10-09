/**
 * Settlement chokepoint + pending effects, end to end (de-fork plan 2.8; SETTLEMENT-OPS 10).
 * Identity is the provider/business fact, effects are created once, entitlement follows the frozen
 * invoice classification. Runs against a *_test database only (TRUNCATEs store CASCADE).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../../db/client.js';
import * as s from '../../db/schema.js';
import { env } from '../../env.js';
import { applyPaymentResult } from '../settle.js';
import { onInvoicePaid, type InvoiceLike } from '../subscriptions.js';
import { runEffectsPass } from './effects.js';
import { paidOrderEffects, recordSettlementOperation } from './record.js';
import { defaultInvoiceHistoryPolicy, setInvoiceHistoryPolicy, type InvoiceDispositionDecision } from './invoice.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`settlement test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'ee000000-0000-0000-0000-0000000005e1';
const VARIANT = 'ee000000-0000-0000-0000-0000000005e2';
const SUB = 'sub_effects_1';
const DAY = 86_400_000;

async function wipe() { await pool.query('TRUNCATE store CASCADE'); }

interface Seeded { orderId: string; lineId: string }
async function seedOrder(opts: { code: string; state?: string; grandTotal?: number; email?: string }): Promise<Seeded> {
  return withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, 'eff-store', 'Eff', 'USD', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    const prod = await tx.execute(sql`
      INSERT INTO product (id, store_id, slug, name, status) VALUES (gen_random_uuid(), ${STORE}, ${'p-' + opts.code}, 'P', 'active') RETURNING id`);
    const productId = (prod.rows[0] as { id: string }).id;
    await tx.execute(sql`
      INSERT INTO product_variant (id, store_id, product_id, sku, name, price, fulfillment_type, app_key, license_duration_days, updates_duration_days, stripe_price_id, billing_interval)
      VALUES (${VARIANT}, ${STORE}, ${productId}, 'PLAN', 'Plan', 1000, 'license', 'testapp', 30, 30, 'price_1', 'month') ON CONFLICT (id) DO NOTHING`);
    const o = await tx.execute(sql`
      INSERT INTO "order" (store_id, code, state, currency, grand_total, metadata)
      VALUES (${STORE}, ${opts.code}, ${opts.state ?? 'PendingPayment'}::order_state, 'USD', ${opts.grandTotal ?? 1000}, ${JSON.stringify(opts.email ? { contact: { email: opts.email } } : {})}::jsonb) RETURNING id`);
    const orderId = (o.rows[0] as { id: string }).id;
    const l = await tx.execute(sql`
      INSERT INTO order_line (store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
      VALUES (${STORE}, ${orderId}, ${VARIANT}, 'PLAN', 'Plan', 1, 1000, 1000, 1000, 0) RETURNING id`);
    return { orderId, lineId: (l.rows[0] as { id: string }).id };
  });
}
const seedSubscription = (orderId: string | null) => withStore(STORE, (tx) => tx.execute(sql`
  INSERT INTO subscription (store_id, order_id, stripe_subscription_id, status) VALUES (${STORE}, ${orderId}, ${SUB}, 'incomplete')`));

const invoice = (id: string, reason: string | null, pi: string, amount = 1000): InvoiceLike => ({
  id, subscription: SUB, customer: 'cus_1', payment_intent: pi, billing_reason: reason, amount_paid: amount, currency: 'usd',
  lines: { data: [{ price: { id: 'price_1' }, period: { end: 1_900_000_000 } }] },
});
const deliver = (inv: InvoiceLike) => withStore(STORE, (tx) => onInvoicePaid(tx, STORE, inv));
const licences = () => withStore(STORE, (tx) => tx.select().from(s.license));
const payments = () => withStore(STORE, (tx) => tx.select().from(s.payment));
const effects = () => withStore(STORE, (tx) => tx.select().from(s.orderPendingEffect));
const operations = () => withStore(STORE, (tx) => tx.select().from(s.settlementOperation));
const op = async (kind: string, id: string) => (await operations()).find((r) => r.operationKind === kind && r.operationId === id);
const orderState = (id: string) => withStore(STORE, async (tx) => (await tx.select({ st: s.order.state }).from(s.order).where(eq(s.order.id, id)))[0]!.st);
const subRow = () => withStore(STORE, async (tx) => (await tx.select().from(s.subscription).where(eq(s.subscription.stripeSubscriptionId, SUB)))[0]!);
const dueNow = (kind: string) => withStore(STORE, (tx) => tx.execute(sql`UPDATE order_pending_effect SET next_attempt_at = now() - interval '1 second' WHERE effect_kind = ${kind}`));
const expiry = async () => (await licences())[0]!.expiresAt!.getTime();

beforeEach(async () => { await wipe(); setInvoiceHistoryPolicy(null); });
afterAll(async () => { setInvoiceHistoryPolicy(null); await wipe(); });

describe('order Paid transition — operations and effects behind the chokepoint', () => {
  it('a settled payment is a payment_settled operation, then an order_paid_transition whose fan-out ran once', async () => {
    const { orderId } = await seedOrder({ code: 'PAID-1', email: 'buyer@example.test' });
    const run = () => withStore(STORE, (tx) => applyPaymentResult(tx, {
      storeId: STORE, method: 'stripe', order: { id: orderId, state: 'PendingPayment', grandTotal: 1000, currency: 'USD' },
      result: { state: 'Settled', providerRef: 'pi_paid_1', metadata: {} },
    }));
    expect((await run()).orderState).toBe('Paid');
    expect(await orderState(orderId)).toBe('Paid');
    expect((await licences()).length).toBe(1);
    const paymentId = (await payments())[0]!.id;
    expect((await op('payment_settled', paymentId))!.paymentId).toBe(paymentId);
    const t = await op('order_paid_transition', orderId);
    expect(t!.orderId).toBe(orderId);
    const fx = (await effects()).filter((r) => r.operationKind === 'order_paid_transition');
    expect(fx.map((r) => r.effectKind).sort()).toEqual(['license_issue', 'loyalty_earn', 'notification']);
    expect(fx.every((r) => r.status === 'done' && r.operationId === orderId)).toBe(true);
    const outbox = await withStore(STORE, (tx) => tx.execute(sql`SELECT kind FROM email_outbox WHERE store_id = ${STORE}`));
    expect(outbox.rows.map((r) => (r as { kind: string }).kind)).toContain('order_confirmation');
    // replay of the same payment fact: nothing new
    const before = (await effects()).length;
    await run();
    expect([(await effects()).length, (await licences()).length, (await payments()).length]).toEqual([before, 1, 1]);
  });

  it('partial tender then the remaining balance: one Paid transition, effects created once', async () => {
    const { orderId } = await seedOrder({ code: 'PART-1' });
    const pay = (ref: string, amount: number) => withStore(STORE, (tx) => applyPaymentResult(tx, {
      storeId: STORE, method: 'stripe', amount, order: { id: orderId, state: 'PendingPayment', grandTotal: 1000, currency: 'USD' },
      result: { state: 'Settled', providerRef: ref, metadata: {} },
    }));
    expect((await pay('pi_part_a', 400)).orderState).toBe('PendingPayment');
    expect((await effects()).length).toBe(0);
    expect((await pay('pi_part_b', 600)).orderState).toBe('Paid');
    expect((await effects()).filter((r) => r.effectKind === 'license_issue').length).toBe(1);
    expect((await operations()).filter((r) => r.operationKind === 'payment_settled').length).toBe(2);
  });

  it('multiple balance settlements: payment_settled x2 for gateway balances, order_edit_balance_settled x2 for edit payments', async () => {
    const { orderId } = await seedOrder({ code: 'BAL-1', state: 'Paid', grandTotal: 1500 });
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`INSERT INTO payment (store_id, order_id, amount, method, state, provider_ref) VALUES (${STORE}, ${orderId}, 1000, 'stripe', 'Settled', 'pi_bal_0')`);
    });
    const settle = (ref: string, amount: number, grand: number, editId?: string) => withStore(STORE, (tx) => applyPaymentResult(tx, {
      storeId: STORE, method: 'stripe', amount, editId, order: { id: orderId, state: 'Paid', grandTotal: grand, currency: 'USD' },
      result: { state: 'Settled', providerRef: ref, metadata: {} },
    }));
    await settle('pi_bal_1', 500, 1500); // pay-link balance: no edit id
    let fx = (await effects()).filter((r) => r.effectKind === 'edit_reconcile');
    expect(fx.map((r) => r.operationKind)).toEqual(['payment_settled']);
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE "order" SET grand_total = 2000 WHERE id = ${orderId}`));
    await settle('pi_bal_2', 500, 2000, 'edit-A'); // the edit's own record_payment
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE "order" SET grand_total = 2500 WHERE id = ${orderId}`));
    await settle('pi_bal_3', 500, 2500, 'edit-B');
    fx = (await effects()).filter((r) => r.effectKind === 'edit_reconcile');
    expect(fx.map((r) => `${r.operationKind}:${r.operationId.startsWith('edit-') ? r.operationId : 'pay'}`).sort())
      .toEqual(['order_edit_balance_settled:edit-A', 'order_edit_balance_settled:edit-B', 'payment_settled:pay']);
  });

  it('refund before effects: a deferred license_issue on a refunded order goes terminal instead of issuing', async () => {
    const { orderId } = await seedOrder({ code: 'REF-1', state: 'Paid' });
    await withStore(STORE, (tx) => recordSettlementOperation(tx, {
      storeId: STORE, kind: 'order_paid_transition', operationId: orderId, effectMode: 'deferred', mutations: [],
      effects: paidOrderEffects({ orderId, customerId: null, paidAt: new Date(), variant: 'settle' }),
    }));
    expect((await licences()).length).toBe(0);
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE "order" SET state = 'Refunded' WHERE id = ${orderId}`));
    await runEffectsPass();
    expect((await licences()).length).toBe(0);
    const issue = (await effects()).find((r) => r.effectKind === 'license_issue')!;
    expect([issue.status, issue.lastError]).toEqual(['terminal', 'order_state_Refunded']);
  });

  it('historical import and synthetic seed can never create effects', async () => {
    for (const kind of ['historical_import', 'synthetic_seed'] as const) {
      await expect(withStore(STORE, (tx) => recordSettlementOperation(tx, {
        storeId: STORE, kind, operationId: 'x', mutations: [], effects: [{ kind: 'license_issue' }],
      }))).rejects.toThrow(/not eligible/);
    }
  });
});

describe('invoice.paid — one frozen operation per invoice', () => {
  async function firstCycle(): Promise<Seeded> {
    const seeded = await seedOrder({ code: 'SUB-1' });
    await seedSubscription(seeded.orderId);
    await deliver(invoice('in_1', 'subscription_create', 'pi_in_1'));
    return seeded;
  }

  it('first cycle is ONE operation: payment + Paid transition + issuance/loyalty/notification, licence linked, classification frozen', async () => {
    const { orderId } = await firstCycle();
    expect(await orderState(orderId)).toBe('Paid');
    const lic = (await licences())[0]!;
    expect((await subRow()).licenseId).toBe(lic.id);
    const o = await op('stripe_invoice_paid', 'in_1');
    expect([o!.classification, o!.orderId, o!.licenseId, o!.paymentIntent]).toEqual(['first_cycle', orderId, lic.id, 'pi_in_1']);
    expect(o!.paymentId).toBe((await payments())[0]!.id);
    expect(o!.authorizedEffects.sort()).toEqual(['admin_review', 'edit_reconcile', 'license_issue', 'loyalty_earn', 'notification']);
    const fx = (await effects()).filter((r) => r.operationKind === 'stripe_invoice_paid');
    expect(fx.map((r) => r.effectKind).sort()).toEqual(['license_issue', 'loyalty_earn', 'notification']);
    // never also opens payment_settled / order_paid_transition rows
    expect((await operations()).map((r) => r.operationKind)).toEqual(['stripe_invoice_paid']);
  });

  it('replay of a first-cycle invoice (any delivery, changed or missing reason) yields one issuance and no extension', async () => {
    await firstCycle();
    const before = (await licences())[0]!;
    await deliver(invoice('in_1', 'subscription_create', 'pi_in_1'));
    await deliver(invoice('in_1', null, 'pi_in_1'));
    await deliver(invoice('in_1', 'subscription_cycle', 'pi_in_1')); // contradictory: ignored and audited
    const after = await licences();
    expect(after.length).toBe(1);
    expect([after[0]!.expiresAt!.getTime(), after[0]!.updatesUntil!.getTime()]).toEqual([before.expiresAt!.getTime(), before.updatesUntil!.getTime()]);
    expect((await payments()).length).toBe(1);
    expect((await effects()).filter((r) => r.effectKind === 'license_issue').length).toBe(1);
    expect((await effects()).some((r) => r.effectKind === 'license_extend')).toBe(false);
    const audits = await withStore(STORE, (tx) => tx.select().from(s.auditLog).where(eq(s.auditLog.action, 'settlement_classification_replayed')));
    expect(audits.length).toBe(1);
  });

  it('each distinct renewal invoice extends exactly once; redelivery extends nothing; renewals never issue', async () => {
    await firstCycle();
    const t0 = await expiry();
    await deliver(invoice('in_2', 'subscription_cycle', 'pi_in_2'));
    expect(await expiry()).toBe(t0 + 30 * DAY);
    await deliver(invoice('in_2', 'subscription_cycle', 'pi_in_2'));
    expect(await expiry()).toBe(t0 + 30 * DAY);
    await deliver(invoice('in_3', 'subscription_cycle', 'pi_in_3'));
    expect(await expiry()).toBe(t0 + 60 * DAY);
    expect((await payments()).length).toBe(3);
    const ext = (await effects()).filter((r) => r.effectKind === 'license_extend');
    expect(ext.map((r) => r.status)).toEqual(['done', 'done']);
    expect((ext[0]!.result as { licenseId: string }).licenseId).toBe((await licences())[0]!.id);
    expect((await licences()).length).toBe(1);
  });

  it('proration, threshold, manual and update invoices record money and never grant a period', async () => {
    await firstCycle();
    const t0 = await expiry();
    await deliver(invoice('in_p', 'subscription_update', 'pi_p', 250));
    await deliver(invoice('in_t', 'subscription_threshold', 'pi_t', 100));
    await deliver(invoice('in_m', 'manual', 'pi_m', 100));
    expect(await expiry()).toBe(t0);
    expect((await payments()).length).toBe(4);
    expect((await op('stripe_invoice_paid', 'in_p'))!.classification).toBe('adjustment');
    expect((await effects()).some((r) => r.effectKind === 'license_extend')).toBe(false);
  });

  it('unknown/legacy reasons: initial invoice -> first cycle; later null reason -> renewal; non-null legacy reason holds (never extends)', async () => {
    const { orderId } = await seedOrder({ code: 'SUB-U' });
    await seedSubscription(orderId);
    await deliver(invoice('in_u1', null, 'pi_u1'));
    expect((await op('stripe_invoice_paid', 'in_u1'))!.classification).toBe('first_cycle');
    const t0 = await expiry();
    await deliver(invoice('in_u2', null, 'pi_u2'));
    expect((await op('stripe_invoice_paid', 'in_u2'))!.classification).toBe('renewal');
    expect(await expiry()).toBe(t0 + 30 * DAY);
    await deliver(invoice('in_u3', 'subscription', 'pi_u3')); // legacy reason on a non-initial invoice
    expect((await op('stripe_invoice_paid', 'in_u3'))!.classification).toBe('adjustment');
    expect(await expiry()).toBe(t0 + 30 * DAY);
    const hold = (await effects()).find((r) => r.operationId === 'in_u3' && r.effectKind === 'admin_review');
    expect(hold!.status).toBe('terminal');
  });

  it('cycle invoice with no licence linked is the first cycle (main dispatch): licence issued and linked, no extension queued', async () => {
    const { orderId } = await seedOrder({ code: 'SUB-R' });
    await seedSubscription(orderId);
    await deliver(invoice('in_r', 'subscription_cycle', 'pi_r'));
    expect((await operations()).find((r) => r.operationId === 'in_r')!.classification).toBe('first_cycle');
    expect(await orderState(orderId)).toBe('Paid');
    const issued = (await licences())[0]!;
    expect((await subRow()).licenseId).toBe(issued.id);
    expect((await effects()).some((r) => r.effectKind === 'license_extend')).toBe(false);
    // a later create-reason invoice is classified by its authoritative reason: money only, no second licence
    await deliver(invoice('in_f', 'subscription_create', 'pi_f'));
    expect((await licences()).length).toBe(1);
    expect(await expiry()).toBe(issued.expiresAt!.getTime());
  });

  it('delayed first invoice after activation does not extend the already-linked licence', async () => {
    const { orderId } = await seedOrder({ code: 'SUB-D', state: 'Paid' });
    await seedSubscription(orderId);
    const lic = await withStore(STORE, async (tx) => {
      const [line] = await tx.select().from(s.orderLine).where(eq(s.orderLine.orderId, orderId));
      const r = await tx.execute(sql`INSERT INTO license (store_id, order_id, order_line_id, app_key, license_key, status, expires_at)
        VALUES (${STORE}, ${orderId}, ${line!.id}, 'testapp', 'LIC-D', 'active', now() + interval '10 days') RETURNING id, expires_at`);
      await tx.execute(sql`UPDATE subscription SET license_id = ${(r.rows[0] as { id: string }).id}`);
      return r.rows[0] as { id: string; expires_at: Date };
    });
    await deliver(invoice('in_first', 'subscription_create', 'pi_first'));
    expect(await expiry()).toBe(new Date(lic.expires_at).getTime());
    expect((await op('stripe_invoice_paid', 'in_first'))!.classification).toBe('first_cycle');
  });

  const policyFor = (map: Record<string, Partial<InvoiceDispositionDecision>>) => setInvoiceHistoryPolicy({
    ...defaultInvoiceHistoryPolicy,
    async disposition(_tx, key) {
      const d = map[key.invoiceId];
      return d ? { disposition: 'new', entitlementAction: 'normal', moneyAction: 'normal', ...d } : { disposition: 'new', entitlementAction: 'normal', moneyAction: 'normal' };
    },
  });

  it('a legacy renewal already applied pre-adoption is a no-op for entitlement (applied: operation row only, dates untouched)', async () => {
    await firstCycle();
    const before = (await licences())[0]!;
    policyFor({ in_old: { disposition: 'applied', entitlementAction: 'none', moneyAction: 'record_order_payment' } });
    await deliver(invoice('in_old', 'subscription_cycle', 'pi_old'));
    const after = (await licences())[0]!;
    expect([after.expiresAt!.getTime(), after.updatesUntil!.getTime(), after.updatedAt.getTime()]).toEqual([before.expiresAt!.getTime(), before.updatesUntil!.getTime(), before.updatedAt.getTime()]);
    expect((await payments()).some((p) => p.providerRef === 'pi_old')).toBe(true);
    expect((await op('stripe_invoice_paid', 'in_old'))!.disposition).toBe('applied');
    expect((await effects()).some((r) => r.operationId === 'in_old')).toBe(false);
  });

  it('unresolved / paid_no_effect invoices hold a terminal admin_review with no money action and no entitlement', async () => {
    await firstCycle();
    const t0 = await expiry();
    policyFor({ in_amb: { disposition: 'unresolved', entitlementAction: 'hold', moneyAction: 'hold_money', reason: 'evidence_conflict' } });
    await deliver(invoice('in_amb', 'subscription_cycle', 'pi_amb'));
    const hold = (await effects()).find((r) => r.operationId === 'in_amb')!;
    expect([hold.effectKind, hold.status]).toEqual(['admin_review', 'terminal']);
    expect((await payments()).some((p) => p.providerRef === 'pi_amb')).toBe(false);
    expect(await expiry()).toBe(t0);
    expect((await withStore(STORE, (tx) => tx.select().from(s.auditLog).where(and(eq(s.auditLog.action, 'effect_terminal'))))).length).toBe(1);
  });

  it('pending_at_frontier is not recorded until its invoice.paid arrives under the candidate', async () => {
    await firstCycle();
    policyFor({ in_open: { disposition: 'pending_at_frontier', entitlementAction: 'defer', moneyAction: 'defer' } });
    await deliver(invoice('in_open', 'subscription_cycle', 'pi_open'));
    expect(await op('stripe_invoice_paid', 'in_open')).toBeUndefined();
    setInvoiceHistoryPolicy(null);
    await deliver(invoice('in_open', 'subscription_cycle', 'pi_open'));
    expect((await op('stripe_invoice_paid', 'in_open'))!.classification).toBe('renewal');
  });

  it('a plugin InvoiceHistoryPolicy resolves the initial invoice; unresolved holds the invoice and its money', async () => {
    await firstCycle();
    const t0 = await expiry();
    setInvoiceHistoryPolicy({ ...defaultInvoiceHistoryPolicy, async initialInvoice() { return 'unresolved'; } });
    await deliver(invoice('in_c2', null, 'pi_c2'));
    expect((await op('stripe_invoice_paid', 'in_c2'))!.classification).toBe('unresolved');
    expect((await payments()).some((p) => p.providerRef === 'pi_c2')).toBe(false);
    expect(await expiry()).toBe(t0);
  });

  it('an orphan renewal (no backing order) records subscription_invoice_payment, extends, and audits renewal_no_order before renewed', async () => {
    const { orderId } = await seedOrder({ code: 'SUB-O' });
    await seedSubscription(orderId);
    await deliver(invoice('in_o1', 'subscription_create', 'pi_o1'));
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE subscription SET order_id = NULL`));
    const t0 = await expiry();
    await deliver(invoice('in_o2', 'subscription_cycle', 'pi_o2'));
    expect(await expiry()).toBe(t0 + 30 * DAY);
    expect((await payments()).length).toBe(1); // no payment row: payment.order_id is NOT NULL
    const rows = await withStore(STORE, (tx) => tx.select().from(s.subscriptionInvoicePayment));
    expect(rows.map((r) => [r.invoiceId, r.orderId, r.amount, r.origin, r.state])).toEqual([['in_o2', null, 1000, 'live', 'Settled']]);
    const audits = await withStore(STORE, (tx) => tx.execute(sql`SELECT action FROM audit_log WHERE entity = 'subscription' ORDER BY at, id`));
    const actions = audits.rows.map((a) => (a as { action: string }).action);
    expect(actions).toContain('subscription_renewal_no_order');
    expect(actions).toContain('subscription_renewed');
    expect((await op('stripe_invoice_paid', 'in_o2'))!.invoicePaymentId).toBe(rows[0]!.id);
  });

  it('first cycle adopts a Pending payment row with the intent providerRef: one row, Settled, same id (main applyPaymentResult)', async () => {
    const seeded = await seedOrder({ code: 'SUB-PEND' });
    await seedSubscription(seeded.orderId);
    const [pending] = await withStore(STORE, (tx) => tx.insert(s.payment).values({
      storeId: STORE, orderId: seeded.orderId, amount: 1000, method: 'stripe', providerRef: 'pi_in_pend', state: 'Pending', currency: 'USD',
    }).returning({ id: s.payment.id }));
    await deliver(invoice('in_pend', 'subscription_create', 'pi_in_pend'));
    const rows = await payments();
    expect(rows.length).toBe(1);
    expect([rows[0]!.id, rows[0]!.state]).toEqual([pending!.id, 'Settled']);
    expect(await orderState(seeded.orderId)).toBe('Paid');
    expect((await op('stripe_invoice_paid', 'in_pend'))!.paymentId).toBe(pending!.id);
  });

  it('a first-cycle invoice with no backing order is held (admin_review) with orderless money, never silently dropped', async () => {
    await pool.query(`INSERT INTO store (id, slug, name, currency) VALUES ($1, 'eff-store', 'Eff', 'USD') ON CONFLICT DO NOTHING`, [STORE]);
    await seedSubscription(null);
    await deliver(invoice('in_n1', 'subscription_create', 'pi_n1'));
    expect((await effects()).find((r) => r.operationId === 'in_n1')!.effectKind).toBe('admin_review');
    expect((await withStore(STORE, (tx) => tx.select().from(s.subscriptionInvoicePayment))).length).toBe(1);
    expect((await licences()).length).toBe(0);
  });
});
