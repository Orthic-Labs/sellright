import { describe, expect, it } from 'vitest';
import { CUSTOMER_COOKIE_MAX_AGE_SECONDS } from './cookies.js';
import {
  CUSTOMER_SESSION_RENEW_WINDOW_MS,
  CUSTOMER_SESSION_TTL_MS,
  renewedSessionExpiry,
} from './session.js';

describe('customer session policy', () => {
  it('keeps native & browser sessions for one year', () => {
    expect(CUSTOMER_SESSION_TTL_MS).toBe(365 * 86_400_000);
    expect(CUSTOMER_COOKIE_MAX_AGE_SECONDS).toBe(365 * 86_400);
  });

  it('renews only inside final 30 days', () => {
    const now = Date.UTC(2026, 8, 9);
    expect(renewedSessionExpiry(new Date(now + CUSTOMER_SESSION_RENEW_WINDOW_MS + 1), now)).toBeNull();
    expect(renewedSessionExpiry(new Date(now + 86_400_000), now)?.getTime()).toBe(
      now + CUSTOMER_SESSION_TTL_MS,
    );
  });
});
