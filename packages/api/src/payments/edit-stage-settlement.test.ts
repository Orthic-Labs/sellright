import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';

const mocks = vi.hoisted(() => ({
  activate: vi.fn(), record: vi.fn(), restore: vi.fn(), emit: vi.fn(),
}));
vi.mock('../db/locks.js', async original => ({
  ...await original<typeof import('../db/locks.js')>(),
  withLockedSetInTx: async (_tx: unknown, _store: string, _subject: unknown, run: () => Promise<unknown>) => run(),
}));
vi.mock('../orders/order-edit-service.js', () => ({ activatePreparedOrderEdit: mocks.activate }));
vi.mock('./settlement/record.js', () => ({
  recordSettlementOperation: mocks.record, editBalanceEffects: vi.fn(), paidOrderEffects: vi.fn(),
}));
vi.mock('../account-credit/service.js', () => ({ restoreRefundAfterSettlement: mocks.restore, readCurrentCreditEvidence: vi.fn() }));
vi.mock('../webhooks/emit.js', () => ({ emitEvent: mocks.emit }));

import { applyPaymentResult, retryPreparedEditSettlement } from './settle.js';
import { finalizeRefund } from './refunds.js';

/** Explicit read sequence keeps these tests about consumer ordering, not SQL. */
function fixture(reads: unknown[][]) {
  function query(rows: unknown[]) {
    const q = {
      from: () => q, where: () => q, limit: () => q, for: () => q,
      then: (resolve: (rows: unknown[]) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
    };
    return q;
  }
  const patches: Array<{ table: unknown; values: unknown }> = [];
  const update = vi.fn((table: unknown) => ({ set: (values: unknown) => {
    patches.push({ table, values }); return query([]);
  } }));
  const tx = {
    select: vi.fn(() => query(reads.shift() ?? [])), update,
    insert: vi.fn(() => ({ values: vi.fn(async () => []) })),
  } as unknown as Tx;
  return { tx, patches, reads };
}
const order = { id: 'order', code: 'STAGED', state: 'Paid', currency: 'USD', grandTotal: 1000, customerId: null };
const payment = { id: 'payment', orderId: order.id, amount: 250, state: 'Settled', currency: 'USD', gatewayAccount: null, gatewayMode: null };
const attempt = { id: 'attempt', orderId: order.id, operation: 'refund', method: 'stripe' };
const refund = { id: 'refund', orderId: order.id, paymentId: 'original-payment', state: 'Pending', providerRef: null,
  amount: 250, itemsAmount: 0, shippingAmount: 0, metadata: { source: 'order_edit', effectsApplied: false } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activate.mockResolvedValue(true);
  mocks.record.mockResolvedValue({ created: true, replayed: false, paymentId: payment.id });
});

describe('staged edit settlement consumers', () => {
  it('recovers only the stage-bound durable tender without money writes', async () => {
    const bound = { ...attempt, operation: 'intent', amount: 250, currency: 'USD', providerRef: 'pi_bound' };
    const { tx, reads, patches } = fixture([[{ id: 'edit', settlement: { phase: 'awaiting_tender', paymentAttemptId: bound.id } }],
      [bound], [{ ...payment, method: 'stripe', providerRef: 'pi_bound' }], [{ state: 'Paid' }]]);
    await expect(retryPreparedEditSettlement(tx, 'store', order.id, { paymentAttemptId: bound.id })).resolves.toMatchObject({ paymentId: payment.id, orderState: 'Paid' });
    expect(mocks.activate).toHaveBeenCalledWith(tx, { storeId: 'store', orderId: order.id, paymentAttemptId: bound.id, paymentId: payment.id });
    expect(patches).toEqual([]);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(reads).toHaveLength(0);
  });

  it('does not recover another stage from an unrelated historical attempt', async () => {
    const { tx, reads } = fixture([[{ id: 'edit', settlement: { phase: 'awaiting_tender', paymentAttemptId: 'bound' } }]]);
    await expect(retryPreparedEditSettlement(tx, 'store', order.id, { paymentAttemptId: 'old-attempt' })).resolves.toBeNull();
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(reads).toHaveLength(0);
  });

  it('records the captured tender with no ordinary effects before activation', async () => {
    const { tx, reads } = fixture([[order], [], [{ settlement: { phase: 'awaiting_tender' } }], [{ state: 'Paid' }]]);
    await expect(applyPaymentResult(tx, { storeId: 'store', order, method: 'stripe', amount: 250, paymentAttemptId: 'bound-attempt',
      result: { state: 'Settled', providerRef: 'pi_bound' } })).resolves.toEqual({ orderState: 'Paid', paymentState: 'Settled' });
    expect(mocks.record).toHaveBeenCalledOnce();
    expect(mocks.record.mock.calls[0]![1]).toMatchObject({ kind: 'payment_settled', effects: [], mutations: [{ type: 'payment_insert' }] });
    expect(mocks.activate).toHaveBeenCalledWith(tx, expect.objectContaining({ storeId: 'store', orderId: order.id, paymentAttemptId: 'bound-attempt' }));
    expect(mocks.record.mock.invocationCallOrder[0]).toBeLessThan(mocks.activate.mock.invocationCallOrder[0]!);
    expect(reads).toHaveLength(0);
  });

  it('replays activation for captured payment even when a delayed event says Pending', async () => {
    const { tx } = fixture([[order], [payment], [{ state: 'Paid' }]]);
    await expect(applyPaymentResult(tx, { storeId: 'store', order, method: 'stripe', amount: 250,
      result: { state: 'Pending', providerRef: 'pi_bound' } })).resolves.toEqual({ orderState: 'Paid', paymentState: 'Settled' });
    expect(mocks.activate).toHaveBeenCalledWith(tx, { storeId: 'store', orderId: order.id, paymentId: payment.id, paymentAttemptId: undefined });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('never activates an unsettled tender', async () => {
    const { tx } = fixture([[order], []]);
    await applyPaymentResult(tx, { storeId: 'store', order, method: 'stripe', amount: 250,
      result: { state: 'Pending', providerRef: 'pi_bound' } });
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.record.mock.calls[0]![1]).toMatchObject({ kind: 'payment_state_progress', effects: [] });
  });

  it('records a money-only refund then activates without ordinary merchandise effects', async () => {
    const settled = { ...refund, state: 'Settled' };
    const { tx, patches } = fixture([[attempt], [order], [attempt], [refund], [], [order], [], [settled], [order]]);
    await expect(finalizeRefund(tx, 'store', attempt.id, { state: 'Settled', providerRef: 're_bound' })).resolves.toMatchObject({ refundState: 'Settled', state: 'Paid', refunded: 250 });
    expect(mocks.activate).toHaveBeenCalledWith(tx, { storeId: 'store', orderId: order.id, refundId: refund.id });
    expect(patches).toEqual(expect.arrayContaining([{ table: s.refund, values: { state: 'Settled', providerRef: 're_bound' } }]));
    expect(patches.every(patch => patch.table === s.refund || patch.table === s.paymentAttempt)).toBe(true);
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('retries activation of settled edit refund without repeating money or quantity writes', async () => {
    const settled = { ...refund, state: 'Settled' };
    const { tx, patches } = fixture([[attempt], [order], [attempt], [settled], [], [settled], [order]]);
    await finalizeRefund(tx, 'store', attempt.id, { state: 'Pending', providerRef: null });
    expect(mocks.activate).toHaveBeenCalledWith(tx, { storeId: 'store', orderId: order.id, refundId: refund.id });
    expect(patches).toEqual([]);
    expect(mocks.restore).not.toHaveBeenCalled();
  });
});
