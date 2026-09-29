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
  return { st, tx: { select: () => chain('select'), insert: () => chain('insert'), update: () => chain('update') } };
});
vi.mock('../db/client.js', () => ({
  withStore: async (_s: string, fn: (tx: unknown) => unknown) => fn(h.tx),
  withAdvisoryLock: async (_k: string, fn: () => unknown) => fn(),
}));
vi.mock('./gateway-account.js', () => ({ resolveGatewayAccount: async () => ({ method: 'sezzle', mode: 'test' }) }));
const finalize = vi.fn();
const email = vi.fn();
vi.mock('./refunds.js', () => ({
  finalizeRefund: (...a: unknown[]) => finalize(...a),
  enqueueRefundSettledEmail: (...a: unknown[]) => email(...a),
  RefundError: class extends Error { constructor(public status: number, m: string) { super(m); } },
}));
vi.mock('../webhooks/emit.js', () => ({ emitEvent: vi.fn() }));
const stock = vi.fn();
vi.mock('../manifest/stock-hook.js', () => ({ onStockChanged: (...a: unknown[]) => stock(...a) }));

import { reconcileSezzleRefunds, resolveSezzleSessionAttempt } from './sezzle-reconcile.js';

const ev = { storeId: 'store', accountId: 'a', mode: 'test', providerRef: 'ord' };
const refundOrder = (refunds: unknown[]) => ({ getOrder: vi.fn().mockResolvedValue({ uuid: 'ord', reference_id: 'att', order_amount: { amount_in_cents: 1000, currency: 'USD' }, authorization: { approved: true, refunds } }) });
const pay = { id: 'pay', orderId: 'o', currency: 'USD' };
const money = (n: number) => ({ amount_in_cents: n, currency: 'USD' });

beforeEach(() => {
  h.st.selects = []; h.st.inserts = []; h.st.updates = []; h.st.insertReturn = [];
  finalize.mockReset(); email.mockReset(); stock.mockReset();
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

describe('D16 reconcileSezzleRefunds', () => {
  it('throws (retry) when the original payment is not recorded yet', async () => {
    h.st.selects = [[]];
    await expect(reconcileSezzleRefunds(ev, refundOrder([]))).rejects.toThrow(/not recorded/);
  });
  it('records a dashboard refund money-only, recomputes state and emails', async () => {
    const row = { id: 'r1', orderId: 'o', amount: 400 };
    h.st.selects = [[pay], [{ slug: 'dd' }], [], [], [{ state: 'Paid', grandTotal: 1000, code: 'C' }], [{ total: 400 }]];
    h.st.insertReturn = [[row]];
    const out = await reconcileSezzleRefunds(ev, refundOrder([{ uuid: 'ref1', amount: money(400) }]));
    expect(out).toEqual({ recorded: 1, finalized: 0, ambiguous: 0 });
    expect(h.st.inserts[0]).toMatchObject({ reason: 'sezzle_dashboard', state: 'Settled', providerRef: 'ref1', amount: 400 });
    expect(h.st.updates[0]).toMatchObject({ state: 'PartiallyRefunded' });
    expect(email).toHaveBeenCalledWith(h.tx, 'store', row);
  });
  it('finalizes a unique unbound pending reservation (effects once) and fires the stock hook after commit', async () => {
    h.st.selects = [[pay], [{ slug: 'dd' }], [], [{ attemptId: 'ra', amount: 400 }]];
    finalize.mockResolvedValue({ refundState: 'Settled' });
    const out = await reconcileSezzleRefunds(ev, refundOrder([{ uuid: 'ref1', amount: money(400) }]));
    expect(out.finalized).toBe(1);
    expect(finalize).toHaveBeenCalledWith(h.tx, 'store', 'ra', { state: 'Settled', providerRef: 'ref1' });
    expect(stock).toHaveBeenCalledWith('dd');
  });
  it('reports ambiguous reservations instead of guessing', async () => {
    h.st.selects = [[pay], [{ slug: 'dd' }], [], [{ attemptId: 'a1', amount: 400 }, { attemptId: 'a2', amount: 400 }]];
    const out = await reconcileSezzleRefunds(ev, refundOrder([{ uuid: 'ref1', amount: money(400) }]));
    expect(out.ambiguous).toBe(1);
    expect(finalize).not.toHaveBeenCalled();
    expect(h.st.inserts).toHaveLength(0);
  });
  it('is idempotent for an already-settled refund row', async () => {
    h.st.selects = [[pay], [{ slug: 'dd' }], [{ id: 'r', state: 'Settled' }]];
    expect(await reconcileSezzleRefunds(ev, refundOrder([{ uuid: 'ref1', amount: money(400) }]))).toEqual({ recorded: 0, finalized: 0, ambiguous: 0 });
  });
});
