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
  it('allows up to 5 attempts then blocks with a positive retryAfter', async () => {
    const theIp = ip();
    for (let i = 0; i < 5; i++) {
      expect(await trialRetryAfter(theIp, 'a@b.com')).toBe(0);
      await recordTrialAttempt(theIp, 'a@b.com');
    }
    expect(await trialRetryAfter(theIp, 'a@b.com')).toBeGreaterThan(0);
  });

  it('is keyed per (ip, email) — a different email on the same ip is unaffected', async () => {
    const theIp = ip();
    for (let i = 0; i < 5; i++) await recordTrialAttempt(theIp, 'used@up.com');
    expect(await trialRetryAfter(theIp, 'used@up.com')).toBeGreaterThan(0);
    expect(await trialRetryAfter(theIp, 'fresh@up.com')).toBe(0);
  });
});

describe('license action rate limit (20/15min per ip+licenseKey)', () => {
  it('allows up to 20 attempts then blocks', async () => {
    const theIp = ip();
    for (let i = 0; i < 20; i++) {
      expect(await licenseActionRetryAfter(theIp, 'KEY-1')).toBe(0);
      await recordLicenseAction(theIp, 'KEY-1');
    }
    expect(await licenseActionRetryAfter(theIp, 'KEY-1')).toBeGreaterThan(0);
  });

  it('is keyed per (ip, licenseKey) — a different key is unaffected', async () => {
    const theIp = ip();
    for (let i = 0; i < 20; i++) await recordLicenseAction(theIp, 'KEY-A');
    expect(await licenseActionRetryAfter(theIp, 'KEY-A')).toBeGreaterThan(0);
    expect(await licenseActionRetryAfter(theIp, 'KEY-B')).toBe(0);
  });
});

describe('cart rate limit (60/min per ip)', () => {
  it('allows up to 60 attempts then blocks', async () => {
    const theIp = ip();
    for (let i = 0; i < 60; i++) {
      expect(await cartRetryAfter(theIp)).toBe(0);
      await recordCartAttempt(theIp);
    }
    expect(await cartRetryAfter(theIp)).toBeGreaterThan(0);
  });

  it('is per-ip — a different ip is unaffected', async () => {
    const theIp = ip();
    for (let i = 0; i < 60; i++) await recordCartAttempt(theIp);
    expect(await cartRetryAfter(theIp)).toBeGreaterThan(0);
    expect(await cartRetryAfter(ip())).toBe(0);
  });
});
