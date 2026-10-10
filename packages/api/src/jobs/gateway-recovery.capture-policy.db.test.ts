/**
 * Sezzle engine-issued capture under the payment policy (PAYMENT-TIMING §4.4, placement step 5), DB.
 * The capture decision runs in its own lock-set transaction (beforeCapture + persisted capture_decision);
 * the provider capture/release is a stub; the capture record (finishAttempt) must wait for a held order
 * row (mustCommit) rather than fail at the 5s lock timeout of an ordinary set.
 * Runs against a *_test DB only (TRUNCATEs store CASCADE).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import type { SezzleOps } from './gateway-recovery.js';
import type { PaymentPolicy } from '../payments/policy/types.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`gateway-recovery capture policy test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

vi.mock('../payments/gateway-account.js', async (original) => ({
  ...await original<typeof import('../payments/gateway-account.js')>(),
  resolveGatewayAccount: async (storeId: string, method: string) => ({
    storeId, accountId: 'sezzle-acct', method, mode: 'test', publicKey: 'pub', privateKey: 'priv',
  }),
}));
// The provider verify read is out of scope here: the Sezzle order GET is the stub's getOrder.
vi.mock('../payments/gateway-payment.js', async (original) => ({
  ...await original<typeof import('../payments/gateway-payment.js')>(),
  verifyGatewayAttempt: async () => ({ status: 'pending' }),
}));
vi.mock('../manifest/stock-hook.js', () => ({ onStockChanged: vi.fn() }));

const { recoverGatewayAttempts } = await import('./gateway-recovery.js');
const { _resetPaymentPoliciesForTests, registerPaymentPolicy, registeredPaymentPolicies } = await import('../payments/policy/host.js');
const { installDefaultPaymentPolicy } = await import('../payments/policy/default-policy.js');

const STORE = 'e3000000-0000-0000-0000-0000000f5001';
const SLUG = 'f5-capture-policy-test';
const CONFIG = { payments: { sezzle: true }, storefrontUrl: 'https://shop.example.test', sezzle: { mode: 'test' } };
const AMOUNT = 2500;

let calls: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function wipe() { await pool.query('TRUNCATE store CASCADE'); }

beforeEach(async () => {
  calls = [];
  _resetPaymentPoliciesForTests();
  installDefaultPaymentPolicy();
  await wipe();
  await withStore(STORE, (tx) => tx.insert(s.store).values({ id: STORE, slug: SLUG, name: 'F5', currency: 'USD', config: CONFIG }));
});
afterAll(async () => { _resetPaymentPoliciesForTests(); await wipe(); await pool.end(); });

/** A pending Sezzle session on a PendingPayment order, old enough for the recovery sweep. */
async function seedSezzleSession(code: string): Promise<{ orderId: string; attemptId: string; ref: string }> {
  const attemptId = randomUUID();
  const ref = randomUUID();
  const orderId = await withStore(STORE, async (tx) => {
    const [ord] = await tx.insert(s.order).values({
      storeId: STORE, code, state: 'PendingPayment', currency: 'USD', receiptToken: `rt_${code}_receipt_token_xxxxxxxx`,
      subtotal: AMOUNT, discountTotal: 0, shippingTotal: 0, taxTotal: 0, grandTotal: AMOUNT,
    }).returning({ id: s.order.id });
    await tx.insert(s.paymentAttempt).values({
      id: attemptId, storeId: STORE, orderId: ord!.id, operation: 'session', method: 'sezzle',
      accountId: 'sezzle-acct', mode: 'test', amount: AMOUNT, currency: 'USD', idempotencyKey: `k-${code}`,
      fingerprint: `fp-${code}`, status: 'pending', providerRef: ref, context: { orderReference: attemptId },
      createdAt: new Date(Date.now() - 2 * 3_600_000),
    });
    return ord!.id;
  });
  return { orderId, attemptId, ref };
}

function sezzleOps(ref: string, attemptId: string, extra: Partial<SezzleOps> = {}): SezzleOps {
  return {
    async getOrder() {
      return {
        uuid: ref, reference_id: attemptId, order_amount: { amount_in_cents: AMOUNT, currency: 'USD' },
        authorization: { approved: true, expiration: new Date(Date.now() + 3_600_000).toISOString() },
      } as never;
    },
    async captureOrder(_a, _r, _m, requestId) { calls.push(`capture:${requestId}`); return {}; },
    async releaseOrder(_a, _r, _m, requestId) { calls.push(`release:${requestId}`); return {}; },
    ...extra,
  };
}

const run = (sezzle: SezzleOps) => recoverGatewayAttempts({
  apply: true, ageMin: 1, sezzleSessionExpiryMin: 180, maxAttempts: 5, backoffBaseMin: 1, now: new Date(), sezzle,
});

