import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  order: { id: 'order', receiptToken: 'receipt', deletedAt: null },
  existing: {} as Record<string, unknown>,
  verification: false,
  reads: 0,
}));
vi.mock('../db/client.js', async (original) => ({
  ...await original<typeof import('../db/client.js')>(),
  withAdvisoryLock: async (_key: string, run: () => Promise<unknown>) => run(),
  withStore: async (_store: string, run: (tx: unknown) => Promise<unknown>) => {
    const limit = vi.fn()
      .mockReturnValueOnce({ for: async () => [fixture.order] })
      .mockResolvedValueOnce([fixture.existing]);
    if (fixture.verification) limit.mockReset().mockResolvedValue([
      fixture.reads++ === 0 ? fixture.existing : fixture.order,
    ]);
    const query = { from: () => query, where: () => query, limit };
    return run({ select: () => query });
  },
}));
vi.mock('./gateway-account.js', async (original) => ({
  ...await original<typeof import('./gateway-account.js')>(),
  configuredGatewayAccount: () => ({
    storeId: 'store', accountId: 'nmi-test', method: 'nmi', mode: 'test',
    nmiEnvironment: 'production', securityKey: 'fixture',
  }),
  gatewayAccount: () => ({
    storeId: 'store', accountId: 'nmi-test', method: 'nmi', mode: 'test',
    nmiEnvironment: 'production', securityKey: 'fixture',
  }),
}));
import { startGatewayPayment, verifyGatewayAttempt } from './gateway-payment.js';

beforeEach(() => {
  fixture.verification = false;
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
