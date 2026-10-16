/**
 * Secret-material fingerprints for the read-only config projection (plan 2.7).
 * Nothing here ever returns, logs or derives a reversible form of a secret:
 *
 *  - public keys: sha256 of the SPKI DER (the public key is not secret, the full digest is fine);
 *  - symmetric keys: HMAC-SHA256 KEYED BY A PER-INSTALLATION RANDOM SALT (>= 32 bytes, stored in
 *    the database, never derived from a secret, never returned), message = label + secret,
 *    truncated. Runtimes sharing the database produce equal values for equal secrets (7.1), yet a
 *    weak secret cannot be confirmed offline from the endpoint output;
 *  - bearer credentials / digests: sha256 prefix.
 */
import { createHash, createHmac, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

const DOMAIN = 'sellright/config/v1:';
const HMAC_HEX_CHARS = 16;
const SHA_PREFIX_CHARS = 12;

export interface Fingerprinted {
  /** Whether the value is configured at all. */
  set: boolean;
  /** Fingerprint, or null when unset. */
  fingerprint: string | null;
}

/** Full sha256 hex of a public key's SPKI DER. Accepts a KeyObject or a PEM (public or private). */
export function publicKeyFingerprint(key: KeyObject | string): string {
  const pub = typeof key === 'string'
    ? createPublicKey(key.includes('PRIVATE KEY') ? createPrivateKey(key) : key)
    : key.type === 'private' ? createPublicKey(key) : key;
  const der = pub.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

/**
 * Salted HMAC fingerprint of a symmetric secret. `salt` is the per-installation random
 * salt (>= 32 bytes, stored server-side, see installation-salt.ts) used as the HMAC KEY;
 * the secret is only message input. Without the salt the value cannot be confirmed
 * against a guessed secret, and the salt is never derived from any secret.
 */
export function hmacFingerprint(secret: string, label: string, salt: string): string {
  if (Buffer.byteLength(salt, 'utf8') < 32) throw new Error('fingerprint salt must be at least 32 bytes');
  return createHmac('sha256', salt).update(`${DOMAIN}${label}\0${secret}`).digest('hex').slice(0, HMAC_HEX_CHARS);
}

/** sha256 prefix, for release credentials and other bearer material. */
export function sha256Prefix(value: string, chars: number = SHA_PREFIX_CHARS): string {
  return createHash('sha256').update(value).digest('hex').slice(0, chars);
}

export function fingerprintSymmetric(secret: string | undefined, label: string, salt: string): Fingerprinted {
  return secret ? { set: true, fingerprint: hmacFingerprint(secret, label, salt) } : { set: false, fingerprint: null };
}

export function fingerprintSha256(value: string | undefined): Fingerprinted {
  return value ? { set: true, fingerprint: sha256Prefix(value) } : { set: false, fingerprint: null };
}

export function fingerprintPublicKey(key: KeyObject | string | null | undefined): Fingerprinted {
  return key ? { set: true, fingerprint: publicKeyFingerprint(key) } : { set: false, fingerprint: null };
}

/** Salt-free helpers, handed to plugins as `ctx.fingerprint`. */
export const fingerprint = {
  publicKey: fingerprintPublicKey,
  sha256Prefix: fingerprintSha256,
} as const;
export type FingerprintHelpers = typeof fingerprint;

/** Helpers bound to the installation salt; passed to `effectiveConfig(ctx, fp)`. */
export interface SaltedFingerprints extends FingerprintHelpers {
  /** Salted HMAC fingerprint of a symmetric secret (`label` names which secret; it is public). */
  symmetric(secret: string | undefined, label: string): Fingerprinted;
}
export function saltedFingerprints(salt: string): SaltedFingerprints {
  return { ...fingerprint, symmetric: (secret, label) => fingerprintSymmetric(secret, label, salt) };
}
