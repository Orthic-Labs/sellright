import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashPassword, passwordNeedsRehash, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('stores new passwords as Argon2id PHC strings', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u);
    expect(passwordNeedsRehash(hash)).toBe(false);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong password', hash)).toBe(false);
  });

  it('uses a unique random salt for every hash', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same password'),
      hashPassword('same password'),
    ]);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same password', a)).toBe(true);
    expect(await verifyPassword('same password', b)).toBe(true);
  });

  it('fails closed for malformed or unsupported hashes', async () => {
    expect(await verifyPassword('password', null)).toBe(false);
    expect(await verifyPassword('password', '')).toBe(false);
    expect(await verifyPassword('password', '$argon2id$v=19$m=999999999,t=2,p=1$AAAA$AAAA')).toBe(false);
    expect(await verifyPassword('password', '$2b$12$not-a-sellright-hash')).toBe(false);
  });

  it('can verify SellRight legacy scrypt hashes and marks them for upgrade', async () => {
    const password = 'legacy sellright password';
    const salt = randomBytes(16);
    const derived = scryptSync(password, salt, 64);
    const legacy = `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;

    expect(await verifyPassword(password, legacy)).toBe(true);
    expect(await verifyPassword('wrong', legacy)).toBe(false);
    expect(passwordNeedsRehash(legacy)).toBe(true);
  });
});

describe('verifyPasswordBounded (P8 / G6)', async () => {
  const { verifyPasswordBounded, _passwordVerifyGateForTest } = await import('./password.js');
  it('verifies like verifyPassword and releases its slot', async () => {
    const hash = await hashPassword('bounded secret');
    expect(await verifyPasswordBounded('bounded secret', hash)).toBe(true);
    expect(await verifyPasswordBounded('wrong', hash)).toBe(false);
    expect(await verifyPasswordBounded('x', null)).toBe(false);
    expect(_passwordVerifyGateForTest()).toMatchObject({ active: 0, queued: 0 });
  });
  it('refuses with busy (never false) once the bounded queue is full, then drains', async () => {
    const hash = await hashPassword('flood');
    const { maxConcurrent, maxQueued } = _passwordVerifyGateForTest();
    const results = await Promise.all(Array.from({ length: maxConcurrent + maxQueued + 5 }, () => verifyPasswordBounded('flood', hash)));
    expect(results.filter((r) => r === 'busy')).toHaveLength(5);
    expect(results.filter((r) => r === true)).toHaveLength(maxConcurrent + maxQueued);
    expect(_passwordVerifyGateForTest()).toMatchObject({ active: 0, queued: 0 });
  }, 60_000);
});
