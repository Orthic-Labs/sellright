import { describe, expect, it, vi } from 'vitest';
import { createSezzleProvider, verifySezzleSignature } from './sezzle.js';
import { createHmac } from 'node:crypto';

const gateway = {
  accountId: 'dd-sezzle-test', storeId: 'dd', method: 'sezzle' as const,
  mode: 'test' as const, publicKey: 'public-test', privateKey: 'private-test',
};
const input = { storeId: 'dd', orderCode: 'DD1', amount: 1200, currency: 'USD',
  attemptId: 'attempt1', gateway, token: 'provider-order' };
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
const order = (captures: unknown[]) => ({
  uuid: 'provider-order', reference_id: 'attempt1',
  order_amount: { amount_in_cents: 1200, currency: 'USD' },
  checkout_status: 'completed',
  authorization: { approved: true, captures },
});
const transportFor = (value: unknown) => vi.fn()
  .mockResolvedValueOnce(json({ token: 'auth-token' }))
  .mockResolvedValueOnce(json(value));

describe('Sezzle port', () => {
  it('never treats authorization as capture', async () => {
    const provider = createSezzleProvider(transportFor(order([])));
    expect((await provider.createPayment(input)).state).toBe('Authorized');
  });
  it('settles only the exact verified captured amount', async () => {
    const provider = createSezzleProvider(transportFor(order([
      { uuid: 'capture1', amount: { amount_in_cents: 1200, currency: 'USD' } },
    ])));
    expect((await provider.createPayment(input)).state).toBe('Settled');
  });
  it('holds partial capture for reconciliation', async () => {
    const provider = createSezzleProvider(transportFor(order([
      { uuid: 'capture1', amount: { amount_in_cents: 600, currency: 'USD' } },
    ])));
    expect((await provider.createPayment(input)).state).toBe('Pending');
  });
  it('rejects payment from another attempt', async () => {
    const provider = createSezzleProvider(transportFor({ ...order([]), reference_id: 'another-order' }));
    expect((await provider.createPayment(input)).state).toBe('Pending');
  });
  it('requires a real refund identifier', async () => {
    const provider = createSezzleProvider(transportFor({ status: 'success' }));
    expect((await provider.refundPayment!({
      gateway, providerRef: 'provider-order', amount: 100, currency: 'USD', idempotencyKey: 'refund1',
    })).state).toBe('Pending');
  });
  it('verifies the exact raw webhook body and rejects modified messages', () => {
    const raw = '{"uuid":"event1"}';
    const signature = createHmac('sha256', gateway.privateKey).update(raw).digest('hex');
    expect(verifySezzleSignature(raw, signature, gateway.privateKey)).toBe(true);
    expect(verifySezzleSignature(raw + ' ', signature, gateway.privateKey)).toBe(false);
    expect(verifySezzleSignature(raw, 'bad', gateway.privateKey)).toBe(false);
  });
});
