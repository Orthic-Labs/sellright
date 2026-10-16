// edit_reconcile gates NEW licence issuance through revalidateForIssuance (PAYMENT-TIMING §4.3); pure, no database.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tx } from '../../db/client.js';
import type { EffectRow } from './effects.js';

const HELD = {} as never;
vi.mock('../../db/locks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/locks.js')>()),
  withLockedSetInTx: async (tx: Tx, _store: string, _subject: unknown, fn: (tx: Tx, held: unknown, plan: unknown) => unknown) => fn(tx, HELD, {}),
}));
const revalidate = vi.fn();
vi.mock('../policy/host.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../policy/host.js')>()),
  runRevalidateForIssuance: (...a: unknown[]) => revalidate(...a),
}));
type Gate = () => Promise<{ ok: false } | { ok: true; metadataPatch?: Record<string, unknown> }>;
const reconcile = vi.fn();
// The funding check before issuance reads the order's balance from the database; this file exercises the policy gate
// with a fake transaction, so the order is fully funded here. The unpaid-line case is covered against a real database
// in orders/order-edit.db.test.ts.
vi.mock('../settle.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../settle.js')>()), amountDueForOrder: vi.fn(async () => 0) }));
vi.mock('../../licensing/edit-reconcile.js', () => ({
  reconcileEditedOrderLicenses: (...a: unknown[]) => reconcile(...a),
}));

import { PaymentPolicyUnavailableError } from '../policy/registry.js';
import { editReconcile } from './handlers.js';

const ORDER = { id: 'o1', storeId: 's1', code: 'C1', state: 'Paid', currency: 'USD', grandTotal: 100, customerId: null, metadata: {} };
const effect = { id: 'eff-1', storeId: 's1', operationId: 'op-1', effectKind: 'edit_reconcile', payload: { orderId: 'o1', customerId: null, paidAt: '2026-01-01T00:00:00.000Z' } } as unknown as EffectRow;

let audits: Record<string, unknown>[];
/** Selects in handler order: lifecycle state, order row, the order row for the funding check, the order row for the policy gate, reservations. */
function fakeTx() {
  const queue: unknown[][] = [[{ state: 'Paid' }], [ORDER], [ORDER], []];
  const chain = (): unknown => {
    const rows = queue.shift() ?? [];
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit']) c[m] = () => c;
    c.then = (resolve: (v: unknown) => unknown) => resolve(rows);
    return c;
  };
  return { select: chain, insert: () => ({ values: async (v: Record<string, unknown>) => { audits.push(v); } }) } as unknown as Tx;
}

/** The real reconcile asks the gate only when it is about to insert new rows; model that, and record the verdict. */
let verdict: Awaited<ReturnType<Gate>> | undefined;
beforeEach(() => {
  audits = [];
  verdict = undefined;
  revalidate.mockReset();
  reconcile.mockReset();
  reconcile.mockImplementation(async (_tx: Tx, o: { gate: Gate }) => {
    verdict = await o.gate();
    return { issued: verdict.ok ? 1 : 0, revoked: 2 };
  });
});

describe('edit_reconcile issuance gate', () => {
  it('no policy registered (ok, no patch): proceeds, no patch, result identical to before', async () => {
    revalidate.mockResolvedValue({ ok: true });
    const out = await editReconcile.run(fakeTx(), effect);
    expect(out).toEqual({ done: { result: { issued: 1, revoked: 2 } } });
    expect(verdict).toEqual({ ok: true, metadataPatch: undefined });
    expect(audits).toEqual([]);
  });

  it('policy refuses: the new licence is not issued, audit row + terminal code exactly as license_issue', async () => {
    revalidate.mockResolvedValue({ ok: false, code: 'CREDIT_GONE', audit: { action: 'upgrade_credit_invalid', data: { why: 'source revoked' } } });
    const out = await editReconcile.run(fakeTx(), effect);
    expect(out).toEqual({ terminal: 'CREDIT_GONE' });
    expect(verdict).toEqual({ ok: false });
    expect(audits).toEqual([{ storeId: 's1', actor: 'system:policy', entity: 'order', entityId: 'o1', action: 'upgrade_credit_invalid', data: { why: 'source revoked' } }]);
  });

  it('policy refuses without an audit payload: terminal, no audit row', async () => {
    revalidate.mockResolvedValue({ ok: false, code: 'NOPE' });
    expect(await editReconcile.run(fakeTx(), effect)).toEqual({ terminal: 'NOPE' });
    expect(audits).toEqual([]);
  });

  it('policy returns a metadataPatch: it is handed to the issuance of the new rows', async () => {
    revalidate.mockResolvedValue({ ok: true, metadataPatch: { mobile_upgrade_source_id: 'src-1' } });
    const out = await editReconcile.run(fakeTx(), effect);
    expect(out).toEqual({ done: { result: { issued: 1, revoked: 2 } } });
    expect(verdict).toEqual({ ok: true, metadataPatch: { mobile_upgrade_source_id: 'src-1' } });
  });

  it('policy cannot answer: bounded retry (the effect row decides terminal after MAX_ATTEMPTS)', async () => {
    revalidate.mockRejectedValue(new PaymentPolicyUnavailableError('p', new Error('down')));
    expect(await editReconcile.run(fakeTx(), effect)).toEqual({ retry: { reason: 'policy_unavailable' } });
  });

  it('the policy sees the locked set brand and the order', async () => {
    revalidate.mockResolvedValue({ ok: true });
    await editReconcile.run(fakeTx(), effect);
    expect(revalidate.mock.calls[0]![1]).toMatchObject({ held: HELD, order: { id: 'o1', storeId: 's1' }, reservations: [] });
  });
});
