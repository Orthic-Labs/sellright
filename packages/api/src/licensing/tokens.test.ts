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
});
