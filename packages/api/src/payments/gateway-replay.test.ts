import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  order: { id: 'order', receiptToken: 'receipt', deletedAt: null },
  existing: {} as Record<string, unknown>,
  verification: false,
  reads: 0,
  tender: null as null | { editId: string; amount: number; currency: string },
  pending: false,
  bind: vi.fn(),
  retrySettlement: vi.fn(),
  resolveAccount: vi.fn(),
}));
vi.mock('../db/client.js', async (original) => ({
  ...await original<typeof import('../db/client.js')>(),
  withAdvisoryLock: async (_key: string, run: () => Promise<unknown>) => run(),
  withStore: async (_store: string, run: (tx: unknown) => Promise<unknown>) => {
    if (fixture.verification) {
      const rows = [fixture.reads++ === 0 || fixture.existing.status === 'settled' ? fixture.existing : fixture.order];
      const q = { from: () => q, where: () => q, limit: () => q, for: async () => rows,
        then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve) };
      return run({ select: () => q });
    }
    const limit = vi.fn()
      .mockReturnValueOnce({ for: async () => [fixture.order] })
      .mockResolvedValueOnce([fixture.existing]);
    const query = { from: () => query, where: () => query, limit };
    return run({ select: () => query });
  },
}));
// Start path plans the order set first (orderIdByCode, withLockedSet). The fixture tx stands in for
// the locked transaction; the lock set itself is covered by db/locks tests.
vi.mock('../db/locks.js', async (original) => ({
  ...await original<typeof import('../db/locks.js')>(),
  orderIdByCode: async () => 'order',
  withLockedSet: async (storeId: string, _subject: unknown, run: (tx: unknown, held: unknown, plan: unknown) => Promise<unknown>) => {
    const { withStore } = await import('../db/client.js');
    return withStore(storeId, (tx) => run(tx, {}, {}));
  },
  assertHeld: async () => undefined,
}));
vi.mock('./gateway-account.js', async (original) => {
  const fixtureAccount = {
    storeId: 'store', accountId: 'nmi-test', method: 'nmi', mode: 'test',
    nmiEnvironment: 'production', securityKey: 'fixture',
  };
  return {
    ...await original<typeof import('./gateway-account.js')>(),
    configuredGatewayAccount: () => fixtureAccount,
    gatewayAccount: () => fixtureAccount,
    // WS-A resolver wrappers — this suite exercises the (still env-only, via
    // GATEWAY_ACCOUNTS_JSON) reconciliation path, so they resolve exactly the
    // same fixture account synchronously-as-a-promise.
    resolveConfiguredGatewayAccount: fixture.resolveAccount.mockResolvedValue(fixtureAccount),
    resolveGatewayAccount: fixture.resolveAccount,
  };
});
vi.mock('./settle.js', async original => ({
  ...await original<typeof import('./settle.js')>(),
  retryPreparedEditSettlement: fixture.retrySettlement,
}));

vi.mock('../orders/order-edit-service.js', () => ({
  preparedEditTender: async () => fixture.tender,
  bindPreparedEditTender: fixture.bind,
}));
vi.mock('../orders/edit-stage.js', async original => ({
  ...await original<typeof import('../orders/edit-stage.js')>(),
  assertNoPendingOrderEdit: async (_tx: unknown, _store: string, _order: string, options: { allowEditId?: string }) => {
    if (fixture.pending && options.allowEditId !== fixture.tender?.editId) throw new Error('Resolve the pending order edit first');
    if (fixture.pending && !fixture.tender) throw new Error('Resolve the pending order edit first');
  },
}));
import { startGatewayPayment, verifyGatewayAttempt } from './gateway-payment.js';

beforeEach(() => {
  fixture.verification = false;
  fixture.tender = null;
  fixture.pending = false;
  fixture.bind.mockReset();
  fixture.retrySettlement.mockReset().mockResolvedValue(null);
  fixture.resolveAccount.mockClear();
  fixture.reads = 0;
  fixture.existing = {
    id: 'attempt', orderId: 'order', method: 'nmi', operation: 'charge',
    accountId: 'nmi-test', mode: 'test', status: 'pending', context: {},
  };
});
const start = () => startGatewayPayment({
  storeId: 'store', code: 'order', method: 'nmi',
  config: { payments: { nmi: true } }, idempotencyKey: 'reused', receiptToken: 'receipt',
});
it('returns a conflict for a cross-method key before inspecting its environment', async () => {
  fixture.existing.method = 'sezzle';
  fixture.existing.operation = 'session';
  await expect(start()).rejects.toMatchObject({
    status: 409, message: 'Idempotency key belongs to a different payment',
  });
});
it('returns a conflict when the original NMI endpoint changed', async () => {
  await expect(start()).rejects.toMatchObject({
    status: 409, message: 'Payment gateway environment changed; restore the original account configuration',
  });
});
it('replays a matching production-host test attempt without charging again', async () => {
  fixture.existing.context = { nmiEnvironment: 'production' };
  await expect(start()).resolves.toMatchObject({ attemptId: 'attempt', status: 'pending' });
});
it('returns a controlled conflict before querying a changed verification endpoint', async () => {
  fixture.verification = true;
  await expect(verifyGatewayAttempt('store', 'attempt')).rejects.toMatchObject({
    status: 409, message: 'Payment gateway environment changed; restore the original account configuration',
  });
});

it('fences a new ordinary tender while a prepared refund edit is pending', async () => {
  fixture.pending = true;
  await expect(start()).rejects.toMatchObject({ status: 409, code: 'ORDER_EDIT_PENDING' });
  expect(fixture.bind).not.toHaveBeenCalled();
});
it('replays only the linked prepared edit attempt under its edit namespace', async () => {
  fixture.pending = true;
  fixture.tender = { editId: 'edit', amount: 250, currency: 'USD' };
  fixture.existing.context = { nmiEnvironment: 'production' };
  fixture.existing.idempotencyKey = 'reused:edit:edit';
  await expect(start()).resolves.toMatchObject({ attemptId: 'attempt', status: 'pending' });
  expect(fixture.bind).toHaveBeenCalledWith(expect.anything(), { storeId: 'store', orderId: 'order', editId: 'edit', paymentAttemptId: 'attempt' });
});
it('recovers durable edit tender before requiring gateway configuration', async () => {
  fixture.retrySettlement.mockResolvedValue({ attempt: { ...fixture.existing, status: 'settled' }, orderState: 'Paid' });
  await expect(start()).resolves.toMatchObject({ attemptId: 'attempt', status: 'settled' });
  expect(fixture.resolveAccount).not.toHaveBeenCalled();
});
it('verifies settled gateway tender by durable replay without provider lookup', async () => {
  fixture.verification = true;
  fixture.existing.status = 'settled';
  await expect(verifyGatewayAttempt('store', 'attempt')).resolves.toMatchObject({ attemptId: 'attempt', status: 'settled' });
  expect(fixture.retrySettlement).toHaveBeenCalledWith(expect.anything(), 'store', 'order', { paymentAttemptId: 'attempt' });
  expect(fixture.resolveAccount).not.toHaveBeenCalled();
});
