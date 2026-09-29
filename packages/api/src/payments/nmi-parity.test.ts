import { describe, expect, it, vi } from 'vitest';
import { createNmiProvider, NMI_DECLINE_MESSAGE, NMI_DUPLICATE_MESSAGE, NMI_VERIFICATION_MESSAGE } from './nmi.js';

const gateway = { accountId: 'a', storeId: 'st', method: 'nmi' as const, mode: 'live' as const, securityKey: 'k' };
const input = { orderCode: 'O', amount: 1000, currency: 'USD', token: 'tok', gateway, attemptId: 'att' };
const reply = (body: string) => new Response(body, { status: 200 });

describe('NMI parity (legacy-store spec A)', () => {
  it('declines with a customer-safe message; gateway text stays in metadata', async () => {
    const t = vi.fn().mockResolvedValue(reply('response=2&responsetext=DECLINE+R05&transactionid=9'));
    const r = await createNmiProvider(t).createPayment(input);
    expect(r).toMatchObject({ state: 'Declined', errorMessage: NMI_DECLINE_MESSAGE, metadata: { responseText: 'DECLINE R05' } });
  });
  it('holds a duplicate (response=3) for reconciliation with the duplicate message', async () => {
    const t = vi.fn().mockResolvedValue(reply('response=3&responsetext=Duplicate+transaction+REFID:1'));
    const r = await createNmiProvider(t).createPayment(input);
    expect(r.state).toBe('Pending');
    expect(r.errorMessage).toBe(NMI_DUPLICATE_MESSAGE);
    expect((r.metadata as { needsReconciliation: boolean }).needsReconciliation).toBe(true);
  });
  it('fails a non-duplicate response=3 with no transaction (nothing was processed)', async () => {
    const t = vi.fn().mockResolvedValue(reply('response=3&responsetext=Invalid+amount'));
    expect(await createNmiProvider(t).createPayment(input)).toMatchObject({ state: 'Failed', providerRef: null });
  });
  it('voids AVS N and reports the avs/cvv codes with the verification message', async () => {
    const t = vi.fn()
      .mockResolvedValueOnce(reply('response=1&transactionid=5&avsresponse=N&cvvresponse=M'))
      .mockResolvedValueOnce(reply('response=1&transactionid=5'));
    const r = await createNmiProvider(t).createPayment(input);
    expect(r).toMatchObject({ state: 'Declined', errorMessage: NMI_VERIFICATION_MESSAGE,
      metadata: { reversed: true, reversal: 'void', avs: 'N', cvv: 'M' } });
  });
  it('falls back to a refund when the void reports the original transaction not found', async () => {
    const t = vi.fn()
      .mockResolvedValueOnce(reply('response=1&transactionid=5&avsresponse=Y&cvvresponse=N'))
      .mockResolvedValueOnce(reply('response=3&responsetext=Original+transaction+not+found'))
      .mockResolvedValueOnce(reply('response=1&transactionid=r1'));
    const r = await createNmiProvider(t).createPayment(input);
    expect(r).toMatchObject({ state: 'Declined', metadata: { reversal: 'refund', refundRef: 'r1' } });
    expect(new URLSearchParams(t.mock.calls[2]![1].body).get('orderid')).toBe('att:avs-reversal');
  });
  it('flags an unconfirmed reversal for manual review', async () => {
    const t = vi.fn()
      .mockResolvedValueOnce(reply('response=1&transactionid=5&avsresponse=C&cvvresponse=M'))
      .mockResolvedValueOnce(reply('response=3&responsetext=System+error'));
    const r = await createNmiProvider(t).createPayment(input);
    expect(r).toMatchObject({ state: 'Pending', metadata: { manualReview: true, reason: 'verification_reversal_unconfirmed' } });
  });
});
