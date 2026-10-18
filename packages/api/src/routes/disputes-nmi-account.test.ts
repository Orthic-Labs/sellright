import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

vi.mock('../payments/gateway-account.js', async (orig) => ({
  ...await orig<typeof import('../payments/gateway-account.js')>(),
  resolveGatewayAccount: async (_s: string, _m: string, accountId: string, mode?: string) => {
    if (accountId === 'unknown') throw new Error('not configured');
    if (accountId === 'db' && !mode) throw new Error('mode is required');
    if (accountId === 'db' && mode === 'live') throw new Error('not configured');
    return { accountId, storeId: _s, method: 'nmi', mode, securityKey: 's',
      privateKey: accountId === 'ambiguous' || mode === 'test' ? 'test-signing' : 'live-signing' };
  },
}));
import { disputeRoutes } from './disputes.js';

const storeId = '11111111-1111-4111-8111-111111111111';
const sign = (body: string, key: string) => `t=1,s=${createHmac('sha256', key).update(`1.${body}`).digest('hex')}`;
const post = (accountId: string, body: string, sig: string) => disputeRoutes.request(`/v1/webhooks/nmi/${storeId}/${accountId}`, {
  method: 'POST', body, headers: { 'content-type': 'application/json', 'webhook-signature': sig },
});

describe('NMI chargeback webhook — DB-backed account', () => {
  const body = JSON.stringify({ event_id: 'e', event_type: 'transaction.sale.success' });
  it('resolves the per-mode DB account by signature instead of 404ing', async () => {
    expect((await post('db', body, sign(body, 'test-signing'))).status).toBe(200);
  });
  it('rejects a signature no configured mode verifies', async () => {
    expect((await post('db', body, sign(body, 'wrong'))).status).toBe(401);
  });
  it('rejects zero configured identities before any database work', async () => {
    expect((await post('unknown', body, sign(body, 'test-signing'))).status).toBe(401);
  });
  it.each(['live', 'test'])('resolves named account %s mode by signature', async mode => {
    expect((await post('named', body, sign(body, `${mode}-signing`))).status).toBe(200);
  });
  it('rejects two verifying mode identities before any database work', async () => {
    const chargeback = JSON.stringify({ event_type: 'chargeback.batch.complete', event_body: { chargebacks: [{ id: 'x' }] } });
    expect((await post('ambiguous', chargeback, sign(chargeback, 'test-signing'))).status).toBe(401);
  });
});
