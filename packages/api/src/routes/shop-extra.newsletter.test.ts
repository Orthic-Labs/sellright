import { describe, expect, it } from 'vitest';
import { assertSafeOutboundUrl, safeOutboundFetch } from '../security/outbound-url.js';
import { newsletterRetryAfter, recordNewsletterAttempt } from './shop-extra.newsletter-limit.js';

/**
 * Unit-level coverage for SEC-1: the public, unauthenticated
 * POST /v1/shop/newsletter-signup handler now (a) routes its Listmonk fetch
 * through the SSRF guard instead of a raw fetch(), and (b) is rate-limited
 * per IP. Both are exercised here without a database or a live network
 * endpoint — see shop-extra.ts for the wiring.
 */
describe('newsletter-signup SSRF guard', () => {
  it('refuses a loopback/private Listmonk URL the same way admin-marketing does', async () => {
    await expect(assertSafeOutboundUrl('http://127.0.0.1/api/subscribers')).rejects.toThrow(/private/);
    await expect(assertSafeOutboundUrl('http://localhost:9000/api/subscribers')).rejects.toThrow(/private/);
    await expect(assertSafeOutboundUrl('http://169.254.169.254/api/subscribers')).rejects.toThrow(/private/);
  });

  it('safeOutboundFetch rejects the same private target before any request is attempted', async () => {
    let requests = 0;
    await expect(safeOutboundFetch('http://127.0.0.1/api/subscribers', {
      method: 'POST',
      headers: { authorization: 'Basic dGVzdDp0ZXN0', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.com' }),
    }, {
      request: async () => {
        requests++;
        return new Response('should not be reached', { status: 200 });
      },
    })).rejects.toThrow(/private/);
    expect(requests).toBe(0);
  });

  it('allows a public Listmonk host to resolve and pins the DNS-checked address', async () => {
    const seen: string[] = [];
    const response = await safeOutboundFetch('https://listmonk.example.com/api/subscribers', {
      method: 'POST',
      headers: { authorization: 'Basic dGVzdDp0ZXN0', 'content-type': 'application/json' },
    }, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: async (_url, _init, connect) => {
        seen.push(connect.address);
        return new Response('ok', { status: 200 });
      },
    });
    expect(response.status).toBe(200);
    expect(seen).toEqual(['93.184.216.34']);
  });
});

describe('newsletter-signup rate limit bucket', () => {
  it('allows attempts under the threshold and blocks once exceeded, with a retry-after', () => {
    const ip = `test-ip-${Math.random()}`;
    for (let i = 0; i < 5; i++) {
      expect(newsletterRetryAfter(ip)).toBe(0);
      recordNewsletterAttempt(ip);
    }
    const retry = newsletterRetryAfter(ip);
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(15 * 60);
  });

  it('tracks separate IPs independently', () => {
    const ipA = `test-ip-a-${Math.random()}`;
    const ipB = `test-ip-b-${Math.random()}`;
    for (let i = 0; i < 5; i++) recordNewsletterAttempt(ipA);
    expect(newsletterRetryAfter(ipA)).toBeGreaterThan(0);
    expect(newsletterRetryAfter(ipB)).toBe(0);
  });
});
