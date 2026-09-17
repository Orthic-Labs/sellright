import { describe, expect, it, vi } from 'vitest';
import { createSezzleProvider, normalizeSezzleEvent, verifySezzleSignature } from './sezzle.js';
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

// SR-06: event-specific normalization. The old universal schema required
// data.uuid on EVERY event — documented dispute events carry the order id on
// data.order_uuid instead, so every signed dispute was rejected with a 400 and
// chargebacks arrived invisible.
describe('normalizeSezzleEvent — SR-06', () => {
  it('a documented dispute payload normalizes on data.order_uuid', () => {
    const n = normalizeSezzleEvent({
      uuid: 'evt_1', event: 'dispute.merchant_input_requested', data_type: 'dispute',
      data: {
        dispute_id: 42, order_uuid: 'ord-uuid-1', order_reference_id: 'att-1',
        dispute_type: 'fraud', dispute_status: 'merchant_input_requested',
        dispute_amount_in_cents: 1200, dispute_currency: 'USD', dispute_due_date: '2026-02-01',
      },
    });
    expect(n).not.toBeNull();
    expect(n).toMatchObject({
      eventId: 'evt_1', eventType: 'dispute.merchant_input_requested',
      providerRef: 'ord-uuid-1', orderUuid: 'ord-uuid-1', disputeId: '42',
    });
    expect(n!.details.dispute).toMatchObject({
      disputeId: '42', orderUuid: 'ord-uuid-1', orderReferenceId: 'att-1',
      disputeType: 'fraud', disputeStatus: 'merchant_input_requested',
      amountInCents: 1200, currency: 'USD', dueDate: '2026-02-01',
    });
  });

  it('an order event keys on data.uuid and carries no dispute block', () => {
    const n = normalizeSezzleEvent({ uuid: 'evt_2', event: 'order.captured', data: { uuid: 'ord-uuid-2' } });
    expect(n).toMatchObject({ eventId: 'evt_2', providerRef: 'ord-uuid-2', orderUuid: 'ord-uuid-2', disputeId: null });
    expect(n!.details.dispute).toBeUndefined();
  });

  it('a data block with order_uuid alone is still a dispute (no event prefix needed)', () => {
    const n = normalizeSezzleEvent({ uuid: 'evt_3', event: 'dispute.opened', data: { order_uuid: 'ord-uuid-3' } });
    expect(n).toMatchObject({ providerRef: 'ord-uuid-3', orderUuid: 'ord-uuid-3' });
    expect(n!.details.dispute).toBeDefined();
  });

  it('only non-envelopes return null — malformed data still yields a durable record', () => {
    expect(normalizeSezzleEvent(null)).toBeNull();
    expect(normalizeSezzleEvent({})).toBeNull();
    expect(normalizeSezzleEvent('string')).toBeNull();
    const n = normalizeSezzleEvent({ uuid: 'evt_4', event: 'order.captured' }); // no data at all
    expect(n).toMatchObject({ eventId: 'evt_4', providerRef: 'evt_4' });
    expect(n!.details.malformed).toBe(true);
  });

  it('an event with no envelope uuid still normalizes (caller substitutes a body-hash id)', () => {
    const n = normalizeSezzleEvent({ event: 'order.captured', data: { uuid: 'ord-uuid-4' } });
    expect(n).toMatchObject({ eventId: null, providerRef: 'ord-uuid-4', eventType: 'order.captured' });
  });
});
