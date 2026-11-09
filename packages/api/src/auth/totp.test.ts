import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { codesEqual, matchTotpStep, newTotpSecret, verifyTotp } from './totp.js';

describe('codesEqual', () => {
  it('matches identical codes and rejects different or different-length values', () => {
    expect(codesEqual('123456', '123456')).toBe(true);
    expect(codesEqual('123456', '123457')).toBe(false);
    expect(codesEqual('123456', '12345')).toBe(false);
    expect(codesEqual('', '123456')).toBe(false);
  });
});

describe('totp verification', () => {
  const secret = newTotpSecret();
  const current = () => {
    const step = matchTotpStepFor(secret);
    return step;
  };
  function matchTotpStepFor(s: string): string {
    // Find the code for the current step by probing all 6-digit codes is impractical; derive it from the RFC algorithm.
    const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const ch of s) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
    const bytes = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2)));
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const h = createHmac('sha1', bytes).update(buf).digest();
    const o = h[h.length - 1]! & 0xf;
    const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
    return (n % 1_000_000).toString().padStart(6, '0');
  }

  it('accepts the current code and rejects a wrong or malformed one', () => {
    const code = current();
    expect(matchTotpStep(secret, code)).not.toBeNull();
    expect(verifyTotp(secret, code)).toBe(true);
    const wrong = code === '000000' ? '000001' : '000000';
    expect(verifyTotp(secret, wrong)).toBe(false);
    expect(verifyTotp(secret, '12345')).toBe(false);
    expect(matchTotpStep(secret, 'abcdef')).toBeNull();
  });
});
