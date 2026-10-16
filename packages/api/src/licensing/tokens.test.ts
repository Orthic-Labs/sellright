import { describe, expect, it } from 'vitest';
import { bearerToken, hashActivationToken, newActivationToken } from './tokens.js';

describe('activation tokens', () => {
  it('generates opaque tokens that can be stored as stable hashes', () => {
    const first = newActivationToken();
    const second = newActivationToken();

    expect(first).toMatch(/^sr_act_[A-Za-z0-9_-]{32,}$/);
    expect(second).toMatch(/^sr_act_[A-Za-z0-9_-]{32,}$/);
    expect(second).not.toBe(first);
    expect(hashActivationToken(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashActivationToken(first)).toBe(hashActivationToken(first));
    expect(hashActivationToken(second)).not.toBe(hashActivationToken(first));
  });

  it('extracts bearer authorization tokens without accepting other schemes', () => {
    expect(bearerToken('Bearer sr_act_example')).toBe('sr_act_example');
    expect(bearerToken('bearer   sr_act_example  ')).toBe('sr_act_example');
    expect(bearerToken('Basic sr_act_example')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });

  it('bearerToken matches the original /^Bearer\\s+(.+)$/i + trim on edge cases and stays linear', () => {
    const legacy = (h: string | undefined) => /^Bearer\s+(.+)$/i.exec(h ?? '')?.[1]?.trim() || null;
    const cases = ['', 'Bearer', 'Bearer ', 'Bearer  ', 'Bearertok', 'BEARER\ttok', ' Bearer tok', 'Bearer \n tok', 'Bearer to\nk',
      'Bearer tok\n', 'Bearer a b ', 'bearer \u00a0tok', 'Bearer \u2028tok', 'xBearer tok', 'Bearer \r\n'];
    for (const c of cases) expect(bearerToken(c), JSON.stringify(c)).toBe(legacy(c));
    const hostile = `Bearer ${' '.repeat(200_000)}\n`;
    const t0 = Date.now();
    expect(bearerToken(hostile)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(200);
  });
});
