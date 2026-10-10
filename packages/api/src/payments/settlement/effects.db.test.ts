/**
 * Pending-effects engine + chokepoint contract (de-fork plan 2.8; SETTLEMENT-OPS 7-8).
 * Engine behaviour is exercised with probe handlers registered over real effect kinds,
 * whose side effect is an audit_log row so "the mutation committed (or rolled back) with
 * the status" is directly observable. Runs against a *_test database only (TRUNCATEs store CASCADE).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../../db/client.js';
import * as s from '../../db/schema.js';
import { env } from '../../env.js';
import {
  claimDueEffects, enqueueEffects, getEffectHandler, listEffectsNeedingAttention, MAX_ATTEMPTS, processClaimedEffect,
  registerEffectHandler, requeueTerminalEffect, runEffectsPass, backoffSeconds,
  type EffectHandler, type EffectRow,
} from './effects.js';
import { recordSettlementOperation } from './record.js';
import type { EffectKind } from './ops.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`effects test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'ee000000-0000-0000-0000-00000000e001';
const OTHER = 'ee000000-0000-0000-0000-00000000e002';
const PROBE = 'notification' as const;
const EXT = 'license_extend' as const;

type ProbePayload = { failAfterWrite?: boolean; latch?: boolean };
let calls = 0;
let release: (() => void) | null = null;
let started: (() => void) | null = null;
const builtins = new Map<string, EffectHandler | undefined>();

const probe: EffectHandler = {
  async run(tx, e) {
    calls++;
    await tx.insert(s.auditLog).values({ storeId: e.storeId, actor: 'test', entity: 'probe', entityId: e.id, action: 'probe_ran' });
    const p = e.payload as ProbePayload;
    if (p.latch) { started?.(); await new Promise<void>((r) => { release = r; }); }
    if (p.failAfterWrite) throw new Error('boom');
  },
};

async function wipe() { await pool.query('TRUNCATE store CASCADE'); }
async function seed() {
  await pool.query(`INSERT INTO store (id, slug, name, currency) VALUES ($1,'pe1','PE1','USD'),($2,'pe2','PE2','USD')`, [STORE, OTHER]);
}
const effectRows = (storeId = STORE) => withStore(storeId, (tx) => tx.select().from(s.orderPendingEffect));
const probeAudits = () => withStore(STORE, async (tx) => (await tx.execute(sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'probe_ran'`)).rows[0] as { n: number }).then((r) => r.n);
/** a settlement_operation row (the FK target) plus one deferred effect */
const enqueueProbe = (opId: string, payload: ProbePayload = {}, storeId = STORE, kind: EffectKind = PROBE) => withStore(storeId, async (tx) => {
  await tx.execute(sql`INSERT INTO settlement_operation (store_id, operation_kind, operation_id) VALUES (${storeId}, 'order_paid_transition', ${opId}) ON CONFLICT DO NOTHING`);
  return enqueueEffects(tx, storeId, { kind: 'order_paid_transition', id: opId }, [{ kind, payload }]);
});
const setRow = (id: string, set: ReturnType<typeof sql>) => withStore(STORE, (tx) => tx.execute(sql`UPDATE order_pending_effect SET ${set} WHERE id = ${id}`));
const makeDue = (id: string) => setRow(id, sql`next_attempt_at = now() - interval '1 second'`);

beforeEach(async () => {
  await wipe(); await seed(); calls = 0; release = null; started = null;
  for (const k of [PROBE, EXT, 'license_issue', 'loyalty_earn']) builtins.set(k, getEffectHandler(k));
  registerEffectHandler(PROBE, probe);
});
afterEach(() => { for (const [k, h] of builtins) if (h) registerEffectHandler(k, h); });
afterAll(async () => { await wipe(); });

