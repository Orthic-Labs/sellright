import { describe, expect, it, vi } from 'vitest';
import { createNmiProvider } from './nmi.js';

const gateway = {
  accountId: 'dd-nmi-test', storeId: 'store-dd', method: 'nmi' as const,
  mode: 'test' as const, securityKey: 'test-key',
};
const input = {
  orderCode: 'DD-1', amount: 1234, currency: 'USD', token: 'single-use-token',
  gateway, attemptId: 'attempt-1', billingAddress: { postalCode: '90210' },
};
const reply = (body: string) => new Response(body, { status: 200 });

describe('NMI port', () => {
  it('sends a token and exact server amount, never card fields', async () => {
    const transport = vi.fn().mockResolvedValue(reply('response=1&transactionid=123&avsresponse=Y&cvvresponse=M'));
    const result = await createNmiProvider(transport).createPayment(input);
    expect(result.state).toBe('Settled');
    expect(result.providerRef).toBe('123');
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, request] = transport.mock.calls[0]!;
    expect(url).toBe('https://sandbox.nmi.com/api/transact.php');
    const params = new URLSearchParams(request.body);
    expect(params.get('payment_token')).toBe('single-use-token');
    expect(params.get('amount')).toBe('12.34');
    expect(params.get('orderid')).toBe('attempt-1');
    expect(params.has('ccnumber')).toBe(false);
    expect(params.has('cvv')).toBe(false);
  });

  it('leaves a timeout unknown and never retries the sale', async () => {
    const transport = vi.fn().mockRejectedValue(new Error('timeout with sensitive response'));
    const result = await createNmiProvider(transport).createPayment(input);
    expect(result.state).toBe('Pending');
    expect(result.metadata).toMatchObject({ needsReconciliation: true });
    expect(JSON.stringify(result)).not.toContain('sensitive');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('does not settle an approval without a transaction reference', async () => {
    const transport = vi.fn().mockResolvedValue(reply('response=1'));
    expect((await createNmiProvider(transport).createPayment(input)).state).toBe('Pending');
  });

  it('rejects raw card input without calling NMI', async () => {
    const transport = vi.fn();
    expect((await createNmiProvider(transport).createPayment({
      ...input, token: { cardNumber: '4111111111111111', cvv: '123' },
    })).state).toBe('Failed');
    expect(transport).not.toHaveBeenCalled();
  });

  it('does not route a different store through DD credentials', async () => {
    const transport = vi.fn();
    expect((await createNmiProvider(transport).createPayment({
      ...input, storeId: 'another-store',
    })).state).toBe('Failed');
    expect(transport).not.toHaveBeenCalled();
  });

  it('keeps a failed AVS reversal pending rather than inviting another charge', async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce(reply('response=1&transactionid=123&avsresponse=N&cvvresponse=M'))
      .mockRejectedValueOnce(new Error('timeout'));
    const result = await createNmiProvider(transport).createPayment({
      ...input, gateway: { ...gateway, mode: 'live' },
    });
    expect(result.state).toBe('Pending');
    expect(result.providerRef).toBe('123');
    expect(result.metadata).toMatchObject({ needsReconciliation: true });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('does not retry an ambiguous refund', async () => {
    const transport = vi.fn().mockRejectedValue(new Error('timeout'));
    const result = await createNmiProvider(transport).refundPayment!({
      providerRef: '123', amount: 100, currency: 'USD',
      gateway, idempotencyKey: 'refund-1',
    });
    expect(result.state).toBe('Pending');
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
