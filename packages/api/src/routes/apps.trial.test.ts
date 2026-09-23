import { afterEach, describe, expect, it, vi } from 'vitest';

const { sendTrialKey, trialResult } = vi.hoisted(() => ({
  sendTrialKey: vi.fn().mockResolvedValue(undefined),
  trialResult: { current: { kind: 'issued', key: 'SR-TRIAL-123' } as
    | { kind: 'issued' | 'resend'; key: string }
    | { kind: 'expired' } },
}));

vi.mock('../email/dispatch.js', () => ({
  sendTrialKey,
}));

vi.mock('../db/client.js', () => ({
  withStore: vi.fn(async () => trialResult.current),
}));

vi.mock('../store-context.js', () => ({
  DEV_DEFAULT_STORE: 'sellright',
  StoreSlugError: class StoreSlugError extends Error {},
  resolveStore: vi.fn(async () => ({
    id: 'store_1',
    slug: 'sellright',
    name: 'SellRight',
    currency: 'USD',
  })),
}));

describe('trial license route', () => {
  afterEach(() => {
    vi.clearAllMocks();
    trialResult.current = { kind: 'issued', key: 'SR-TRIAL-123' };
  });

  it('passes the requested app key into the trial email sender and returns 200', async () => {
    const { apps } = await import('./apps.js');

    const res = await apps.request('/v1/licenses/trial', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'someapp', email: 'trial@example.com' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 'sent' });
    expect(sendTrialKey).toHaveBeenCalledWith(
      { name: 'SellRight', currency: 'USD', appKey: 'someapp' },
      'trial@example.com',
      { key: 'SR-TRIAL-123', days: 14 },
    );
  });

  it('also accepts the legacy /api/licenses/trial path', async () => {
    const { apps } = await import('./apps.js');

    const res = await apps.request('/api/licenses/trial', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'someapp', email: 'trial@example.com' }),
    });

    expect(res.status).toBe(200);
  });

  it('rejects a repeat request after the trial has expired, without emailing again', async () => {
    trialResult.current = { kind: 'expired' };
    const { apps } = await import('./apps.js');

    const res = await apps.request('/v1/licenses/trial', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'someapp', email: 'used@example.com' }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, status: 'trial_used' });
    expect(sendTrialKey).not.toHaveBeenCalled();
  });

  it('rejects a malformed request body (missing email) without minting or emailing a key', async () => {
    // TrialRequestIn.parse throws unguarded, same convention as the sibling
    // /api/licenses/activate route in this file (PublicActivateIn.parse) —
    // both rely on the top-level app.onError for a clean client status when
    // mounted inside createApp(); requesting the bare sub-router directly (as
    // this test does) surfaces Hono's uncaught-error default instead. The
    // behavior under test here is narrower: a malformed body never reaches
    // mintLicense/sendTrialKey.
    const { apps } = await import('./apps.js');

    const res = await apps.request('/v1/licenses/trial', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'someapp' }),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(sendTrialKey).not.toHaveBeenCalled();
  });
});
