import { describe, expect, it, vi } from 'vitest';
import { createSezzleProvider, normalizeSezzleEvent } from './sezzle.js';

const gateway = { accountId: 'a', storeId: 'st', method: 'sezzle' as const, mode: 'test' as const, publicKey: 'p', privateKey: 'k' };
const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 });

describe('Sezzle capture/release (Z12/D22)', () => {
  it('captures the full amount with an idempotent request id', async () => {
    const t = vi.fn().mockResolvedValueOnce(json({ token: 'x' })).mockResolvedValueOnce(json({ uuid: 'cap' }));
    await createSezzleProvider(t).captureOrder(gateway, 'ord', { amount_in_cents: 500, currency: 'USD' }, 'att:capture');
    const [url, init] = t.mock.calls[1]!;
    expect(url).toBe('https://sandbox.gateway.sezzle.com/v2/order/ord/capture');
    expect(JSON.parse(init.body)).toEqual({ capture_amount: { amount_in_cents: 500, currency: 'USD' }, partial_capture: false });
    expect(init.headers['Sezzle-Request-Id']).toBe('att:capture');
  });
  it('releases an uncaptured authorization', async () => {
    const t = vi.fn().mockResolvedValueOnce(json({ token: 'x' })).mockResolvedValueOnce(json({ uuid: 'rel' }));
    await createSezzleProvider(t).releaseOrder(gateway, 'ord', { amount_in_cents: 500, currency: 'USD' }, 'att:release');
    expect(t.mock.calls[1]![0]).toBe('https://sandbox.gateway.sezzle.com/v2/order/ord/release');
    expect(JSON.parse(t.mock.calls[1]![1].body)).toEqual({ amount_in_cents: 500, currency: 'USD' });
  });
  it('keeps reference_id as a D15 association hint', () => {
    const n = normalizeSezzleEvent({ uuid: 'e1', event: 'order.authorized', data: { uuid: 'ord', reference_id: 'att' } });
    expect(n!.providerRef).toBe('ord');
    expect(n!.details.referenceId).toBe('att');
  });
});
