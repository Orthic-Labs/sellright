import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attemptRetryAfter, clearAdminAuthFailures, inCidrs, clearLoginAttempts, clientIp, loginRetryAfter, pickClientIp, recordLoginFailure, reserveAdminAuthAttempt } from './rate-limit.js';
import { _setRateLimitBackendForTest, createMemoryRateLimitBackend } from './rate-limit-backend.js';

/**
 * SEC-5: cf-connecting-ip must only be trusted when the deployment declares
 * itself behind Cloudflare. Otherwise a client can set that header itself
 * (it's just another HTTP header on a store not sitting behind the CF edge)
 * and get a fresh, unrate-limited "IP" on every request, defeating the login
 * throttle in rate-limit.ts. These are pure unit tests — no DB, no server.
 */
function headers(map: Record<string, string>) {
  return { get: (k: string) => map[k] };
}

describe('rate limiting semantics', () => {
  it('keeps login checks failure-counted rather than consuming successful checks', async () => {
    const ip = '198.51.100.10';
    const id = 'login:user@example.com';
    await clearLoginAttempts(ip, id);
    for (let i = 0; i < 20; i++) expect(await loginRetryAfter(ip, id)).toBe(0);
    for (let i = 0; i < 8; i++) await recordLoginFailure(ip, id);
    expect(await loginRetryAfter(ip, id)).toBeGreaterThan(0);
    await clearLoginAttempts(ip, id);
  });

  it('consumes checkout attempts so the ninth request in the window is blocked', async () => {
    const ip = '198.51.100.11';
    const id = 'checkout:anonymous';
    await clearLoginAttempts(ip, id);
    for (let i = 0; i < 8; i++) expect(await loginRetryAfter(ip, id)).toBe(0);
    expect(await loginRetryAfter(ip, id)).toBeGreaterThan(0);
    await clearLoginAttempts(ip, id);
  });

  it('consumes payment attempts directly through the generic attempt helper', async () => {
    const ip = '198.51.100.12';
    const id = 'pay:198.51.100.12:stripe';
    await clearLoginAttempts(ip, id);
    for (let i = 0; i < 8; i++) expect(await attemptRetryAfter(ip, id)).toBe(0);
    expect(await attemptRetryAfter(ip, id)).toBeGreaterThan(0);
    await clearLoginAttempts(ip, id);
  });
});

describe('pickClientIp', () => {
  it('ignores a spoofed cf-connecting-ip when not behind Cloudflare', () => {
    const ip = pickClientIp(
      headers({ 'cf-connecting-ip': '1.2.3.4', 'x-real-ip': '10.0.0.9' }),
      { behindCloudflare: false, trustedHeader: 'x-real-ip' },
    );
    expect(ip).toBe('10.0.0.9');
  });

  it('honors cf-connecting-ip when behind Cloudflare', () => {
    const ip = pickClientIp(
      headers({ 'cf-connecting-ip': '1.2.3.4', 'x-real-ip': '10.0.0.9' }),
      { behindCloudflare: true, trustedHeader: 'x-real-ip' },
    );
    expect(ip).toBe('1.2.3.4');
  });

  it('falls back to the trusted proxy header when behind Cloudflare but the CF header is absent', () => {
    const ip = pickClientIp(
      headers({ 'x-real-ip': '10.0.0.9' }),
      { behindCloudflare: true, trustedHeader: 'x-real-ip' },
    );
    expect(ip).toBe('10.0.0.9');
  });

  it('uses a custom trusted header name when configured', () => {
    const ip = pickClientIp(
      headers({ 'x-custom-proxy-ip': '10.0.0.9', 'x-real-ip': 'should-not-be-used' }),
      { behindCloudflare: false, trustedHeader: 'x-custom-proxy-ip' },
    );
    expect(ip).toBe('10.0.0.9');
  });

  it('falls back to remoteAddr when no trusted header is present', () => {
    const ip = pickClientIp(
      headers({}),
      { behindCloudflare: false, trustedHeader: 'x-real-ip', remoteAddr: '192.168.1.1' },
    );
    expect(ip).toBe('192.168.1.1');
  });

  it('falls back to "unknown" when nothing is available', () => {
    const ip = pickClientIp(
      headers({}),
      { behindCloudflare: false, trustedHeader: 'x-real-ip' },
    );
    expect(ip).toBe('unknown');
  });

  it('never reads x-forwarded-for (trivially forgeable, multi-hop)', () => {
    const ip = pickClientIp(
      headers({ 'x-forwarded-for': '9.9.9.9' }),
      { behindCloudflare: true, trustedHeader: 'x-real-ip' },
    );
    expect(ip).toBe('unknown');
  });
});

