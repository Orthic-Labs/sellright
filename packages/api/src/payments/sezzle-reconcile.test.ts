import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Queue-driven drizzle stand-in: each awaited select pops the next result;
 *  inserts/updates are recorded (insert().returning() pops `inserted`). */
const h = vi.hoisted(() => {
  const st = { selects: [] as unknown[][], inserts: [] as Array<Record<string, unknown>>, updates: [] as Array<Record<string, unknown>>, insertReturn: [] as unknown[][] };
  const chain = (kind: string, payload?: unknown): unknown => {
    const p: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') {
          let v: unknown = [];
          if (kind === 'select') v = st.selects.shift() ?? [];
          if (kind === 'insert') { st.inserts.push(payload as Record<string, unknown>); v = st.insertReturn.shift() ?? []; }
          if (kind === 'update') st.updates.push(payload as Record<string, unknown>);
          return (res: (x: unknown) => void) => res(v);
        }
        if (prop === 'values' && kind === 'insert') return (v: unknown) => chain('insert', v);
        if (prop === 'set' && kind === 'update') return (v: unknown) => chain('update', v);
        return () => p;
      },
    });
    return p;
  };
  return { st, tx: { select: () => chain('select'), insert: () => chain('insert'), update: () => chain('update'), execute: () => chain('execute') } };
});
vi.mock('../db/client.js', () => ({
  withStore: async (_s: string, fn: (tx: unknown) => unknown) => fn(h.tx),
  withAdvisoryLock: async (_k: string, fn: () => unknown) => fn(),
}));
const account = vi.fn();
vi.mock('./gateway-account.js', () => ({ resolveGatewayAccount: (...a: unknown[]) => account(...a) }));
const finalize = vi.fn();
const email = vi.fn();
vi.mock('./refunds.js', () => ({
  finalizeRefund: (...a: unknown[]) => finalize(...a),
  enqueueRefundSettledEmail: (...a: unknown[]) => email(...a),
  orderRefundBasis: async () => ({ captured: 1000, refunded: 400, editRefunded: 0 }),
  refundStateFromBasis: (b: { captured: number; refunded: number }) => (b.refunded <= 0 ? null : b.refunded >= b.captured ? 'Refunded' : 'PartiallyRefunded'),
  RefundError: class extends Error { constructor(public status: number, m: string) { super(m); } },
}));
vi.mock('../webhooks/emit.js', () => ({ emitEvent: vi.fn() }));
const stock = vi.fn();
vi.mock('../manifest/stock-hook.js', () => ({ onStockChanged: (...a: unknown[]) => stock(...a) }));

import { observeImportedSezzlePayment, reconcileSezzleRefunds, resolveSezzleSessionAttempt } from './sezzle-reconcile.js';
import { migrationId } from '../import/context.js';

const ev = { storeId: 'store', accountId: 'a', mode: 'test', providerRef: 'ord' };
const refundOrder = (refunds: unknown[]) => ({ getOrder: vi.fn().mockResolvedValue({ uuid: 'ord', reference_id: 'att', order_amount: { amount_in_cents: 1000, currency: 'USD' }, authorization: { approved: true, refunds } }) });
const pay = { id: 'pay', orderId: 'o', currency: 'USD' };
const money = (n: number) => ({ amount_in_cents: n, currency: 'USD' });

beforeEach(() => {
  h.st.selects = []; h.st.inserts = []; h.st.updates = []; h.st.insertReturn = [];
  finalize.mockReset(); email.mockReset(); stock.mockReset();
  account.mockReset().mockImplementation(async (storeId: string, method: string, accountId: string, mode: string) =>
    ({ storeId, method, accountId, mode }));
});

