/**
 * A database error while reading a per-store webhook secret must answer 503 (retryable) and must not count as a
 * signature failure; a genuine no-match (every secret read fine) stays 400 and is counted. No database: the secret read
 * is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listAllStoreIds = vi.fn(async () => ['store-1']);
const withStoreMock = vi.fn();
vi.mock('../payments/stripe.js', async (orig) => {
  const actual = await orig<typeof import('../payments/stripe.js')>();
  return { ...actual, stripeCreds: () => ({ secretKey: undefined, webhookSecret: undefined, publishableKey: undefined }), listAllStoreIds };
});
vi.mock('../db/client.js', async (orig) => {
  const actual = await orig<typeof import('../db/client.js')>();
  return { ...actual, withStore: (...args: unknown[]) => withStoreMock(...args) };
});

const { paymentWebhooks } = await import('./payment-webhooks.js');
const { _setRateLimitBackendForTest, createMemoryRateLimitBackend } = await import('../auth/rate-limit-backend.js');
const { webhookSignatureRetryAfter } = await import('../auth/rate-limit.js');

const sig = `t=${Math.floor(Date.now() / 1000)},v1=${'a'.repeat(64)}`;
const post = () => paymentWebhooks.request('/v1/webhooks/stripe', {
  method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig, 'x-forwarded-for': '203.0.113.50' }, body: '{}',
});

describe('POST /v1/webhooks/stripe per-store secret lookup', () => {
  beforeEach(() => { withStoreMock.mockReset(); _setRateLimitBackendForTest(createMemoryRateLimitBackend()); });
  afterEach(() => _setRateLimitBackendForTest(undefined));

  it('answers 503 when a secret cannot be read, and never counts it as a signature failure', async () => {
    withStoreMock.mockRejectedValue(new Error('connection terminated'));
    for (let i = 0; i < 12; i++) expect((await post()).status).toBe(503);
    expect(await webhookSignatureRetryAfter('stripe', '203.0.113.50')).toBe(0);
  });

  it('answers 400 for a genuine no-match when every secret reads cleanly', async () => {
    withStoreMock.mockResolvedValue(undefined);
    const res = await post();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad signature' });
  });
});
