// #355 phase 2: the hub's vault for target sessions. AES-256-GCM with a random 96-bit IV per seal, and associated data
// that binds each ciphertext to its row (purpose, row id, hub session, target): a sealed value copied to another row
// does not open.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { HubVaultKey } from './hub-config.js';

export interface Sealed { v: number; iv: string; ct: string; tag: string }

export function seal(keys: readonly HubVaultKey[], plaintext: string, aad: string): Sealed {
  const k = keys.at(-1);
  if (!k) throw new Error('hub vault has no key');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k.key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return { v: k.version, iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
}

/** Opens a sealed value, or throws: unknown key version, a different row binding, or tampering. */
export function open(keys: readonly HubVaultKey[], sealed: Sealed, aad: string): string {
  const k = keys.find((x) => x.version === sealed.v);
  if (!k) throw new Error('hub vault key version not available');
  const d = createDecipheriv('aes-256-gcm', k.key, Buffer.from(sealed.iv, 'base64'));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(sealed.ct, 'base64')), d.final()]).toString('utf8');
}