describe('D15 resolveSezzleSessionAttempt', () => {
  it('returns the exact providerRef match without a provider call', async () => {
    h.st.selects = [[{ id: 'att', providerRef: 'ord' }]];
    const provider = refundOrder([]);
    expect(await resolveSezzleSessionAttempt(ev, provider)).toMatchObject({ id: 'att' });
    expect(provider.getOrder).not.toHaveBeenCalled();
  });
  it('falls back to the provider reference_id and binds the lost ref with an audit row', async () => {
    h.st.selects = [[], [{ id: '11111111-1111-4111-8111-111111111111', providerRef: null }]];
    const provider = { getOrder: vi.fn().mockResolvedValue({ uuid: 'ord', reference_id: '11111111-1111-4111-8111-111111111111' }) };
    const a = await resolveSezzleSessionAttempt(ev, provider);
    expect(a?.providerRef).toBe('ord');
    expect(h.st.updates[0]).toMatchObject({ providerRef: 'ord' });
    expect(h.st.inserts[0]).toMatchObject({ action: 'bind_provider_reference', data: { source: 'sezzle_reference_id' } });
  });
  it('refuses to rebind an attempt that already carries another ref', async () => {
    h.st.selects = [[], [{ id: 'x', providerRef: 'other' }]];
    const provider = { getOrder: vi.fn().mockResolvedValue({ uuid: 'ord', reference_id: 'x' }) };
    await expect(resolveSezzleSessionAttempt(ev, provider)).rejects.toThrow(/another order/);
  });
  it('returns null (keep pending) when the provider order identity does not match', async () => {
    h.st.selects = [[]];
    const provider = { getOrder: vi.fn().mockResolvedValue({ uuid: 'different', reference_id: 'x' }) };
    expect(await resolveSezzleSessionAttempt(ev, provider)).toBeNull();
  });
});

