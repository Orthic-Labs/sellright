import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptA = promisify(scrypt);
const KEYLEN = 64;

/** scrypt password hash, self-describing: `scrypt$<saltHex>$<hashHex>`. No external dep. */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = (await scryptA(pw, salt, KEYLEN)) as Buffer;
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}

export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const dk = (await scryptA(pw, Buffer.from(saltHex, 'hex'), KEYLEN)) as Buffer;
  return dk.length === expected.length && timingSafeEqual(dk, expected);
}
