/**
 * De-fork plan 2.9 — payment_attempt.provider_status / provider_observed_at for
 * the NMI and Sezzle retrieval paths. (Stripe is covered in
 * stripe-reconcile.db.test.ts.) Providers are mocked at the retrieval seam;
 * everything else is real. Runs against a *_test database only.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const nmi = { next: null as null | { result: Record<string, unknown>; observedStatus: string | null } };
vi.mock('./nmi-query.js', async (orig) => ({
  ...await orig<typeof import('./nmi-query.js')>(),
  queryNmiPaymentObserved: vi.fn(async () => nmi.next!),
}));
vi.mock('./gateway-account.js', async (orig) => ({
  ...await orig<typeof import('./gateway-account.js')>(),
  resolveGatewayAccount: async (_s: string, method: string) => ({ storeId: 'x', accountId: `${method}-acct`, method, mode: 'test', securityKey: 'k' }),
  assertGatewayEnvironment: () => undefined,
}));
vi.mock('../manifest/stock-hook.js', () => ({ onStockChanged: vi.fn() }));

import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { sezzleProvider } from './sezzle.js';
import { verifyGatewayAttempt } from './gateway-payment.js';
import { recoverGatewayAttempts } from '../jobs/gateway-recovery.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`provider-observation test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0';
let orderId: string;

beforeEach(async () => {
  await pool.query('TRUNCATE store CASCADE');
  nmi.next = null;
  vi.restoreAllMocks();
  orderId = await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, config) VALUES (${STORE}, 'obs-test', 'obs', '{}'::jsonb)`);
    const [o] = await tx.insert(s.order).values({ storeId: STORE, code: 'SROBS1', state: 'PendingPayment', currency: 'USD', grandTotal: 1000 }).returning({ id: s.order.id });
    return o!.id;
  });
});
afterAll(async () => { await pool.query('TRUNCATE store CASCADE'); await pool.end(); });

async function seedAttempt(method: 'nmi' | 'sezzle', over: Partial<typeof s.paymentAttempt.$inferInsert> = {}) {
  return withStore(STORE, async (tx) => {
    const key = `${method}-${Math.random().toString(16).slice(2)}`;
    const [a] = await tx.insert(s.paymentAttempt).values({
      storeId: STORE, orderId, operation: method === 'nmi' ? 'charge' : 'session', method, accountId: `${method}-acct`, mode: 'test',
      amount: 1000, currency: 'USD', idempotencyKey: key, fingerprint: key, status: 'unknown', providerRef: method === 'sezzle' ? 'sz-order' : 'nmi-tx',
      createdAt: new Date(Date.now() - 3 * 3_600_000),
      ...over,
    }).returning();
    return a!;
  });
}
const obs = async (id: string) => withStore(STORE, async (tx) => {
  const [a] = await tx.select().from(s.paymentAttempt).where(eq(s.paymentAttempt.id, id));
  return { status: a!.providerStatus, at: a!.providerObservedAt };
});

describe('NMI verify advances provider_status only on a successful retrieval', () => {
  it('success records the condition; an unavailable query leaves it untouched', async () => {
    const a = await seedAttempt('nmi');
    nmi.next = { result: { state: 'Pending', providerRef: 'nmi-tx', metadata: { needsReconciliation: true, reason: 'transaction_not_captured' } }, observedStatus: 'unresolved:transaction_not_captured' };
    await verifyGatewayAttempt(STORE, a.id);
    const first = await obs(a.id);
    expect(first.status).toBe('unresolved:transaction_not_captured');
    expect(first.at).toBeInstanceOf(Date);

    await new Promise((r) => setTimeout(r, 20));
    nmi.next = { result: { state: 'Pending', providerRef: 'nmi-tx', metadata: { needsReconciliation: true, reason: 'query_unavailable' } }, observedStatus: null };
    await verifyGatewayAttempt(STORE, a.id);
    const second = await obs(a.id);
    expect(second.status).toBe('unresolved:transaction_not_captured');
    expect(second.at!.getTime()).toBe(first.at!.getTime());
  });

  it('an attempt never observed stays NULL when the first query fails', async () => {
    const a = await seedAttempt('nmi');
    nmi.next = { result: { state: 'Pending', providerRef: 'nmi-tx', metadata: { needsReconciliation: true, reason: 'query_unavailable' } }, observedStatus: null };
    await verifyGatewayAttempt(STORE, a.id);
    expect(await obs(a.id)).toEqual({ status: null, at: null });
  });
});

describe('Sezzle verify and recovery', () => {
  it('verifySezzleAttempt records observedStatus when present and never stores it on the ledger', async () => {
    const a = await seedAttempt('sezzle', { status: 'pending' });
    const spy = vi.spyOn(sezzleProvider, 'createPayment');
    spy.mockResolvedValueOnce({ state: 'Pending', providerRef: 'sz-order', observedStatus: 'held' });
    await verifyGatewayAttempt(STORE, a.id);
    expect((await obs(a.id)).status).toBe('held');

    // provider unavailable (no observedStatus): previous observation stays
    const before = await obs(a.id);
    spy.mockResolvedValueOnce({ state: 'Pending', providerRef: 'sz-order', metadata: { needsReconciliation: true, reason: 'verification_unavailable' } });
    await verifyGatewayAttempt(STORE, a.id);
    expect(await obs(a.id)).toEqual(before);
  });

  it('gateway recovery records the retrieved order status, and a failed GET leaves it', async () => {
    const a = await seedAttempt('sezzle', { status: 'pending', context: { orderReference: 'ref-1' } });
    vi.spyOn(sezzleProvider, 'createPayment').mockResolvedValue({ state: 'Pending', providerRef: 'sz-order' });
    const base = { apply: false, ageMin: 0, sezzleSessionExpiryMin: 99999, maxAttempts: 5, backoffBaseMin: 1 };
    const order = { uuid: 'sz-order', reference_id: 'ref-1', order_amount: { amount_in_cents: 1000, currency: 'USD' }, checkout_status: 'created', authorization: { approved: false } };
    const ok = { getOrder: async () => order, captureOrder: async () => ({}), releaseOrder: async () => ({}) };
    await recoverGatewayAttempts({ ...base, sezzle: ok as never });
    const first = await obs(a.id);
    expect(first.status).toBe('open');

    await new Promise((r) => setTimeout(r, 20));
    const failing = { ...ok, getOrder: async () => { throw new Error('sezzle down'); } };
    await recoverGatewayAttempts({ ...base, sezzle: failing as never });
    expect(await obs(a.id)).toEqual(first);

    // identity mismatch is a retrieval of a DIFFERENT order: not recorded
    const other = { ...ok, getOrder: async () => ({ ...order, uuid: 'someone-else', checkout_status: 'approved' }) };
    await recoverGatewayAttempts({ ...base, sezzle: other as never });
    expect(await obs(a.id)).toEqual(first);
  });
});