describe('imported Sezzle history observations', () => {
  const orderId = migrationId('store', 'vendure:damned', 'order', 12);
  const importedPayment = () => ({
    id: migrationId('store', 'vendure:damned', 'payment', 42), orderId, storeId: 'store',
    method: 'sezzle', gatewayAccount: 'a', gatewayMode: 'test', providerRef: 'ord',
    amount: 1000, currency: 'USD', state: 'Settled',
    metadata: { vendure: { vendureMethod: 'sezzle-payment', sourceMode: 'test', sourcePaymentId: 42, sourceKey: 'vendure:damned' } },
  });
  const importedOrder = () => ({
    id: orderId, storeId: 'store', code: 'DD-12', currency: 'USD', state: 'Paid',
    metadata: { vendure: { id: 12, sourceKey: 'vendure:damned', state: 'PaymentSettled' } },
  });
  const providerOrder = () => ({ uuid: 'ord', reference_id: 'DD-12', order_amount: money(1000) });
  const assertObservationOnly = () => {
    expect(h.st.inserts).toEqual([]);
    expect(h.st.updates).toEqual([]);
    expect(finalize).not.toHaveBeenCalled();
    expect(email).not.toHaveBeenCalled();
    expect(stock).not.toHaveBeenCalled();
  };

  it.each(['Paid', 'PartiallyRefunded', 'Refunded', 'Cancelled'])('observes repeated historical events on %s without ledger/email/stock effects', async state => {
    const payment = importedPayment();
    const original = { ...importedOrder(), state };
    const provider = { getOrder: vi.fn().mockResolvedValue({ ...providerOrder(),
      authorization: { approved: true, refunds: [{ uuid: 'refund', amount: money(1000) }] },
    }) };
    h.st.selects = [[payment], [original], [payment], [original]];
    expect(await observeImportedSezzlePayment(ev, provider)).toEqual(payment);
    expect(await observeImportedSezzlePayment(ev, provider)).toEqual(payment);
    expect(account).toHaveBeenCalledWith('store', 'sezzle', 'a', 'test');
    expect(provider.getOrder).toHaveBeenCalledTimes(2);
    assertObservationOnly();
  });

  it.each([
    ['wrong store', { storeId: 'other' }], ['wrong account', { gatewayAccount: 'other' }],
    ['wrong mode', { gatewayMode: 'live' }], ['missing account', { gatewayAccount: null }],
    ['missing mode', { gatewayMode: null }], ['wrong method', { method: 'stripe' }],
    ['wrong reference', { providerRef: 'other' }], ['unsettled history', { state: 'Authorized' }],
    ['missing provenance', { metadata: null }],
    ['conflicting mode evidence', { metadata: { vendure: { vendureMethod: 'sezzle', sourcePaymentId: 42, sourceKey: 'vendure:damned', txnMode: 'live' } } }],
    ['quarantined mode', { metadata: { vendure: { vendureMethod: 'sezzle', sourcePaymentId: 42, sourceKey: 'vendure:damned', modeQuarantined: 'conflict' } } }],
    ['old history without canonical proof', { metadata: { vendure: { vendureMethod: 'sezzle-payment', sourceMode: 'test' } } }],
    ['missing source payment ID', { metadata: { vendure: { vendureMethod: 'sezzle', sourceKey: 'vendure:damned' } } }],
    ['missing source namespace', { metadata: { vendure: { vendureMethod: 'sezzle', sourcePaymentId: 42 } } }],
    ['wrong source payment ID', { metadata: { vendure: { vendureMethod: 'sezzle', sourcePaymentId: 99, sourceKey: 'vendure:damned' } } }],
    ['arbitrary UUIDv5 with otherwise matching history', { id: '11111111-1111-5111-8111-111111111111' }],
    ['another store payment namespace', { id: migrationId('other', 'vendure:damned', 'payment', 42) }],
    ['another entity namespace', { id: migrationId('store', 'vendure:damned', 'order', 42) }],
    ['ordinary payment ID', { id: '11111111-1111-4111-8111-111111111111' }],
  ])('refuses %s before provider access', async (_name, change) => {
    h.st.selects = [[{ ...importedPayment(), ...change }]];
    const provider = { getOrder: vi.fn().mockResolvedValue(providerOrder()) };
    expect(await observeImportedSezzlePayment(ev, provider)).toBeNull();
    expect(provider.getOrder).not.toHaveBeenCalled();
    assertObservationOnly();
  });

  it('refuses otherwise valid payment proof from a different imported source namespace', async () => {
    const payment = importedPayment();
    payment.id = migrationId('store', 'vendure:other', 'payment', 42);
    payment.metadata.vendure.sourceKey = 'vendure:other';
    h.st.selects = [[payment], [importedOrder()]];
    const provider = { getOrder: vi.fn().mockResolvedValue(providerOrder()) };
    expect(await observeImportedSezzlePayment(ev, provider)).toBeNull();
    expect(provider.getOrder).not.toHaveBeenCalled();
    assertObservationOnly();
  });

  it.each([
    ['missing order proof', { metadata: null }], ['wrong order store', { storeId: 'other' }],
    ['wrong order association', { id: 'other' }], ['different currency', { currency: 'CAD' }],
    ['mismatched migration source', { metadata: { vendure: { id: 99, sourceKey: 'vendure:damned' } } }],
  ])('refuses %s', async (_name, change) => {
    h.st.selects = [[importedPayment()], [{ ...importedOrder(), ...change }]];
    const provider = { getOrder: vi.fn().mockResolvedValue(providerOrder()) };
    expect(await observeImportedSezzlePayment(ev, provider)).toBeNull();
    expect(provider.getOrder).not.toHaveBeenCalled();
    assertObservationOnly();
  });

  it.each([
    ['uuid', { uuid: 'other' }], ['reference_id', { reference_id: 'another-order' }],
    ['amount', { order_amount: money(999) }],
    ['currency', { order_amount: { amount_in_cents: 1000, currency: 'CAD' } }],
  ])('keeps mismatched authoritative %s unresolved', async (_name, change) => {
    h.st.selects = [[importedPayment()], [importedOrder()]];
    const provider = { getOrder: vi.fn().mockResolvedValue({ ...providerOrder(), ...change }) };
    expect(await observeImportedSezzlePayment(ev, provider)).toBeNull();
    assertObservationOnly();
  });

  it.each(['storeId', 'accountId', 'method', 'mode'])('refuses mismatched configured %s', async field => {
    h.st.selects = [[importedPayment()], [importedOrder()]];
    account.mockResolvedValue({ storeId: 'store', accountId: 'a', method: 'sezzle', mode: 'test', [field]: 'other' });
    const provider = { getOrder: vi.fn() };
    expect(await observeImportedSezzlePayment(ev, provider)).toBeNull();
    expect(provider.getOrder).not.toHaveBeenCalled();
    assertObservationOnly();
  });

  it('refuses missing, duplicate or ambiguous payment/order associations', async () => {
    const provider = { getOrder: vi.fn() };
    for (const rows of [[], [importedPayment(), importedPayment()]]) {
      h.st.selects = [rows];
      expect(await observeImportedSezzlePayment(ev, provider)).toBeNull();
    }
    for (const rows of [[], [importedOrder(), importedOrder()]]) {
      h.st.selects = [[importedPayment()], rows];
      expect(await observeImportedSezzlePayment(ev, provider)).toBeNull();
    }
    expect(provider.getOrder).not.toHaveBeenCalled();
    assertObservationOnly();
  });
});

