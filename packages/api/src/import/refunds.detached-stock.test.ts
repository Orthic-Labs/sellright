import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema.js';
import { creditReturnSnapshotDigest, originalCreditUnitId } from '../account-credit/edit-funding.js';

const mocks = vi.hoisted(() => ({ restore: vi.fn(), provider: vi.fn() }));
vi.mock('../account-credit/service.js', () => ({ restoreRefundAfterSettlement: mocks.restore,
  readCurrentCreditEvidence: vi.fn(), anchorImportedCreditOrigin: vi.fn() }));
vi.mock('../payments/provider.js', () => ({ getProvider: mocks.provider }));
vi.mock('../loyalty/ledger.js', () => ({ reconcileRefundLoyalty: vi.fn() }));
vi.mock('../webhooks/emit.js', () => ({ emitEvent: vi.fn() }));
import { finalizeRefund } from '../payments/refunds.js';

const lineId = '11111111-1111-4111-8111-111111111111';
const redemptionId = '22222222-2222-4222-8222-222222222222';
const unitId = originalCreditUnitId(redemptionId, lineId, 2);
function receipt(present: boolean) {
  const base = { version: 2, redemptionId, snapshotHash: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64),
    lines: [{ orderLineId: lineId, positions: [2], originalIndexes: [2], creditCents: [33], unitIds: [unitId],
      presentUnitIds: present ? [unitId] : [], unitEconomics: [{ net: 0, gross: 0, cashRefundGross: 66 }] }] };
  return { ...base, requestDigest: creditReturnSnapshotDigest(base) };
}
function fixture(present = false) {
  const frozen = receipt(present);
  const order = { id: 'order', code: 'IMPORTED', state: 'Paid', currency: 'USD', pricingSnapshot: { kind: 'vendure-retained-credit-v1' } };
  const attempt = { id: 'attempt', orderId: order.id, operation: 'refund', method: 'manual', fingerprint: 'c'.repeat(64) };
  const refund = { id: 'refund', orderId: order.id, paymentId: 'payment', amount: 66, state: 'Pending', providerRef: null as string | null,
    metadata: { actor: 'operator', effectsApplied: false, creditUnitReturns: frozen,
      stockEffects: { state: 'pending', requestDigest: frozen.requestDigest } } as Record<string, unknown> };
  const lines = [{ id: 'refund-line', refundId: refund.id, orderLineId: lineId, quantity: 1, amount: 66, restock: true }];
  const line = { id: lineId, orderId: order.id, quantity: 2, fulfilledQty: 2, cancelledQty: 0, variantId: 'variant' };
  const payment = { id: 'payment', orderId: order.id, amount: 1000, metadata: {} };
  const patches: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const inserts: unknown[] = [];
  let failLine = false;
  const rows = (table: unknown) => table === s.order ? [order] : table === s.refund ? [refund] : table === s.paymentAttempt ? [attempt] :
    table === s.refundLine ? lines : table === s.orderLine ? [line] : table === s.payment ? [payment] : [];
  const query = (getRows: () => unknown[]) => {
    const q = { where: () => q, for: () => q, limit: () => q,
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(getRows()).then(resolve) };
    return q;
  };
  const tx = {
    select: () => ({ from: (table: unknown) => query(() => rows(table)) }),
    update: (table: unknown) => ({ set: (values: Record<string, unknown>) => query(() => {
      if (table === s.orderLine && failLine) { failLine = false; throw new Error('synthetic stock failure'); }
      patches.push({ table, values });
      if (table === s.refund) Object.assign(refund, values);
      if (table === s.order) Object.assign(order, values);
      return [];
    }) }),
    insert: (table: unknown) => ({ values: async () => { inserts.push(table); return []; } }),
    execute: vi.fn(async () => ({ rows: [] })),
  } as unknown as Tx;
  return { tx, refund, frozen, patches, inserts, failStockOnce: () => { failLine = true; } };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.restore.mockResolvedValue({ ok: true, value: [] });
  mocks.provider.mockImplementation(() => { throw new Error('Provider I/O forbidden on settled recovery'); });
});

describe('frozen imported refund stock custody', () => {
  it('increments detached refund quantity without releasing or restocking current merchandise', async () => {
    const f = fixture();
    await expect(finalizeRefund(f.tx, 'store', 'attempt', { state: 'Settled', providerRef: 'ref' }))
      .resolves.toMatchObject({ refundState: 'Settled', stockEffects: { state: 'applied' } });
    expect(f.patches.filter(patch => patch.table === s.orderLine)).toHaveLength(1);
    expect(f.patches.filter(patch => patch.table === s.stock)).toHaveLength(0);
    expect(f.inserts).not.toContain(s.stockMovement);
    f.patches.length = 0;
    await finalizeRefund(f.tx, 'store', 'attempt', { state: 'Pending', providerRef: null });
    expect(f.patches.some(patch => patch.table === s.orderLine || patch.table === s.stock)).toBe(false);
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it('keeps settled cash through a stock failure & retries only deferred effects once', async () => {
    const f = fixture(true);
    f.failStockOnce();
    await expect(finalizeRefund(f.tx, 'store', 'attempt', { state: 'Settled', providerRef: 'ref' }))
      .resolves.toMatchObject({ refundState: 'Settled', stockEffects: { state: 'pending' } });
    expect(f.refund.state).toBe('Settled');
    expect(f.patches.some(patch => patch.table === s.stock)).toBe(false);
    const auditCount = f.inserts.filter(table => table === s.auditLog).length;
    await finalizeRefund(f.tx, 'store', 'attempt', { state: 'Pending', providerRef: null });
    await finalizeRefund(f.tx, 'store', 'attempt', { state: 'Settled', providerRef: 'ref' });
    expect(f.patches.filter(patch => patch.table === s.orderLine)).toHaveLength(1);
    expect(f.patches.filter(patch => patch.table === s.stock)).toHaveLength(1);
    expect(f.inserts.filter(table => table === s.stockMovement)).toHaveLength(1);
    expect(f.inserts.filter(table => table === s.auditLog)).toHaveLength(auditCount);
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it('defers malformed frozen presence & recovers original immutable receipt on replay', async () => {
    const f = fixture();
    f.refund.metadata.creditUnitReturns = { ...f.frozen, requestDigest: '0'.repeat(64) };
    await expect(finalizeRefund(f.tx, 'store', 'attempt', { state: 'Settled', providerRef: 'ref' }))
      .resolves.toMatchObject({ refundState: 'Settled', stockEffects: { state: 'pending' } });
    expect(f.patches.some(patch => patch.table === s.orderLine || patch.table === s.stock)).toBe(false);
    f.refund.metadata.creditUnitReturns = f.frozen;
    await finalizeRefund(f.tx, 'store', 'attempt', { state: 'Settled', providerRef: 'ref' });
    expect(f.patches.filter(patch => patch.table === s.orderLine)).toHaveLength(1);
    expect(f.refund.metadata.stockEffects).toMatchObject({ state: 'applied', requestDigest: f.frozen.requestDigest });
    expect(mocks.provider).not.toHaveBeenCalled();
  });
});
