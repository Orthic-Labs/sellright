import { describe, expect, it, vi } from 'vitest';

const enqueue = vi.fn(async () => true);
vi.mock('../email/outbox.js', () => ({ enqueueEmail: (...a: unknown[]) => (enqueue as (...x: unknown[]) => unknown)(...a) }));
vi.mock('../disputes/disputes.js', () => ({ operatorRecipients: async () => ['owner@example.com', 'ops@example.com'] }));
import { enqueuePaymentAfterCancelAlert } from './settle.js';

describe('D14 payment_after_cancel alert', () => {
  it('enqueues a deduped operator email per recipient', async () => {
    const q: Record<string, unknown> = {};
    for (const k of ['from', 'where']) q[k] = () => q;
    q.limit = async () => [{ name: 'Shop', currency: 'USD', config: {} }];
    const tx = { select: () => q };
    const n = await enqueuePaymentAfterCancelAlert(tx as never, 'store', {
      orderId: 'o1', orderCode: 'DD-9', orderState: 'Cancelled', method: 'sezzle', providerRef: 'ord', amount: 1250, currency: 'USD',
    });
    expect(n).toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(2);
    const [, storeId, args] = enqueue.mock.calls[0] as unknown as [unknown, string, { kind: string; dedupeKey: string; payload: { subject: string; text: string } }];
    expect(storeId).toBe('store');
    expect(args.kind).toBe('payment_after_cancel_alert');
    expect(args.dedupeKey).toBe('payment_after_cancel:o1:ord:owner@example.com');
    expect(args.payload.subject).toContain('DD-9');
    expect(args.payload.text).toContain('12.50 USD');
  });
});
