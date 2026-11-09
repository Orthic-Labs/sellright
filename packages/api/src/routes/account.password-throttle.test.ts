import { beforeEach, describe, expect, it, vi } from 'vitest';

const verifyPassword = vi.fn(async () => false);
const attemptRetryAfter = vi.fn(async () => 0);

vi.mock('../db/client.js', () => ({ withStore: vi.fn(async () => ({ id: 'customer-1' })), pool: {}, db: {} }));
vi.mock('./store-context.js', () => ({ resolveStoreFromCtx: vi.fn(async () => ({ id: 'store-1', config: {} })) }));
vi.mock('../auth/session.js', () => ({ customerToken: () => 'tok', resolveCustomer: vi.fn() }));
vi.mock('../auth/password.js', () => ({ verifyPassword, hashPassword: vi.fn(async () => 'hash') }));
vi.mock('../auth/rate-limit.js', () => ({ attemptRetryAfter, clientIp: () => '203.0.113.7' }));

const { account } = await import('./account.js');

const call = () => account.request('/v1/shop/account/password', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ currentPassword: 'old-password', newPassword: 'new-password-123' }),
});

describe('POST /v1/shop/account/password throttle', () => {
  beforeEach(() => { verifyPassword.mockClear(); attemptRetryAfter.mockReset(); });

  it('answers 429 with the standard envelope and Retry-After once the per-customer budget is spent, before any password work', async () => {
    attemptRetryAfter.mockResolvedValue(42);
    const res = await call();
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(attemptRetryAfter).toHaveBeenCalledWith('203.0.113.7', 'password-change:store-1:customer-1');
  });

  it('checks the current password when the budget allows', async () => {
    attemptRetryAfter.mockResolvedValue(0);
    const res = await call();
    expect(res.status).toBe(401);
    expect(verifyPassword).toHaveBeenCalledTimes(1);
  });
});
