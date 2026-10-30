/**
 * P8 (C9 / G5): the Stripe webhook refuses malformed or stale signature headers BEFORE the per-store secret fan-out,
 * answers absent vs invalid distinctly, caps the body for this route, and stops fanning out for an address that keeps
 * presenting wrong signatures. No database: the fan-out seam (listAllStoreIds) is mocked and must never be reached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listAllStoreIds = vi.fn(async () => [] as string[]);
vi.mock('../payments/stripe.js', async (orig) => {
  const actual = await orig<typeof import('../payments/stripe.js')>();
  return { ...actual, stripeCreds: () => ({ secretKey: undefined, webhookSecret: undefined, publishableKey: undefined }), listAllStoreIds };
});

const { paymentWebhooks, precheckStripeSignature, STRIPE_WEBHOOK_BODY_LIMIT_BYTES } = await import('./payment-webhooks.js');
const { _setRateLimitBackendForTest, createMemoryRateLimitBackend } = await import('../auth/rate-limit-backend.js');

const HEX = 'a'.repeat(64);
const now = () => Math.floor(Date.now() / 1000);
const post = (headers: Record<string, string>, body = '{}') =>
  paymentWebhooks.request('/v1/webhooks/stripe', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

describe('precheckStripeSignature', () => {
  it('distinguishes absent, invalid, stale and well-formed headers', () => {
    expect(precheckStripeSignature(undefined)).toBe('absent');
    expect(precheckStripeSignature('  ')).toBe('absent');
    expect(precheckStripeSignature('garbage')).toBe('invalid');
    expect(precheckStripeSignature(`t=${now()}`)).toBe('invalid');
    expect(precheckStripeSignature(`t=${now()},v1=nothex`)).toBe('invalid');
    expect(precheckStripeSignature(`t=abc,v1=${HEX}`)).toBe('invalid');
    expect(precheckStripeSignature(`t=${now()},v1=${HEX},` + 'x'.repeat(5000))).toBe('invalid');
    expect(precheckStripeSignature(`t=${now() - 301},v1=${HEX}`)).toBe('stale');
    expect(precheckStripeSignature(`t=${now()},v1=${HEX},v0=${HEX}`)).toBe('ok');
  });
});

describe('POST /v1/webhooks/stripe pre-fan-out gates', () => {
  beforeEach(() => { listAllStoreIds.mockClear(); _setRateLimitBackendForTest(createMemoryRateLimitBackend()); });
  afterEach(() => _setRateLimitBackendForTest(undefined));

  it('absent signature: 400 missing signature, no fan-out', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing signature' });
    expect(listAllStoreIds).not.toHaveBeenCalled();
  });

  it('malformed or stale signature: 400 bad signature, no fan-out', async () => {
    for (const sig of ['nonsense', `t=${now() - 10_000},v1=${HEX}`]) {
      const res = await post({ 'stripe-signature': sig });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad signature' });
    }
    expect(listAllStoreIds).not.toHaveBeenCalled();
  });

  it('well-formed but wrong signatures fan out only until the per-address failure budget is spent', async () => {
    for (let i = 0; i < 20; i++) expect((await post({ 'stripe-signature': `t=${now()},v1=${HEX}` })).status).toBe(400);
    expect(listAllStoreIds).toHaveBeenCalledTimes(20);
    const res = await post({ 'stripe-signature': `t=${now()},v1=${HEX}` });
    expect(res.status).toBe(429);
    expect(listAllStoreIds).toHaveBeenCalledTimes(20);
  });

  it('caps the body for this route', async () => {
    const big = 'x'.repeat(STRIPE_WEBHOOK_BODY_LIMIT_BYTES + 1);
    const res = await post({ 'stripe-signature': `t=${now()},v1=${HEX}`, 'content-length': String(big.length) }, big);
    expect(res.status).toBe(413);
    expect(listAllStoreIds).not.toHaveBeenCalled();
  });
});
