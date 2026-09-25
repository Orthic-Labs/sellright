import { describe, it, expect } from 'vitest';
import {
  trialRetryAfter, recordTrialAttempt,
  licenseActionRetryAfter, recordLicenseAction,
  cartRetryAfter, recordCartAttempt,
} from './apps.limit.js';

// Unique IPs per test so the in-memory, per-process buckets never bleed
// between tests/files (same convention as auth/rate-limit.test.ts).
let n = 0;
const ip = () => `10.0.0.${++n % 250}`;

describe('trial rate limit (5/hr per ip+email)', () => {
  it('allows up to 5 attempts then blocks with a positive retryAfter', () => {
    const theIp = ip();
    for (let i = 0; i < 5; i++) {
      expect(trialRetryAfter(theIp, 'a@b.com')).toBe(0);
      recordTrialAttempt(theIp, 'a@b.com');
    }
    expect(trialRetryAfter(theIp, 'a@b.com')).toBeGreaterThan(0);
  });

  it('is keyed per (ip, email) — a different email on the same ip is unaffected', () => {
    const theIp = ip();
    for (let i = 0; i < 5; i++) recordTrialAttempt(theIp, 'used@up.com');
    expect(trialRetryAfter(theIp, 'used@up.com')).toBeGreaterThan(0);
    expect(trialRetryAfter(theIp, 'fresh@up.com')).toBe(0);
  });
});

describe('license action rate limit (20/15min per ip+licenseKey)', () => {
  it('allows up to 20 attempts then blocks', () => {
    const theIp = ip();
    for (let i = 0; i < 20; i++) {
      expect(licenseActionRetryAfter(theIp, 'KEY-1')).toBe(0);
      recordLicenseAction(theIp, 'KEY-1');
    }
    expect(licenseActionRetryAfter(theIp, 'KEY-1')).toBeGreaterThan(0);
  });

  it('is keyed per (ip, licenseKey) — a different key is unaffected', () => {
    const theIp = ip();
    for (let i = 0; i < 20; i++) recordLicenseAction(theIp, 'KEY-A');
    expect(licenseActionRetryAfter(theIp, 'KEY-A')).toBeGreaterThan(0);
    expect(licenseActionRetryAfter(theIp, 'KEY-B')).toBe(0);
  });
});

describe('cart rate limit (30/min per ip)', () => {
  it('allows up to 30 attempts then blocks', () => {
    const theIp = ip();
    for (let i = 0; i < 30; i++) {
      expect(cartRetryAfter(theIp)).toBe(0);
      recordCartAttempt(theIp);
    }
    expect(cartRetryAfter(theIp)).toBeGreaterThan(0);
  });

  it('is per-ip — a different ip is unaffected', () => {
    const theIp = ip();
    for (let i = 0; i < 30; i++) recordCartAttempt(theIp);
    expect(cartRetryAfter(theIp)).toBeGreaterThan(0);
    expect(cartRetryAfter(ip())).toBe(0);
  });
});
