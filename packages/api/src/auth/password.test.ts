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
