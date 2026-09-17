import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isReleaseServiceToken } from './release-auth.js';

describe('release service authentication', () => {
  const token = 'sellright-release-test-token';
  const tokenHash = createHash('sha256').update(token).digest('hex');

  it('accepts the matching bearer token', () => {
    expect(isReleaseServiceToken(`Bearer ${token}`, tokenHash)).toBe(true);
  });

  it('rejects missing, malformed, and unrelated credentials', () => {
    expect(isReleaseServiceToken(undefined, tokenHash)).toBe(false);
    expect(isReleaseServiceToken(token, tokenHash)).toBe(false);
    expect(isReleaseServiceToken('Bearer expired-admin-session', tokenHash)).toBe(false);
    expect(isReleaseServiceToken(`Bearer ${token}`, undefined)).toBe(false);
    expect(isReleaseServiceToken(`Bearer ${token}`, 'not-a-sha256')).toBe(false);
  });
});
