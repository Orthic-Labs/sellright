import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Chainable drizzle stand-in: any builder call returns itself; awaiting it
 *  yields the value produced by `resolve(kind)`. */
const h = vi.hoisted(() => {
  const state = {
    attempts: [] as Array<Record<string, unknown>>,
    updates: [] as Array<Record<string, unknown>>,
    audits: [] as Array<Record<string, unknown>>,
    locks: [] as string[],
    onLock: null as null | (() => void),
  };
  const chain = (kind: string, payload?: unknown): unknown => {
    const target: Record<string, unknown> = {};
    const proxy: unknown = new Proxy(target, {
      get(_t, prop) {
        if (prop === 'then') {
          const value = kind === 'select' ? state.attempts
            : kind === 'update' ? [{ id: 'x' }] : [];
          if (kind === 'update') state.updates.push(payload as Record<string, unknown>);
          if (kind === 'insert') state.audits.push(payload as Record<string, unknown>);
          return (res: (v: unknown) => void) => res(value);
        }
        if (kind === 'update' && prop === 'set') return (v: unknown) => chain('update', v);
        if (kind === 'insert' && prop === 'values') return (v: unknown) => chain('insert', v);
        return () => proxy;
      },
    });
    return proxy;
  };
  const tx = { select: () => chain('select'), update: () => chain('update'), insert: () => chain('insert') };
  return { state, tx };
});
vi.mock('../db/client.js', () => ({
  pool: { query: async () => ({ rows: [{ id: 'store' }] }) },
  withStore: async (_s: string, fn: (tx: unknown) => unknown) => fn(h.tx),
  withAdvisoryLock: async (k: string, fn: () => unknown) => { h.state.locks.push(k); h.state.onLock?.(); return fn(); },
}));
const verify = vi.fn();
const finish = vi.fn();
vi.mock('../payments/gateway-payment.js', () => ({
  verifyGatewayAttempt: (...a: unknown[]) => verify(...a),
  finishAttempt: (...a: unknown[]) => finish(...a),
}));
const orderCtx = { state: 'PendingPayment', due: 1000 };
vi.mock('../payments/settle.js', () => ({ amountDueForOrder: async () => orderCtx.due }));
vi.mock('../payments/gateway-account.js', () => ({ resolveGatewayAccount: async () => ({ method: 'sezzle', mode: 'test' }) }));

import { decideSezzleRecovery, recoverGatewayAttempts, recoveryBackoffMs, recoveryDue } from './gateway-recovery.js';

const now = new Date('2026-09-29T12:00:00Z');
const sezzleOrder = (over: Record<string, unknown> = {}) => ({
  uuid: 'ord', reference_id: 'att', order_amount: { amount_in_cents: 1000, currency: 'USD' },
  authorization: { approved: false }, ...over,
});
const base = { attemptReference: 'att', amount: 1000, currency: 'USD', payable: true, ageMs: 0, sessionExpiryMs: 3_600_000 };

describe('decideSezzleRecovery', () => {
  it('waits while an unapproved session is still inside its expiry window', () => {
    expect(decideSezzleRecovery({ ...base, order: sezzleOrder() as never })).toEqual({ kind: 'wait', reason: 'session_open' });
  });
  it('expires an unapproved session after the window (D7)', () => {
    expect(decideSezzleRecovery({ ...base, ageMs: 3_600_000, order: sezzleOrder() as never }).kind).toBe('expire');
  });
  it('captures an approved authorization while the order is payable (item 45 parity)', () => {
    expect(decideSezzleRecovery({ ...base, order: sezzleOrder({ authorization: { approved: true } }) as never }).kind).toBe('capture');
  });
  it('releases an approved authorization when the order is no longer payable (D22)', () => {
    expect(decideSezzleRecovery({ ...base, payable: false, order: sezzleOrder({ authorization: { approved: true } }) as never }))
      .toEqual({ kind: 'release', reason: 'order_not_payable' });
  });
  it('never acts on identity mismatch, captures, refunds or disputes', () => {
    expect(decideSezzleRecovery({ ...base, order: sezzleOrder({ reference_id: 'other' }) as never }).kind).toBe('wait');
    expect(decideSezzleRecovery({ ...base, ageMs: 9e9, order: sezzleOrder({ authorization: { approved: true, captures: [{}] } }) as never }).kind).toBe('wait');
    expect(decideSezzleRecovery({ ...base, ageMs: 9e9, order: sezzleOrder({ dispute: { id: 1 } }) as never }).kind).toBe('wait');
  });
});