describe('D16 reconcileSezzleRefunds', () => {
  it('throws (retry) when the original payment is not recorded yet', async () => {
    h.st.selects = [[]];
    await expect(reconcileSezzleRefunds(ev, refundOrder([]))).rejects.toThrow(/not recorded/);
  });
  it('records a dashboard refund money-only, recomputes state and emails', async () => {
    const row = { id: 'r1', orderId: 'o', amount: 400 };
    h.st.selects = [[pay], [], [], [], [], [{ slug: 'dd' }], [], [], [{ state: 'Paid', grandTotal: 1000, code: 'C' }]];
    h.st.insertReturn = [[row]];
    const out = await reconcileSezzleRefunds(ev, refundOrder([{ uuid: 'ref1', amount: money(400) }]));
    expect(out).toEqual({ recorded: 1, finalized: 0, ambiguous: 0 });
    expect(h.st.inserts[0]).toMatchObject({ reason: 'sezzle_dashboard', state: 'Settled', providerRef: 'ref1', amount: 400 });
    expect(h.st.updates[0]).toMatchObject({ state: 'PartiallyRefunded' });
    expect(email).toHaveBeenCalledWith(h.tx, 'store', row);
  });
  it('finalizes a unique unbound pending reservation (effects once) and fires the stock hook after commit', async () => {
    h.st.selects = [[pay], [], [], [], [], [{ slug: 'dd' }], [], [{ attemptId: 'ra', amount: 400 }]];
    finalize.mockResolvedValue({ refundState: 'Settled' });
    const out = await reconcileSezzleRefunds(ev, refundOrder([{ uuid: 'ref1', amount: money(400) }]));
    expect(out.finalized).toBe(1);
    expect(finalize).toHaveBeenCalledWith(h.tx, 'store', 'ra', { state: 'Settled', providerRef: 'ref1' });
    expect(stock).toHaveBeenCalledWith('dd');
  });
  it('reports ambiguous reservations instead of guessing', async () => {
    h.st.selects = [[pay], [], [], [], [], [{ slug: 'dd' }], [], [{ attemptId: 'a1', amount: 400 }, { attemptId: 'a2', amount: 400 }]];
    const out = await reconcileSezzleRefunds(ev, refundOrder([{ uuid: 'ref1', amount: money(400) }]));
    expect(out.ambiguous).toBe(1);
    expect(finalize).not.toHaveBeenCalled();
    expect(h.st.inserts).toHaveLength(0);
  });
  it('is idempotent for an already-settled refund row', async () => {
    h.st.selects = [[pay], [], [], [], [], [{ slug: 'dd' }], [{ id: 'r', state: 'Settled' }]];
    expect(await reconcileSezzleRefunds(ev, refundOrder([{ uuid: 'ref1', amount: money(400) }]))).toEqual({ recorded: 0, finalized: 0, ambiguous: 0 });
  });
});
