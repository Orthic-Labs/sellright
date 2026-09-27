import { describe, expect, it, vi } from 'vitest';
import { verifyNmiKey, verifySezzleKeys, verifyStripeKey } from './settings-verify.js';

describe('verifyNmiKey', () => {
  it('ok when NMI returns a well-formed nm_response', async () => {
    const transport = vi.fn().mockResolvedValue(new Response('<nm_response><result>0</result></nm_response>', { status: 200 }));
    const r = await verifyNmiKey('good-key', 'sandbox', transport);
    expect(r.ok).toBe(true);
    expect(transport.mock.calls[0]![0]).toBe('https://sandbox.nmi.com/api/query.php');
  });

  it('not ok when NMI reports authentication failure', async () => {
    const transport = vi.fn().mockResolvedValue(new Response('<nm_response><error_response>Authentication Failed</error_response></nm_response>', { status: 200 }));
    const r = await verifyNmiKey('bad-key', 'production', transport);
    expect(r.ok).toBe(false);
  });

  it('rejects an empty key without a network call', async () => {
    const transport = vi.fn();
    const r = await verifyNmiKey('', 'sandbox', transport);
    expect(r.ok).toBe(false);
    expect(transport).not.toHaveBeenCalled();
  });

  it('fails closed on transport error', async () => {
    const transport = vi.fn().mockRejectedValue(new Error('network down'));
    const r = await verifyNmiKey('key', 'sandbox', transport);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/network down/);
  });
});

describe('verifySezzleKeys', () => {
  it('ok when Sezzle returns an auth token', async () => {
    const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: 'abc' }), { status: 200 }));
    const r = await verifySezzleKeys('pub', 'priv', 'sandbox', transport);
    expect(r.ok).toBe(true);
    expect(transport.mock.calls[0]![0]).toBe('https://sandbox.gateway.sezzle.com/v2/authentication');
  });

  it('not ok without a token in the response', async () => {
    const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'invalid' }), { status: 401 }));
    const r = await verifySezzleKeys('pub', 'bad', 'production', transport);
    expect(r.ok).toBe(false);
  });

  it('rejects missing keys without a network call', async () => {
    const transport = vi.fn();
    const r = await verifySezzleKeys('', '', 'sandbox', transport);
    expect(r.ok).toBe(false);
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('verifyStripeKey', () => {
  it('ok when the client resolves balance.retrieve', async () => {
    const client = { balance: { retrieve: vi.fn().mockResolvedValue({}) } };
    const r = await verifyStripeKey('sk_test_abc', 'test', client);
    expect(r.ok).toBe(true);
  });

  it('rejects a live key in test mode by shape before calling Stripe', async () => {
    const client = { balance: { retrieve: vi.fn() } };
    const r = await verifyStripeKey('sk_live_abc', 'test', client);
    expect(r.ok).toBe(false);
    expect(client.balance.retrieve).not.toHaveBeenCalled();
  });

  it('not ok when Stripe rejects the key', async () => {
    const client = { balance: { retrieve: vi.fn().mockRejectedValue(new Error('Invalid API Key provided')) } };
    const r = await verifyStripeKey('sk_test_bad', 'test', client);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid API Key/);
  });
});
