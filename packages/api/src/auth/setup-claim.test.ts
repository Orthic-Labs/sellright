import { describe, expect, it } from 'vitest';
import { generateClaimToken, hashClaimToken } from './setup-claim.js';

describe('setup claim token primitives', () => {
  it('generates a 128-bit (32 hex char) token', () => {
    const token = generateClaimToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('generates distinct tokens', () => {
    expect(generateClaimToken()).not.toBe(generateClaimToken());
  });

  it('hashes deterministically to a sha256 hex digest', () => {
    const token = generateClaimToken();
    expect(hashClaimToken(token)).toBe(hashClaimToken(token));
    expect(hashClaimToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashClaimToken(token)).not.toBe(token);
  });
});