describe('pickClientIp — header trust is tied to the TCP peer (P1a)', () => {
  it('a PUBLIC peer reached the API directly: forged x-real-ip / cf-connecting-ip are ignored, the socket address is used', () => {
    for (const behindCloudflare of [false, true]) {
      const ip = pickClientIp(
        headers({ 'x-real-ip': '10.1.1.1', 'cf-connecting-ip': '1.2.3.4' }),
        { behindCloudflare, trustedHeader: 'x-real-ip', remoteAddr: '203.0.113.7' },
      );
      expect(ip).toBe('203.0.113.7');
    }
  });

  it('a loopback / private peer is our own proxy: its header is honoured', () => {
    expect(pickClientIp(headers({ 'x-real-ip': '198.51.100.3' }), { behindCloudflare: false, trustedHeader: 'x-real-ip', remoteAddr: '127.0.0.1' })).toBe('198.51.100.3');
    expect(pickClientIp(headers({ 'x-real-ip': '198.51.100.3' }), { behindCloudflare: false, trustedHeader: 'x-real-ip', remoteAddr: '::ffff:172.22.0.1' })).toBe('198.51.100.3');
    expect(pickClientIp(headers({ 'cf-connecting-ip': '1.2.3.4' }), { behindCloudflare: true, trustedHeader: 'x-real-ip', remoteAddr: '::1' })).toBe('1.2.3.4');
  });

  it('an empty TRUSTED_PROXY_HEADER disables header trust even from a private peer', () => {
    expect(pickClientIp(headers({ 'x-real-ip': '198.51.100.3' }), { behindCloudflare: false, trustedHeader: '', remoteAddr: '10.0.0.2' })).toBe('10.0.0.2');
  });

  it('normalizes IPv4-mapped IPv6 socket addresses', () => {
    expect(pickClientIp(headers({}), { behindCloudflare: false, trustedHeader: 'x-real-ip', remoteAddr: '::ffff:203.0.113.9' })).toBe('203.0.113.9');
  });

  it('clientIp reads the node-server socket (c.env.incoming.socket.remoteAddress)', () => {
    const c = { req: { header: (k: string) => ({ 'x-real-ip': '10.9.9.9' } as Record<string, string>)[k] }, env: { incoming: { socket: { remoteAddress: '203.0.113.20' } } } };
    expect(clientIp(c)).toBe('203.0.113.20');
  });
});