describe('order_pending_effect — identity and replay', () => {
  it('a replay of the same operation fact creates no second row and never re-runs the effect', async () => {
    expect((await enqueueProbe('op-1')).length).toBe(1);
    expect((await enqueueProbe('op-1')).length).toBe(0);
    expect((await runEffectsPass()).done).toBe(1);
    expect((await enqueueProbe('op-1')).length).toBe(0);
    expect((await runEffectsPass()).done).toBe(0);
    expect(calls).toBe(1);
    expect(await probeAudits()).toBe(1);
    expect((await effectRows()).map((r) => r.status)).toEqual(['done']);
  });

  it('the same fact in another store is a different operation (tenant-scoped identity)', async () => {
    await enqueueProbe('op-x', {}, STORE);
    expect((await enqueueProbe('op-x', {}, OTHER)).length).toBe(1);
  });

  it('an effect row cannot exist without its settlement_operation (composite FK)', async () => {
    await expect(withStore(STORE, (tx) => enqueueEffects(tx, STORE, { kind: 'order_paid_transition', id: 'no-op' }, [{ kind: PROBE }]))).rejects.toThrow();
  });
});

describe('effects worker — claim, fence, retry, terminal', () => {
  it('commits the effect mutation in the same transaction as done', async () => {
    await enqueueProbe('op-a');
    await runEffectsPass();
    expect(await probeAudits()).toBe(1);
    const [row] = await effectRows();
    expect([row!.status, row!.attempts]).toEqual(['done', 1]);
    expect(row!.claimToken).not.toBeNull();
  });

  it('a failure after the mutation rolls it back, schedules least(2^n*30s,1h) backoff, then succeeds', async () => {
    const [e] = await enqueueProbe('op-b', { failAfterWrite: true });
    await runEffectsPass();
    expect(await probeAudits()).toBe(0);
    let [row] = await effectRows();
    expect([row!.status, row!.attempts, row!.lastError]).toEqual(['pending', 1, 'boom']);
    expect(row!.firstFailedAt).not.toBeNull();
    const delay = row!.nextAttemptAt.getTime() - Date.now();
    expect(delay).toBeGreaterThan(30_000); expect(delay).toBeLessThanOrEqual(backoffSeconds(1) * 1000 + 2000);
    expect(backoffSeconds(1)).toBe(60); expect(backoffSeconds(7)).toBe(3600);
    expect((await runEffectsPass()).done).toBe(0);
    await setRow(e!.id, sql`payload = '{}'::jsonb, next_attempt_at = now() - interval '1 second'`);
    expect((await runEffectsPass()).done).toBe(1);
    [row] = await effectRows();
    expect([row!.status, row!.attempts]).toEqual(['done', 2]);
    expect(await probeAudits()).toBe(1);
  });

  it('bounded retries end terminal with an admin_review row, audit + list visibility, and are requeueable', async () => {
    const [e] = await enqueueProbe('op-c', { failAfterWrite: true });
    for (let i = 0; i < MAX_ATTEMPTS; i++) { await runEffectsPass(); await makeDue(e!.id); }
    const rows = await effectRows();
    const row = rows.find((r) => r.id === e!.id)!;
    expect([row.status, row.attempts, row.claimToken]).toEqual(['terminal', MAX_ATTEMPTS, null]);
    expect(rows.find((r) => r.effectKind === 'admin_review')!.status).toBe('terminal');
    const audits = await withStore(STORE, (tx) => tx.select().from(s.auditLog).where(eq(s.auditLog.action, 'effect_terminal')));
    expect(audits.length).toBe(2);
    expect((await withStore(STORE, (tx) => listEffectsNeedingAttention(tx))).map((r) => r.id)).toContain(e!.id);
    expect(await claimDueEffects(STORE)).toEqual([]);
    await setRow(e!.id, sql`payload = '{}'::jsonb`);
    expect(await withStore(STORE, (tx) => requeueTerminalEffect(tx, e!.id))).toBe(true);
    expect((await runEffectsPass()).done).toBe(1);
    const review = rows.find((r) => r.effectKind === 'admin_review')!;
    expect(await withStore(STORE, (tx) => requeueTerminalEffect(tx, review.id))).toBe(false); // a task, not an effect
  });

  it('C5/C6: reclaims a stale claim with a NEW token and fences the old claimant out', async () => {
    const [e] = await enqueueProbe('op-d');
    const [a] = await claimDueEffects(STORE);
    expect(a!.id).toBe(e!.id);
    expect(await claimDueEffects(STORE)).toEqual([]);
    await setRow(e!.id, sql`claimed_at = now() - interval '10 minutes'`);
    const [b] = await claimDueEffects(STORE);
    expect(b!.claimToken).not.toBe(a!.claimToken);
    expect(b!.attempts).toBe(2);
    expect(await processClaimedEffect(a as EffectRow)).toBe('stale');
    expect(calls).toBe(0);
    expect(await processClaimedEffect(b as EffectRow)).toBe('done');
    expect(await processClaimedEffect(a as EffectRow)).toBe('stale');
    expect(calls).toBe(1);
    expect(await probeAudits()).toBe(1);
  });

  it('C5: a stale-looking claim whose owner is still inside its transaction is not stolen', async () => {
    const [e] = await enqueueProbe('op-e', { latch: true });
    const [a] = await claimDueEffects(STORE);
    await setRow(e!.id, sql`claimed_at = now() - interval '10 minutes'`);
    const running = new Promise<void>((r) => { started = r; });
    const work = processClaimedEffect(a as EffectRow);
    await running;
    expect(await claimDueEffects(STORE)).toEqual([]);
    release!();
    expect(await work).toBe('done');
    expect(calls).toBe(1);
  });

  it('C4: a crash after the effect committed but before acknowledgement does not repeat the effect', async () => {
    await enqueueProbe('op-f');
    const [a] = await claimDueEffects(STORE);
    expect(await processClaimedEffect(a as EffectRow)).toBe('done');
    await setRow(a!.id, sql`claimed_at = now() - interval '10 minutes'`);
    expect(await claimDueEffects(STORE)).toEqual([]);
    expect((await runEffectsPass()).done).toBe(0);
    expect(calls).toBe(1);
  });

  it('C2/C3: a crashed claimant is reclaimed once after the stale window and runs exactly once', async () => {
    const [e] = await enqueueProbe('op-g');
    await claimDueEffects(STORE);
    expect(await claimDueEffects(STORE)).toEqual([]);
    await setRow(e!.id, sql`claimed_at = now() - interval '6 minutes'`);
    expect((await runEffectsPass()).done).toBe(1);
    expect(calls).toBe(1);
    expect((await effectRows())[0]!.attempts).toBe(2);
  });

  it('runs a later-rank effect only after the earlier-rank sibling of the same operation is done', async () => {
    const order: string[] = [];
    const mk = (k: string): EffectHandler => ({ async run() { order.push(k); } });
    registerEffectHandler('license_issue', mk('license_issue'));
    registerEffectHandler('loyalty_earn', mk('loyalty_earn'));
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`INSERT INTO settlement_operation (store_id, operation_kind, operation_id) VALUES (${STORE}, 'order_paid_transition', 'op-h')`);
      await enqueueEffects(tx, STORE, { kind: 'order_paid_transition', id: 'op-h' }, [{ kind: 'loyalty_earn' }, { kind: 'license_issue' }]);
    });
    const first = await claimDueEffects(STORE);
    expect(first.map((r) => r.effectKind)).toEqual(['license_issue']);
    await processClaimedEffect(first[0]!);
    const second = await claimDueEffects(STORE);
    expect(second.map((r) => r.effectKind)).toEqual(['loyalty_earn']);
    await processClaimedEffect(second[0]!);
    expect(order).toEqual(['license_issue', 'loyalty_earn']);
  });

  it('a "not ready" retry mutates nothing, keeps its attempt budget, and goes terminal after its horizon', async () => {
    registerEffectHandler(PROBE, { async run() { return { retry: { reason: 'licence_not_linked', delayMs: 60_000, horizonMs: 1000 } }; } });
    const [e] = await enqueueProbe('op-i');
    await runEffectsPass();
    let [row] = await effectRows();
    expect([row!.status, row!.lastError]).toEqual(['pending', 'licence_not_linked']);
    await setRow(e!.id, sql`next_attempt_at = now() - interval '1 second', first_failed_at = now() - interval '1 hour'`);
    await runEffectsPass();
    row = (await effectRows()).find((r) => r.id === e!.id)!;
    expect(row.status).toBe('terminal');
  });

  it('a precondition that can never hold goes terminal immediately with an admin_review row', async () => {
    registerEffectHandler(PROBE, { async run() { return { terminal: 'order_state_Refunded' }; } });
    const [e] = await enqueueProbe('op-j');
    await runEffectsPass();
    const rows = await effectRows();
    expect(rows.find((r) => r.id === e!.id)!.status).toBe('terminal');
    expect(rows.some((r) => r.effectKind === 'admin_review')).toBe(true);
  });

  it('records the handler result on the row', async () => {
    registerEffectHandler(PROBE, { async run() { return { done: { result: { licenseId: 'L1' } } }; } });
    await enqueueProbe('op-k');
    await runEffectsPass();
    expect((await effectRows())[0]!.result).toEqual({ licenseId: 'L1' });
  });
});

