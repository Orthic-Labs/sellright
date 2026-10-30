import { describe, expect, it } from 'vitest';
import { applyLiveRefundState } from './order-edit-service.js';

const base = { type: 'refund_now', status: 'pending', refundId: 'r1' } as never;

describe('applyLiveRefundState (batched history projection)', () => {
  it('returns the stored settlement when the refund row is missing', () => {
    expect(applyLiveRefundState(base, undefined)).toBe(base);
  });
  it('maps Settled to settled and records the refund state', () => {
    expect(applyLiveRefundState(base, 'Settled')).toMatchObject({ status: 'settled', refundState: 'Settled' });
  });
  it('maps Failed to failed with the retry message', () => {
    const out = applyLiveRefundState(base, 'Failed') as { status: string; message?: string };
    expect(out.status).toBe('failed');
    expect(out.message).toMatch(/declined the refund/);
  });
  it('keeps reconciliation_required but refreshes refundState', () => {
    const st = { type: 'refund_now', status: 'reconciliation_required', phase: 'gateway', refundId: 'r1' } as never;
    expect(applyLiveRefundState(st, 'Settled')).toMatchObject({ status: 'reconciliation_required', refundState: 'Settled' });
  });
  it('is identity when status and refundState already match', () => {
    const st = { type: 'refund_now', status: 'settled', refundState: 'Settled', refundId: 'r1' } as never;
    expect(applyLiveRefundState(st, 'Settled')).toBe(st);
  });
});
