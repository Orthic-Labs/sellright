/**
 * WS-A: encryption at rest for owner-entered secrets (Stripe/NMI/Sezzle keys,
 * SMTP passwords, ...). AES-256-GCM with a per-write random 96-bit IV; the key
 * itself is never used directly — it's an HKDF-SHA256 master key from which a
 * per-purpose data-encryption key is derived (RFC 5869), so one leaked derived
 * key never exposes the master key or another purpose's key.
 *
 * `SELLRIGHT_MASTER_KEY` (32+ bytes, base64 or hex) is infra-only and lives in
 * the environment (never the database). Rotation: bump CURRENT_KEY_VERSION and
 * add the new/old key to `keyForVersion`; ciphertexts carry their key version
 * so old rows keep decrypting under the retired key until re-encrypted by
 * `rotateSecret`.
 *
 * Fail closed: any encrypt/decrypt call with no master key configured throws —
 * it never silently stores plaintext or returns a fabricated value. Decrypted
 * plaintext is never logged; callers must return only `last4` to the admin UI.
 */
import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';

export const CURRENT_KEY_VERSION = 1;

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // 96-bit GCM nonce, NIST-recommended
const KEY_LEN = 32; // AES-256

export interface EncryptedSecret {
  /** Key version this ciphertext was sealed under (for rotation). */
  v: number;
  /** base64 96-bit IV. */
  iv: string;
  /** base64 ciphertext. */
  ct: string;
  /** base64 128-bit GCM auth tag. */
  tag: string;
}

function parseMasterKey(raw: string): Buffer {
  // Accept hex or base64; require >=32 bytes of entropy either way.
  let buf: Buffer;
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
    buf = Buffer.from(raw, 'hex');
  } else {
    buf = Buffer.from(raw, 'base64');
  }
  if (buf.length < 32) {
    throw new Error('SELLRIGHT_MASTER_KEY must decode to at least 32 bytes (hex or base64)');
  }
  return buf;
}

function loadMasterKey(): Buffer {
  const raw = process.env.SELLRIGHT_MASTER_KEY;
  if (!raw || raw.trim() === '') {
    throw new Error('SELLRIGHT_MASTER_KEY is not configured — refusing to encrypt/decrypt secrets');
  }
  return parseMasterKey(raw.trim());
}

/**
 * HKDF-SHA256 (RFC 5869) deriving a 32-byte key for `purpose` (e.g.
 * "store-secret:v1") from the master key. `purpose` doubles as the HKDF
 * `info` parameter so different call sites never share a derived key even if
 * they share a master key and salt.
 */
export function deriveKey(masterKey: Buffer, purpose: string, keyVersion: number = CURRENT_KEY_VERSION): Buffer {
  const salt = createHash('sha256').update(`sellright:secret-crypto:v${keyVersion}`).digest();
  // extract
  const prk = createHmac('sha256', salt).update(masterKey).digest();
  // expand (single 32-byte block is enough for AES-256)
  const info = Buffer.from(purpose, 'utf8');
  const t1 = createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([0x01])])).digest();
  return t1.subarray(0, KEY_LEN);
}

export interface EncryptOptions {
  /** Logical purpose / AAD binding, e.g. `store:<id>:stripe:test:secretKey`.
   *  Bound as GCM additional authenticated data AND as the HKDF info string,
   *  so a ciphertext can't be copy-pasted into a different field/store and
   *  still decrypt. */
  purpose: string;
  keyVersion?: number;
  masterKey?: Buffer;
}

export function encryptSecret(plaintext: string, opts: EncryptOptions): EncryptedSecret {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encryptSecret: plaintext must be a non-empty string');
  }
  const keyVersion = opts.keyVersion ?? CURRENT_KEY_VERSION;
  const masterKey = opts.masterKey ?? loadMasterKey();
  const key = deriveKey(masterKey, opts.purpose, keyVersion);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(Buffer.from(opts.purpose, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { v: keyVersion, iv: iv.toString('base64'), ct: ct.toString('base64'), tag: tag.toString('base64') };
}

export function decryptSecret(sealed: EncryptedSecret, purpose: string, masterKey?: Buffer): string {
  const mk = masterKey ?? loadMasterKey();
  const key = deriveKey(mk, purpose, sealed.v);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAAD(Buffer.from(purpose, 'utf8'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}

/** Re-seal an existing secret under CURRENT_KEY_VERSION (rotation helper). No-op
 *  (returns the input unchanged, by value) if already current. */
export function rotateSecret(sealed: EncryptedSecret, purpose: string, masterKey?: Buffer): EncryptedSecret {
  if (sealed.v === CURRENT_KEY_VERSION) return { ...sealed };
  const plaintext = decryptSecret(sealed, purpose, masterKey);
  return encryptSecret(plaintext, { purpose, masterKey });
}

/** Last 4 characters only — the sole representation of a secret the admin API
 *  may ever return. Never returns enough to reconstruct or brute-force meaningfully. */
export function last4(plaintext: string): string {
  return plaintext.slice(-4);
}

/** Constant-time check that a freshly-verified key matches what's already
 *  stored, without decrypting/logging either full value where avoidable. */
export function secretsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