const attemptOf = (attemptId: string) => withStore(STORE, async (tx) =>
  (await tx.select().from(s.paymentAttempt).where(eq(s.paymentAttempt.id, attemptId)).limit(1))[0]!);
const orderStateOf = (orderId: string) => withStore(STORE, async (tx) =>
  (await tx.select({ state: s.order.state }).from(s.order).where(eq(s.order.id, orderId)).limit(1))[0]!.state);

describe('Sezzle capture: beforeCapture', () => {
  it('a veto cancels the Sezzle authorisation instead of capturing, and records the decision and outcome', async () => {
    const { orderId, attemptId, ref } = await seedSezzleSession('F5VETO');
    const veto: PaymentPolicy = {
      id: 'f5-credit-veto',
      async beforePaymentAttempt() { return { allow: true }; },
      async beforeCapture() { return { action: 'cancel', reason: 'credit_revoked' }; },
    };
    registerPaymentPolicy(veto);

    const totals = await run(sezzleOps(ref, attemptId));

    expect(calls).toEqual([`release:${attemptId}:release`]);
    expect(totals.resolved).toBe(1);
    const a = await attemptOf(attemptId);
    expect(a.status).toBe('failed');
    expect((a.context as { capture_decision?: { action: string; reason: string } }).capture_decision)
      .toMatchObject({ action: 'cancel', reason: 'policy:credit_revoked' });
    expect(a.result).toMatchObject({ payment: 'Declined' });
    const audits = await withStore(STORE, (tx) => tx.select().from(s.auditLog).where(and(
      eq(s.auditLog.entityId, attemptId), eq(s.auditLog.action, 'sezzle_authorization_released'))));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.data).toMatchObject({ reason: 'policy:credit_revoked' });
    expect(await orderStateOf(orderId)).toBe('PendingPayment');
  });

  it('allow path is unchanged: the default policy captures once and the attempt settles', async () => {
    const { orderId, attemptId, ref } = await seedSezzleSession('F5ALLOW');

    const totals = await run(sezzleOps(ref, attemptId));

    expect(calls).toEqual([`capture:${attemptId}:capture`]);
    expect(totals.resolved).toBe(1);
    const a = await attemptOf(attemptId);
    expect(a.status).toBe('settled');
    expect((a.context as { capture_decision?: { action: string } }).capture_decision).toMatchObject({ action: 'capture' });
    expect(await orderStateOf(orderId)).toBe('Paid');
  });

  it('a policy hook failure issues neither capture nor release this tick and schedules a retry', async () => {
    const { orderId, attemptId, ref } = await seedSezzleSession('F5BOOM');
    registerPaymentPolicy({
      id: 'f5-broken',
      async beforePaymentAttempt() { return { allow: true }; },
      async beforeCapture() { throw new Error('plugin bug'); },
    });

    const totals = await run(sezzleOps(ref, attemptId));

    expect(calls).toEqual([]);
    expect(totals.resolved).toBe(0);
    const a = await attemptOf(attemptId);
    expect(a.status).toBe('pending');
    expect((a.context as { recovery?: { tries?: number; lastError?: string } }).recovery)
      .toMatchObject({ tries: 1, lastError: 'capture_deferred:policy_unavailable' });
    expect(await orderStateOf(orderId)).toBe('PendingPayment');
    expect(registeredPaymentPolicies().map((p) => p.id)).toContain('f5-broken');
  });

  it('the capture record waits for a held order row (mustCommit) instead of failing at the 5s set timeout', async () => {
    const { orderId, attemptId, ref } = await seedSezzleSession('F5HELD');
    let holderDone = false;
    let holderStarted: () => void = () => undefined;
    const started = new Promise<void>((r) => { holderStarted = r; });

    // The provider capture succeeds, then another transaction takes the order row and keeps it longer than
    // an ordinary lock set can wait (5s per attempt, 4 attempts = LockSetUnstable). The Sezzle capture
    // record must still commit (X-45 mustCommit).
    const sezzle = sezzleOps(ref, attemptId, {
      async captureOrder(_a, _r, _m, requestId) {
        calls.push(`capture:${requestId}`);
        void withStore(STORE, async (tx) => {
          await tx.select({ id: s.order.id }).from(s.order).where(eq(s.order.id, orderId)).for('update');
          holderStarted();
          await sleep(21_000);
        }).then(() => { holderDone = true; });
        await started;
        return {};
      },
    });

    const totals = await run(sezzle);

    expect(holderDone).toBe(true);
    expect(calls).toEqual([`capture:${attemptId}:capture`]);
    expect(totals.resolved).toBe(1);
    expect((await attemptOf(attemptId)).status).toBe('settled');
    expect(await orderStateOf(orderId)).toBe('Paid');
  }, 60_000);
});
