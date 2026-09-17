/**
 * Unit tests for the customer-session policy (ported upstream from RightSites,
 * generalized: per-store config `auth.*` over env defaults instead of one
 * hardcoded suite policy). No DB — pure resolution + decision logic.
 *
 * Covers:
 *   1. SellRight defaults stay 30-day / non-renewable (RightSites' 1-year
 *      sliding sessions are a downstream choice, not the upstream default).
 *   2. store.config.auth.* overrides the env defaults.
 *   3. renewedSessionExpiry renews only inside the window and only ever
 *      EXTENDS (a window >= ttl must not shorten a session).
 *   4. The customer cookie Max-Age tracks the env session TTL.
 */
import { describe, expect, it } from 'vitest';
import { renewedSessionExpiry, sessionPolicy } from './session.js';
import { CUSTOMER_COOKIE_MAX_AGE_SECONDS } from './cookies.js';
import { env } from '../env.js';

const DAY = 86_400_000;

describe('sessionPolicy', () => {
  it('defaults to the historical SellRight posture (30d, non-renewable)', () => {
    const p = sessionPolicy(undefined);
    expect(p.ttlMs).toBe(30 * DAY);
    expect(p.renewable).toBe(false);
    expect(p.renewWindowMs).toBe(7 * DAY);
    expect(env.SESSION_TTL_DAYS).toBe(30);
    expect(env.SESSION_RENEWABLE).toBe('false');
    expect(env.SESSION_RENEW_WINDOW_DAYS).toBe(7);
  });

  it('ignores a config without an auth section', () => {
    expect(sessionPolicy(null).ttlMs).toBe(30 * DAY);
    expect(sessionPolicy({ storefrontUrl: 'https://x.example' }).renewable).toBe(false);
    expect(sessionPolicy({ auth: 'not-an-object' }).renewable).toBe(false);
  });

  it('lets a store override ttl / renewable / window via config.auth', () => {
    const p = sessionPolicy({ auth: { sessionTtlDays: 365, renewable: true, sessionRenewWindowDays: 30 } });
    expect(p).toEqual({ ttlMs: 365 * DAY, renewable: true, renewWindowMs: 30 * DAY });
  });

  it('lets a store explicitly disable renewal even if the env enabled it', () => {
    expect(sessionPolicy({ auth: { renewable: false } }).renewable).toBe(false);
  });

  it('rejects non-positive/garbage config values (falls back to env)', () => {
    const p = sessionPolicy({ auth: { sessionTtlDays: -5, sessionRenewWindowDays: 'x' } });
    expect(p.ttlMs).toBe(30 * DAY);
    expect(p.renewWindowMs).toBe(7 * DAY);
  });
});

describe('renewedSessionExpiry', () => {
  const renewable = { ttlMs: 365 * DAY, renewable: true, renewWindowMs: 30 * DAY };
  const now = Date.UTC(2026, 8, 9);

  it('returns null when the policy is not renewable', () => {
    const p = { ttlMs: 30 * DAY, renewable: false, renewWindowMs: 7 * DAY };
    expect(renewedSessionExpiry(new Date(now + DAY), now, p)).toBeNull();
  });

  it('renews only inside the renew window', () => {
    expect(renewedSessionExpiry(new Date(now + 30 * DAY + 1), now, renewable)).toBeNull(); // outside
    expect(renewedSessionExpiry(new Date(now + DAY), now, renewable)?.getTime()).toBe(now + 365 * DAY); // inside
  });

  it('never shortens a session when window >= ttl', () => {
    const sliding = { ttlMs: 30 * DAY, renewable: true, renewWindowMs: 60 * DAY };
    // inside the window but already past now+ttl → no write, expiry stands
    expect(renewedSessionExpiry(new Date(now + 45 * DAY), now, sliding)).toBeNull();
    expect(renewedSessionExpiry(new Date(now + 10 * DAY), now, sliding)?.getTime()).toBe(now + 30 * DAY);
  });
});

describe('customer cookie lifetime', () => {
  it('tracks the env session TTL (cookie never dies before the session)', () => {
    expect(CUSTOMER_COOKIE_MAX_AGE_SECONDS).toBe(Math.ceil(env.SESSION_TTL_DAYS * 24 * 3600));
    expect(CUSTOMER_COOKIE_MAX_AGE_SECONDS).toBe(30 * 86_400);
  });
});
