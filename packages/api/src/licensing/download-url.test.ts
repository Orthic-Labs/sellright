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
});
