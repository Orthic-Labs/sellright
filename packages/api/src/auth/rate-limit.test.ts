import { describe, expect, it } from 'vitest';
import { pickClientIp } from './rate-limit.js';

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
