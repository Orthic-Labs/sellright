import { describe, expect, it } from 'vitest';
import { computeSig, verifyWithSecret } from './download-url.js';

const SECRET = 'test-download-secret';
const STORE = '11111111-1111-1111-1111-111111111111';
const KEY = 'app-v1.2.3-win-x64.zip';
const future = () => Math.floor(Date.now() / 1000) + 900;

describe('download-url signing', () => {
  it('round-trips a valid signature', () => {
    const exp = future();
    const sig = computeSig(SECRET, STORE, KEY, exp);
    expect(verifyWithSecret(SECRET, STORE, KEY, exp, sig)).toBe(true);
  });

  it('rejects an expired link', () => {
    const exp = Math.floor(Date.now() / 1000) - 1;
    const sig = computeSig(SECRET, STORE, KEY, exp);
    expect(verifyWithSecret(SECRET, STORE, KEY, exp, sig)).toBe(false);
  });

  it('rejects a tampered store, artifact, or exp (signature binds all three)', () => {
    const exp = future();
    const sig = computeSig(SECRET, STORE, KEY, exp);
    expect(verifyWithSecret(SECRET, '22222222-2222-2222-2222-222222222222', KEY, exp, sig)).toBe(false);
    expect(verifyWithSecret(SECRET, STORE, 'other-artifact.zip', exp, sig)).toBe(false);
    expect(verifyWithSecret(SECRET, STORE, KEY, exp + 600, sig)).toBe(false); // extend expiry → invalid
  });

  it('rejects a wrong secret', () => {
    const exp = future();
    const sig = computeSig('a-different-secret', STORE, KEY, exp);
    expect(verifyWithSecret(SECRET, STORE, KEY, exp, sig)).toBe(false);
  });

  it('rejects when no secret is configured (fail-closed)', () => {
    const exp = future();
    expect(verifyWithSecret(undefined, STORE, KEY, exp, 'anything')).toBe(false);
  });

  it('rejects garbage / non-numeric exp', () => {
    expect(verifyWithSecret(SECRET, STORE, KEY, NaN, 'x')).toBe(false);
    expect(verifyWithSecret(SECRET, STORE, KEY, future(), 'not-a-real-sig')).toBe(false);
  });

  describe('release binding', () => {
    const REL = '33333333-3333-3333-3333-333333333333';
    const NEWER = '44444444-4444-4444-4444-444444444444';
    const verify = (exp: number, sig: string, rel?: string) => verifyWithSecret(SECRET, STORE, KEY, exp, sig, Date.now(), rel);

    it('round-trips a release-bound signature', () => {
      const exp = future();
      expect(verify(exp, computeSig(SECRET, STORE, KEY, exp, REL), REL)).toBe(true);
    });

    it('rejects a link presented for another release, or with the release stripped or added', () => {
      const exp = future();
      const bound = computeSig(SECRET, STORE, KEY, exp, REL);
      expect(verify(exp, bound, NEWER)).toBe(false);
      expect(verify(exp, bound)).toBe(false);
      expect(verify(exp, computeSig(SECRET, STORE, KEY, exp), REL)).toBe(false);
    });

    it('still verifies a legacy (release-less) link until it expires', () => {
      const exp = future();
      expect(verify(exp, computeSig(SECRET, STORE, KEY, exp))).toBe(true);
      const expired = Math.floor(Date.now() / 1000) - 1;
      expect(verify(expired, computeSig(SECRET, STORE, KEY, expired))).toBe(false);
    });

    it('a release-bound payload cannot collide with a legacy payload for a different artifactKey', () => {
      const exp = future();
      expect(computeSig(SECRET, STORE, KEY, exp, REL)).not.toBe(computeSig(SECRET, STORE, `${KEY}:${REL}`, exp));
    });
  });
});