describe('external effects — idempotency key and receipt', () => {
  it('passes the effect id as the idempotency key; receipt + done commit together; a present receipt skips the call (C7)', async () => {
    const keys: string[] = [];
    let failComplete = true;
    registerEffectHandler(EXT, {
      mode: 'external',
      async call(_e, ctx) { keys.push(ctx.idempotencyKey); return { providerRef: 'prov_1' }; },
      async complete() { if (failComplete) { failComplete = false; throw new Error('crash before done'); } },
    });
    const [e] = await enqueueProbe('op-x1', {}, STORE, EXT);
    await runEffectsPass();
    expect(keys).toEqual([e!.id]);
    // receipt + done are one transaction: the failed completion rolled the receipt back
    expect(await withStore(STORE, (tx) => tx.select().from(s.appliedOperationReceipt))).toEqual([]);
    await makeDue(e!.id);
    await runEffectsPass();
    expect(keys).toEqual([e!.id, e!.id]); // provider retried with the SAME key
    expect((await withStore(STORE, (tx) => tx.select().from(s.appliedOperationReceipt))).map((r) => [r.effectId, r.providerRef])).toEqual([[e!.id, 'prov_1']]);
    expect((await effectRows())[0]!.status).toBe('done');
    // C7: receipt present but done missing -> the call is skipped
    const [e2] = await enqueueProbe('op-x2', {}, STORE, EXT);
    await withStore(STORE, (tx) => tx.insert(s.appliedOperationReceipt).values({ effectId: e2!.id, storeId: STORE, providerRef: 'prov_2' }));
    await runEffectsPass();
    expect(keys.length).toBe(2);
    expect((await effectRows()).find((r) => r.id === e2!.id)!.status).toBe('done');
  });
});

