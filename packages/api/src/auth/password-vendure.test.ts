import { describe, expect, it } from 'vitest';
import { hashSync } from 'bcryptjs';
import { hashPassword, passwordNeedsRehash, verifyPassword } from './password.js';

describe('Vendure password continuity', () => {
  const password = 'Migrated customer password';
  const imported = hashSync(password, 4);
  it('verifies imported bcrypt and requests native rehash only after successful login', async () => {
    expect(await verifyPassword(password, imported)).toBe(true);
    expect(await verifyPassword('wrong password', imported)).toBe(false);
    expect(passwordNeedsRehash(imported)).toBe(true);
    const native = await hashPassword(password);
    expect(await verifyPassword(password, native)).toBe(true);
    expect(passwordNeedsRehash(native)).toBe(false);
  });
  it('rejects unbounded work factors and malformed hashes', async () => {
    expect(await verifyPassword(password, imported.replace('$04$', '$31$'))).toBe(false);
    expect(await verifyPassword(password, imported + 'extra')).toBe(false);
  });
});
