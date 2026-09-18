import { describe, expect, it, vi } from 'vitest';
import { queryNmiPayment, verifyNmiQuery } from './nmi-query.js';
import type { GatewayAccount } from './gateway-account.js';

const account: GatewayAccount = { accountId: 'nmi', storeId: 'dd', method: 'nmi', mode: 'test', securityKey: 'test-secret' };
const input = { account, orderReference: 'attempt', amount: 1234, currency: 'USD' };
const transaction = '<transaction><transaction_id>123</transaction_id><order_id>attempt</order_id>' +
  '<currency>USD</currency><condition>pendingsettlement</condition><action><action_type>sale</action_type>' +
  '<amount>12.34</amount><success>1</success></action></transaction>';
const xml = '<nm_response>' + transaction + '</nm_response>';

describe('NMI read-only reconciliation', () => {
  it('requires successful matching refund evidence, not just a known reference', () => {
    const refundInput = { ...input, operation: 'refund' as const, providerRef: '123' };
    const refundXml = xml.replace('<action_type>sale</action_type>', '<action_type>refund</action_type>');
    expect(verifyNmiQuery(refundXml, refundInput).state).toBe('Settled');
    for (const body of [xml, '<broken>', refundXml.replace('12.34', '1.00'),
      refundXml.replace('<success>1</success>', '<success>0</success>')]) {
      expect(verifyNmiQuery(body, refundInput).state).toBe('Pending');
    }
  });
  it('keeps a known refund reference pending on a failed query', async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error('timeout'));
    expect(await queryNmiPayment({ ...input, operation: 'refund', providerRef: '123' }, transport))
      .toMatchObject({ state: 'Pending', providerRef: '123' });
  });
  it('queries existing-account test payments on their original endpoint', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(xml));
    await queryNmiPayment({ ...input, account: { ...account, nmiEnvironment: 'production' } }, transport);
    expect(transport.mock.calls[0]![0]).toBe('https://secure.nmi.com/api/query.php');
    expect(new URLSearchParams(transport.mock.calls[0]![1]!.body as string).has('type')).toBe(false);
  });
  it('recovers an approved sale after the original response was lost', () => {
    expect(verifyNmiQuery(xml, input)).toMatchObject({ state: 'Settled', providerRef: '123' });
  });
  it('does not treat no result as permission to charge again', () => {
    expect(verifyNmiQuery('<nm_response/>', input)).toMatchObject({ state: 'Pending', metadata: { needsReconciliation: true } });
  });
  it('holds duplicate, mismatched, reversed and malformed transactions', () => {
    const reversed = xml.replace('</transaction>', '<action><action_type>refund</action_type><amount>1.00</amount><success>1</success></action></transaction>');
    for (const body of [xml.replace('12.34', '12.33'), xml.replace('attempt', 'other'),
      '<nm_response>' + transaction + transaction + '</nm_response>', reversed, '<broken>',
      '<!DOCTYPE nm_response [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + xml]) {
      expect(verifyNmiQuery(body, input).state).toBe('Pending');
    }
  });
  it('queries the original account and never submits a monetary request', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(xml));
    expect((await queryNmiPayment(input, transport)).state).toBe('Settled');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![0]).toBe('https://sandbox.nmi.com/api/query.php');
    expect(new URLSearchParams(transport.mock.calls[0]![1]!.body as string).get('order_id')).toBe('attempt');
  });
});