describe('recordSettlementOperation — contract', () => {
  const rec = (op: Partial<Parameters<typeof recordSettlementOperation>[1]> & { kind: Parameters<typeof recordSettlementOperation>[1]['kind'] }) =>
    withStore(STORE, (tx) => recordSettlementOperation(tx, { storeId: STORE, operationId: 'o1', mutations: [], effects: [], ...op }));
  const newOrder = (code: string) => withStore(STORE, async (tx) => (await tx.execute(sql`INSERT INTO "order" (store_id, code, state, currency, grand_total) VALUES (${STORE}, ${code}, 'PendingPayment', 'USD', 100) RETURNING id`)).rows[0] as { id: string }).then((r) => r.id);

  it('rejects effects the kind is not eligible for (duplicate capture can never issue) and unauthorized classifications', async () => {
    await expect(rec({ kind: 'duplicate_capture_recorded', effects: [{ kind: 'license_issue' }] })).rejects.toThrow(/not eligible for effect "license_issue"/);
    await expect(rec({ kind: 'stripe_invoice_paid', classification: 'renewal', effects: [{ kind: 'license_issue' }] })).rejects.toThrow(/not authorized/);
    await expect(rec({ kind: 'stripe_invoice_paid', effects: [] })).rejects.toThrow(/requires a classification/);
  });

  it('rejects mutations the kind may not perform and a transaction scoped to another store', async () => {
    await expect(rec({ kind: 'payment_mode_corrected', mutations: [{ type: 'order_paid', orderId: STORE, placedAt: new Date() }] })).rejects.toThrow(/may not perform mutation/);
    await expect(withStore(OTHER, (tx) => recordSettlementOperation(tx, { storeId: STORE, kind: 'synthetic_seed', operationId: 'x', mutations: [], effects: [] }))).rejects.toThrow(/scoped/);
  });

  it('inline: an effect failure aborts the whole settlement (Paid mutation, operation and effect rows roll back)', async () => {
    registerEffectHandler('license_issue', { async run() { throw new Error('issuance exploded'); } });
    const orderId = await newOrder('RB-1');
    await expect(rec({ kind: 'order_paid_transition', operationId: orderId, mutations: [{ type: 'order_paid', orderId, placedAt: new Date() }], effects: [{ kind: 'license_issue', payload: {} }] })).rejects.toThrow('issuance exploded');
    const [o] = await withStore(STORE, (tx) => tx.select({ state: s.order.state }).from(s.order).where(eq(s.order.id, orderId)));
    expect(o!.state).toBe('PendingPayment');
    expect(await effectRows()).toEqual([]);
    expect(await withStore(STORE, (tx) => tx.select().from(s.settlementOperation))).toEqual([]);
  });

  it('inline: effects run in rank order before commit; a replay mutates nothing and creates no effect', async () => {
    const seen: string[] = [];
    for (const k of ['license_issue', 'loyalty_earn', 'notification'] as const) registerEffectHandler(k, { async run() { seen.push(k); } });
    const orderId = await newOrder('RB-2');
    const first = await rec({ kind: 'order_paid_transition', operationId: orderId, mutations: [{ type: 'order_paid', orderId, placedAt: new Date() }], effects: [{ kind: 'notification' }, { kind: 'loyalty_earn' }, { kind: 'license_issue' }] });
    expect([first.created, first.replayed, seen]).toEqual([true, false, ['license_issue', 'loyalty_earn', 'notification']]);
    expect((await effectRows()).every((r) => r.status === 'done')).toBe(true);
    const again = await rec({ kind: 'order_paid_transition', operationId: orderId, mutations: [{ type: 'order_paid', orderId, placedAt: new Date() }], effects: [{ kind: 'license_issue' }] });
    expect([again.created, again.replayed, seen.length]).toEqual([false, true, 3]);
  });

  it('a transition from a non-payable state is refused (FSM)', async () => {
    const orderId = await newOrder('RB-3');
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE "order" SET state = 'Refunded' WHERE id = ${orderId}`));
    await expect(rec({ kind: 'order_paid_transition', operationId: orderId, mutations: [{ type: 'order_paid', orderId, placedAt: new Date() }] })).rejects.toThrow(/cannot transition/);
  });

  it('F44 order_purge: snapshot is written first, then payments and the order are deleted; evidence survives', async () => {
    const orderId = await newOrder('PU-1');
    await withStore(STORE, (tx) => tx.execute(sql`INSERT INTO payment (store_id, order_id, amount, method, state, provider_ref) VALUES (${STORE}, ${orderId}, 100, 'stripe', 'Settled', 'pi_purge')`));
    await rec({ kind: 'order_purge', operationId: orderId, mutations: [{ type: 'order_purge', orderId }] });
    expect(await withStore(STORE, (tx) => tx.select().from(s.order).where(eq(s.order.id, orderId)))).toEqual([]);
    expect(await withStore(STORE, (tx) => tx.select().from(s.payment))).toEqual([]);
    const [op] = await withStore(STORE, (tx) => tx.select().from(s.settlementOperation));
    expect(op!.snapshot).toMatchObject([{ method: 'stripe', provider_ref: 'pi_purge', amount: 100, state: 'Settled' }]);
  });

  it('F47 operator_resolution: apply / skip / replay / second entitlement-bearing resolution refused; resolved_by set', async () => {
    registerEffectHandler('license_extend', { async run() { return; } });
    // a held invoice: operation row with a terminal admin_review
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`INSERT INTO settlement_operation (store_id, operation_kind, operation_id, classification) VALUES (${STORE}, 'stripe_invoice_paid', 'in_held', 'unresolved')`);
      await enqueueEffects(tx, STORE, { kind: 'stripe_invoice_paid', id: 'in_held' }, [{ kind: 'admin_review', payload: { reason: 'held' } }]);
    });
    const resolve = (id: string, action: 'apply' | 'skip', effects: Array<{ kind: 'license_extend' }> = []) => rec({
      kind: 'operator_resolution', operationId: `stripe_invoice_paid:in_held:${id}`, classification: 'renewal',
      resolution: { targetKind: 'stripe_invoice_paid', targetId: 'in_held', action, actor: 'admin@x', reason: 'checked' }, effects,
    });
    await expect(rec({ kind: 'operator_resolution', operationId: 'x', classification: 'renewal', effects: [] })).rejects.toThrow(/requires/);
    const sk = await resolve('r0', 'skip');
    expect(sk.created).toBe(true);
    const ap = await resolve('r1', 'apply', [{ kind: 'license_extend' }]);
    expect(ap.created).toBe(true);
    const held = (await effectRows()).find((r) => r.effectKind === 'admin_review')!;
    expect(held.resolvedBy).toBe(ap.operationRowId);
    expect((await resolve('r1', 'apply', [{ kind: 'license_extend' }])).replayed).toBe(true);
    await expect(resolve('r2', 'apply', [{ kind: 'license_extend' }])).rejects.toThrow(/already exists/);
  });

  it('DR-7: two concurrent first observations of one provider ref resolve to one payment and one operation row', async () => {
    const orderId = await newOrder('CC-1');
    const one = () => withStore(STORE, (tx) => recordSettlementOperation(tx, {
      storeId: STORE, kind: 'payment_settled', operationId: 'ignored', effects: [],
      mutations: [{ type: 'payment_insert', rows: [{ storeId: STORE, orderId, amount: 100, method: 'stripe', providerRef: 'pi_race', state: 'Settled' }] }],
    }));
    const [a, b] = await Promise.all([one(), one()]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect((await withStore(STORE, (tx) => tx.select().from(s.payment))).length).toBe(1);
    expect((await withStore(STORE, (tx) => tx.select().from(s.settlementOperation))).length).toBe(1);
    expect(a.replayed || b.replayed).toBe(true);
  });

  it('R1: deleting a store (as the previous release does) is not blocked by rows in the new tables; purging an order is not either', async () => {
    const orderId = await newOrder('DEL-1');
    const [e] = await enqueueProbe('del-op');
    await withStore(STORE, async (tx) => {
      await tx.insert(s.appliedOperationReceipt).values({ effectId: e!.id, storeId: STORE, providerRef: 'r' });
      await tx.insert(s.subscriptionInvoicePayment).values({ storeId: STORE, orderId, stripeAccountId: 'a', mode: 'live', stripeSubscriptionId: 'sub', invoiceId: 'in', providerRef: 'pi', amount: 1, origin: 'live' });
      await tx.execute(sql`INSERT INTO settlement_operation (store_id, operation_kind, operation_id, order_id) VALUES (${STORE}, 'order_paid_transition', ${orderId}, ${orderId})`);
    });
    await rec({ kind: 'order_purge', operationId: 'purge-' + orderId, mutations: [{ type: 'order_purge', orderId }] }); // order referenced by operation/ledger rows
    expect(await withStore(STORE, (tx) => tx.select().from(s.order).where(eq(s.order.id, orderId)))).toEqual([]);
    await pool.query('DELETE FROM store WHERE id = $1', [STORE]);
    for (const table of ['settlement_operation', 'order_pending_effect', 'applied_operation_receipt', 'subscription_invoice_payment']) {
      const r = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE store_id = $1`, [STORE]);
      expect(r.rows[0].n, table).toBe(0);
    }
  });
});
