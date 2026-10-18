import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';

const mocks = vi.hoisted(() => ({
  locked: vi.fn(), evidence: vi.fn(), anchor: vi.fn(), refund: vi.fn(), fence: vi.fn(), bind: vi.fn(),
}));
vi.mock('../db/client.js', () => ({ withAdvisoryLock: (_key: string, action: () => unknown) => action() }));
vi.mock('../db/locks.js', () => ({ withLockedSet: mocks.locked }));
vi.mock('../orders/edit-stage.js', async importOriginal => ({ ...await importOriginal<typeof import('../orders/edit-stage.js')>(),
  assertNoPendingOrderEdit: mocks.fence }));
vi.mock('../orders/order-edit-service.js', () => ({ bindPreparedEditRefund: mocks.bind }));
vi.mock('../account-credit/service.js', () => ({ readCurrentCreditEvidence: mocks.evidence,
  anchorImportedCreditOrigin: mocks.anchor, restoreRefundAfterSettlement: vi.fn() }));
vi.mock('./provider.js', () => ({ getProvider: () => ({ refundPayment: mocks.refund }) }));
import { requestRefund } from './refunds.js';

beforeEach(() => vi.clearAllMocks());

describe('first imported money-only refund', () => {
  it.each([false, true])('freezes ordinary origin & preserves linked pending edit origin (linked=%s)', async linked => {
    const origin = { kind: 'vendure-retained-credit-v1', captureDigest: 'a'.repeat(64) };
    const editId = 'pending-edit';
    const order = { id: 'order', state: 'Paid', currency: 'USD', deletedAt: null, pricingSnapshot: null as unknown };
    const payment = { id: 'payment', orderId: order.id, state: 'Settled', amount: 1000, currency: 'USD',
      method: 'manual', providerRef: 'capture', gatewayMode: null, metadata: {} };
    const evidence = { importedOrigin: origin, pricingSources: linked ? [{ id: editId, orderId: order.id,
      before: { currentPricing: origin }, settlement: { phase: 'awaiting_refund' } }] : [], history: [] };
    const expectedSnapshot = linked ? null : origin;
    const attempts: Record<string, unknown>[] = [];
    const refunds: Record<string, unknown>[] = [];
    const refundLines: Record<string, unknown>[] = [];
    const writes: unknown[] = [];
    const rows = (table: unknown) => table === s.order ? [order] : table === s.payment ? [payment] :
      table === s.paymentAttempt ? attempts : table === s.refund ? refunds : table === s.refundLine ? refundLines :
      table === s.orderLine ? [{ id: 'line', orderId: order.id, quantity: 2, refundedQty: 0, metadata: { vendure: { placedQuantity: 3 } } }] :
      table === s.accountCreditTransaction ? [{ id: 'redemption', kind: 'REDEEM', status: 'POSTED' }] : [];
    const query = (read: () => unknown[]) => {
      const q = { where: () => q, for: () => q, limit: () => q, innerJoin: () => q,
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(read()).then(resolve) };
      return q;
    };
    const tx = {
      select: () => ({ from: (table: unknown) => query(() => rows(table)) }),
      insert: (table: unknown) => ({ values: async (value: Record<string, unknown>) => {
        expect(order.pricingSnapshot).toBe(expectedSnapshot);
        expect(mocks.anchor).toHaveBeenCalledTimes(linked ? 0 : 1);
        writes.push(table);
        if (table === s.paymentAttempt) attempts.push(value);
        if (table === s.refund) refunds.push(value);
        if (table === s.refundLine) refundLines.push(value);
        return [];
      } }),
      update: (table: unknown) => ({ set: (patch: Record<string, unknown>) => query(() => {
        if (table === s.refund) Object.assign(refunds[0]!, patch);
        if (table === s.paymentAttempt) Object.assign(attempts[0]!, patch);
        return [];
      }) }),
    } as unknown as Tx;
    mocks.locked.mockImplementation((_store: string, _plan: unknown, action: (tx: Tx) => unknown) => action(tx));
    mocks.evidence.mockResolvedValue(evidence);
    mocks.anchor.mockImplementation(async () => {
      expect(writes).toHaveLength(0);
      order.pricingSnapshot = origin;
      return { order, evidence };
    });
    mocks.bind.mockImplementation(async (_tx: Tx, input: { editId: string }) => {
      expect(input.editId).toBe(editId);
      expect(order.pricingSnapshot).toBeNull();
      expect(evidence.pricingSources[0]!.before.currentPricing).toBe(origin);
    });
    mocks.refund.mockImplementation(async () => {
      expect(order.pricingSnapshot).toBe(expectedSnapshot);
      expect(refunds).toHaveLength(1);
      expect(refundLines).toHaveLength(0);
      return { state: 'Pending', providerRef: 'refund-pending' };
    });

    await expect(requestRefund({ storeId: 'store', orderId: order.id, actor: 'operator',
      idempotencyKey: 'money-only-first', amount: 100, ...(linked ? { source: 'order_edit', editId } as const : {}) }))
      .resolves.toMatchObject({ refundState: 'Pending', pending: 100 });

    expect(mocks.fence).toHaveBeenCalledWith(tx, 'store', order.id, { allowEditId: linked ? editId : undefined });
    if (linked) {
      expect(mocks.anchor).not.toHaveBeenCalled();
      expect(mocks.bind).toHaveBeenCalledWith(tx, { storeId: 'store', orderId: order.id, editId, refundId: refunds[0]!.id });
      expect(order.pricingSnapshot).toBeNull();
      expect(evidence.pricingSources[0]!.before.currentPricing).toBe(origin);
    } else expect(mocks.anchor).toHaveBeenCalledWith(tx, { storeId: 'store', orderId: order.id });
    expect(mocks.refund).toHaveBeenCalledTimes(1);
    expect(mocks.refund).toHaveBeenCalledWith(expect.objectContaining({ amount: 100 }));
    expect(refunds[0]).toMatchObject({ amount: 100, itemsAmount: 0, adjustmentAmount: 100 });
    expect(refunds[0]!.metadata).not.toHaveProperty('creditUnitReturns');
    expect(refunds[0]!.metadata).not.toHaveProperty('stockEffects');
    expect(writes).not.toContain(s.refundLine);
  });
});
