import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const st = { event: null as Record<string, unknown> | null, updates: [] as Array<Record<string, unknown>>, audits: [] as Array<Record<string, unknown>> };
  const chain = (kind: string, payload?: unknown): unknown => {
    const p: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') {
          if (kind === 'update') st.updates.push(payload as Record<string, unknown>);
          if (kind === 'insert') st.audits.push(payload as Record<string, unknown>);
          const v = kind === 'select' ? [st.event] : [];
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
  pool: { query: async () => ({ rows: [{ id: 'store' }] }) },
  withStore: async (_s: string, fn: (tx: unknown) => unknown) => fn(h.tx),
  withAdvisoryLock: async (_k: string, fn: () => unknown) => fn(),
}));
const verify = vi.fn();
vi.mock('../payments/gateway-payment.js', () => ({ verifySezzleAttempt: (...a: unknown[]) => verify(...a) }));
const resolve = vi.fn();
const refunds = vi.fn();
vi.mock('../payments/sezzle-reconcile.js', () => ({
  resolveSezzleSessionAttempt: (...a: unknown[]) => resolve(...a),
  reconcileSezzleRefunds: (...a: unknown[]) => refunds(...a),
}));
import { reconcileGatewayEvents } from './reconcile-gateway-events.js';

const event = (eventType: string) => ({ id: 'e', status: 'pending', attempts: 0, method: 'sezzle', accountId: 'a', mode: 'test', providerRef: 'ord', eventType });
beforeEach(() => { h.st.updates = []; h.st.audits = []; verify.mockReset(); resolve.mockReset(); refunds.mockReset(); });

describe('gateway-events worker', () => {
  it('D15: verifies an event associated through the reference_id fallback', async () => {
    h.st.event = event('order.captured');
    resolve.mockResolvedValue({ id: 'att', orderId: 'o' });
    verify.mockResolvedValue({ status: 'settled' });
    expect(await reconcileGatewayEvents()).toEqual({ processed: 1 });
    expect(resolve).toHaveBeenCalledWith({ storeId: 'store', accountId: 'a', mode: 'test', providerRef: 'ord' });
  });
  it('keeps an unassociated event pending', async () => {
    h.st.event = event('order.authorized');
    resolve.mockResolvedValue(null);
    await reconcileGatewayEvents();
    expect(h.st.updates[0]).toMatchObject({ status: 'pending', lastError: 'Payment association pending' });
  });
  it('D16: reconciles order.refunded into the refund ledger instead of parking manual', async () => {
    h.st.event = event('order.refunded');
    refunds.mockResolvedValue({ recorded: 1, finalized: 0, ambiguous: 0 });
    expect(await reconcileGatewayEvents()).toEqual({ processed: 1 });
    expect(resolve).not.toHaveBeenCalled();
  });
  it('D16: ambiguous refund reservations go to manual with an audit row', async () => {
    h.st.event = event('order.refunded');
    refunds.mockResolvedValue({ recorded: 0, finalized: 0, ambiguous: 1 });
    await reconcileGatewayEvents();
    expect(h.st.updates[0]).toMatchObject({ status: 'manual' });
    expect(h.st.audits[0]).toMatchObject({ action: 'reconciliation_required' });
  });
  it('refund whose payment is not recorded yet stays pending for retry', async () => {
    h.st.event = event('order.refunded');
    refunds.mockRejectedValue(new Error('Sezzle payment is not recorded yet'));
    await reconcileGatewayEvents();
    expect(h.st.updates[0]).toMatchObject({ status: 'pending' });
  });
});