describe('admin credential-check gate (P1a)', () => {
  beforeEach(() => _setRateLimitBackendForTest(createMemoryRateLimitBackend()));
  afterEach(() => _setRateLimitBackendForTest(undefined));
  const reserveN = async (n: number, ip: (i: number) => string, acct: (i: number) => string) => {
    for (let i = 0; i < n; i++) expect(await reserveAdminAuthAttempt(ip(i), acct(i))).toBe(0);
  };

  it('per (ip, account): the 9th attempt from one IP for one account is refused', async () => {
    await reserveN(8, () => '198.51.100.1', () => 'a@x.test');
    expect(await reserveAdminAuthAttempt('198.51.100.1', 'a@x.test')).toBeGreaterThan(0);
    expect(await reserveAdminAuthAttempt('198.51.100.2', 'a@x.test')).toBe(0);
  });

  it('per account across IPs: 20 attempts from 20 IPs exhaust the account everywhere', async () => {
    await reserveN(20, (i) => `198.51.100.${i + 1}`, () => 'Victim@X.test');
    expect(await reserveAdminAuthAttempt('203.0.113.99', 'victim@x.test')).toBeGreaterThan(0);
    expect(await reserveAdminAuthAttempt('203.0.113.99', 'someone-else@x.test')).toBe(0);
  });

  it('per IP across accounts: 50 attempts over 50 e-mails exhaust the IP for every account', async () => {
    await reserveN(50, () => '198.51.100.50', (i) => `u${i}@x.test`);
    expect(await reserveAdminAuthAttempt('198.51.100.50', 'fresh@x.test')).toBeGreaterThan(0);
    expect(await reserveAdminAuthAttempt('198.51.100.51', 'fresh@x.test')).toBe(0);
  });

  it('a concurrent burst cannot all pass: exactly the budget is admitted', async () => {
    const results = await Promise.all(Array.from({ length: 30 }, () => reserveAdminAuthAttempt('198.51.100.77', 'burst@x.test')));
    expect(results.filter((r) => r === 0)).toHaveLength(8);
  });

  it('a password-verified success clears the account budget but not the per-IP budget', async () => {
    await reserveN(15, () => '198.51.100.60', (i) => `k${i % 2}@x.test`); // k0: 8, k1: 7 — at the pair cap
    await clearAdminAuthFailures('198.51.100.60', 'k0@x.test');
    await reserveN(10, (i) => `198.51.100.${70 + i}`, () => 'k0@x.test');
    expect(await reserveAdminAuthAttempt('198.51.100.60', 'k0@x.test')).toBe(0); // pair + account cleared; per-IP (16 of 50) kept
  });
});

describe('memory backend cleanup keeps each bucket\'s own window', () => {
  it('a 1-hour entry survives a global cleanup triggered by a 15-minute bucket', async () => {
    vi.useFakeTimers();
    try {
      const b = createMemoryRateLimitBackend();
      vi.setSystemTime(new Date('2026-10-15T10:00:00Z'));
      for (let i = 0; i < 20; i++) await b.recordFailure('hourly', 'acct', 60 * 60 * 1000);
      vi.setSystemTime(new Date('2026-10-15T10:30:00Z')); // 30 min later: outside 15 min, inside 1 h
      for (let i = 0; i < 5001; i++) await b.recordFailure('short', `k${i}`, 15 * 60 * 1000); // > 5000 keys -> cleanup
      expect(await b.check('hourly', 'acct', 60 * 60 * 1000, 20)).toBeGreaterThan(0);
    } finally { vi.useRealTimers(); }
  });
});

describe('TRUSTED_PROXY_CIDRS (P1a review)', () => {
  it('inCidrs matches exact IPs and CIDRs for v4 and v6, never malformed entries', () => {
    expect(inCidrs('203.0.113.7', ['203.0.113.0/24'])).toBe(true);
    expect(inCidrs('203.0.114.7', ['203.0.113.0/24'])).toBe(false);
    expect(inCidrs('198.51.100.9', ['198.51.100.9'])).toBe(true);
    expect(inCidrs('2001:db8::5', ['2001:db8::/32'])).toBe(true);
    expect(inCidrs('2001:db9::5', ['2001:db8::/32'])).toBe(false);
    expect(inCidrs('203.0.113.7', ['not-an-ip/8', '203.0.113.0/99'])).toBe(false);
  });

  it('a configured PUBLIC proxy is trusted for its header; another public client is not', () => {
    const opts = { behindCloudflare: false, trustedHeader: 'x-real-ip', trustedProxies: ['203.0.113.0/24'] };
    expect(pickClientIp(headers({ 'x-real-ip': '198.51.100.44' }), { ...opts, remoteAddr: '203.0.113.10' })).toBe('198.51.100.44');
    expect(pickClientIp(headers({ 'x-real-ip': '198.51.100.44' }), { ...opts, remoteAddr: '192.0.2.10' })).toBe('192.0.2.10');
    // once CIDRs are configured, an unlisted private peer is not implicitly trusted either
    expect(pickClientIp(headers({ 'x-real-ip': '198.51.100.44' }), { ...opts, remoteAddr: '10.0.0.5' })).toBe('10.0.0.5');
  });
});