describe('backoff', () => {
  it('doubles per try and caps at 6h', () => {
    expect(recoveryBackoffMs(1, 5)).toBe(300_000);
    expect(recoveryBackoffMs(3, 5)).toBe(1_200_000);
    expect(recoveryBackoffMs(50, 5)).toBe(6 * 3_600_000);
  });
  it('skips attempts not yet due or flagged manual', () => {
    expect(recoveryDue({ context: null }, now)).toBe(true);
    expect(recoveryDue({ context: { recovery: { tries: 1, nextAt: '2026-09-29T13:00:00Z' } } }, now)).toBe(false);
    expect(recoveryDue({ context: { recovery: { tries: 9, manual: true } } }, now)).toBe(false);
  });
});

describe('recoverGatewayAttempts', () => {
  const attempt = (over: Record<string, unknown>) => ({
    id: 'att', orderId: 'o', method: 'nmi', operation: 'charge', status: 'processing',
    accountId: 'a', mode: 'test', amount: 1000, currency: 'USD', providerRef: null, context: null,
    createdAt: new Date(now.getTime() - 2 * 3_600_000), ...over,
  });
  const opts = { apply: true, ageMin: 15, sezzleSessionExpiryMin: 60, maxAttempts: 3, backoffBaseMin: 5, now };
  beforeEach(() => {
    h.state.updates.length = 0; h.state.audits.length = 0;
    verify.mockReset(); finish.mockReset();
    h.state.locks.length = 0; h.state.onLock = null; orderCtx.due = 1000;
  });

  it('auto-verifies a stuck NMI attempt through verifyGatewayAttempt (D8)', async () => {
    h.state.attempts = [attempt({})];
    verify.mockResolvedValue({ status: 'settled' });
    expect(await recoverGatewayAttempts(opts)).toMatchObject({ checked: 1, resolved: 1 });
    expect(verify).toHaveBeenCalledWith('store', 'att');
    expect(h.state.updates).toHaveLength(0);
  });
  it('backs off an unresolved attempt, then flags manual + audit at max attempts', async () => {
    h.state.attempts = [attempt({ status: 'unknown', context: { recovery: { tries: 2 } } })];
    verify.mockResolvedValue({ status: 'unknown' });
    expect(await recoverGatewayAttempts(opts)).toMatchObject({ manual: 1 });
    expect(h.state.updates).toHaveLength(1);
    expect(h.state.audits[0]).toMatchObject({ action: 'reconciliation_required', entityId: 'att' });
  });
  it('dry-run never writes', async () => {
    h.state.attempts = [attempt({ status: 'unknown' })];
    verify.mockResolvedValue({ status: 'unknown' });
    await recoverGatewayAttempts({ ...opts, apply: false });
    expect(h.state.updates).toHaveLength(0);
    expect(h.state.audits).toHaveLength(0);
  });
  it('expires an abandoned Sezzle session as Declined so the order unblocks (D7)', async () => {
    h.state.attempts = [attempt({ method: 'sezzle', operation: 'session', status: 'pending', providerRef: 'ord' })];
    verify.mockResolvedValue({ status: 'pending' });
    finish.mockResolvedValue({ status: 'failed' });
    const sezzle = { getOrder: vi.fn().mockResolvedValue(sezzleOrder()), captureOrder: vi.fn(), releaseOrder: vi.fn() };
    // order lookup uses the same chain → returns attempts rows; give it an order-shaped row
    h.state.attempts = [{ ...h.state.attempts[0]!, code: 'C', state: 'PendingPayment', grandTotal: 1000 }];
    expect(await recoverGatewayAttempts({ ...opts, sezzle })).toMatchObject({ resolved: 1 });
    expect(finish).toHaveBeenCalledWith('store', 'att', expect.objectContaining({ state: 'Declined', providerRef: 'ord' }));
    expect(sezzle.releaseOrder).not.toHaveBeenCalled();
    expect(h.state.audits[0]).toMatchObject({ action: 'sezzle_session_expired' });
  });
  it('captures an approved Sezzle authorization and settles it under the order pay lock', async () => {
    h.state.attempts = [{ ...attempt({ method: 'sezzle', operation: 'session', status: 'pending', providerRef: 'ord' }), code: 'C', state: 'PendingPayment', grandTotal: 1000 }];
    verify.mockResolvedValueOnce({ status: 'pending' });
    finish.mockResolvedValue({ status: 'settled' });
    const sezzle = { getOrder: vi.fn().mockResolvedValue(sezzleOrder({ authorization: { approved: true } })), captureOrder: vi.fn(), releaseOrder: vi.fn() };
    expect(await recoverGatewayAttempts({ ...opts, sezzle })).toMatchObject({ resolved: 1 });
    expect(sezzle.captureOrder).toHaveBeenCalledWith(expect.anything(), 'ord', { amount_in_cents: 1000, currency: 'USD' }, 'att:capture');
    expect(h.state.locks).toEqual(['pay:store:C']);
    expect(finish).toHaveBeenCalledWith('store', 'att', expect.objectContaining({ state: 'Settled', providerRef: 'ord' }));
  });
  it('captures an approved Sezzle BALANCE authorization on a Paid order that still owes it (order edit)', async () => {
    h.state.attempts = [{ ...attempt({ method: 'sezzle', operation: 'session', status: 'pending', providerRef: 'ord' }), code: 'C', state: 'Paid', grandTotal: 2500 }];
    verify.mockResolvedValueOnce({ status: 'pending' });
    finish.mockResolvedValue({ status: 'settled' });
    const sezzle = { getOrder: vi.fn().mockResolvedValue(sezzleOrder({ authorization: { approved: true } })), captureOrder: vi.fn(), releaseOrder: vi.fn() };
    expect(await recoverGatewayAttempts({ ...opts, sezzle })).toMatchObject({ resolved: 1 });
    expect(sezzle.captureOrder).toHaveBeenCalledTimes(1);
    expect(sezzle.releaseOrder).not.toHaveBeenCalled();
  });
  it('releases instead of capturing when the order stopped being payable before the lock (e.g. Stripe settled it)', async () => {
    const row = { ...attempt({ method: 'sezzle', operation: 'session', status: 'pending', providerRef: 'ord' }), code: 'C', state: 'PendingPayment', grandTotal: 1000 };
    h.state.attempts = [row];
    verify.mockResolvedValue({ status: 'pending' });
    finish.mockResolvedValue({ status: 'failed' });
    h.state.onLock = () => { h.state.attempts = [{ ...row, state: 'Paid' }]; orderCtx.due = 0; };
    const sezzle = { getOrder: vi.fn().mockResolvedValue(sezzleOrder({ authorization: { approved: true } })), captureOrder: vi.fn(), releaseOrder: vi.fn() };
    await recoverGatewayAttempts({ ...opts, sezzle });
    expect(sezzle.captureOrder).not.toHaveBeenCalled();
    expect(sezzle.releaseOrder).toHaveBeenCalledWith(expect.anything(), 'ord', { amount_in_cents: 1000, currency: 'USD' }, 'att:release');
    expect(finish).toHaveBeenCalledWith('store', 'att', expect.objectContaining({ state: 'Declined', metadata: expect.objectContaining({ recovery: 'order_not_payable' }) }));
  });
  it('releases an approved Sezzle authorization on a non-payable order', async () => {
    h.state.attempts = [{ ...attempt({ method: 'sezzle', operation: 'session', status: 'pending', providerRef: 'ord' }), code: 'C', state: 'Cancelled', grandTotal: 1000 }];
    verify.mockResolvedValue({ status: 'pending' });
    finish.mockResolvedValue({ status: 'failed' });
    const sezzle = { getOrder: vi.fn().mockResolvedValue(sezzleOrder({ authorization: { approved: true } })), captureOrder: vi.fn(), releaseOrder: vi.fn() };
    await recoverGatewayAttempts({ ...opts, sezzle });
    expect(sezzle.releaseOrder).toHaveBeenCalledWith(expect.anything(), 'ord', { amount_in_cents: 1000, currency: 'USD' }, 'att:release');
    expect(sezzle.captureOrder).not.toHaveBeenCalled();
  });
});
