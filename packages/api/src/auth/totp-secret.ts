/**
 * Encryption at rest for admin_user.totp_secret (P1b, security audit 2026-10-15).
 *
 * Reuses the SELLRIGHT_MASTER_KEY mechanism (security/secret-crypto.ts: HKDF-derived per-purpose key,
 * AES-256-GCM, purpose bound as AAD). The purpose is per admin (`admin:<id>:totp`), so a sealed value
 * copied onto another admin's row does not decrypt.
 *
 * Stored format: `enc1:<base64url(JSON EncryptedSecret)>` in the existing text column. Anything without
 * the prefix is a legacy plaintext base32 secret and is still accepted (backward compatible); the API
 * seals such rows at start (sealLegacyTotpSecrets) once a master key is configured. With no master key
 * (dev installs) new secrets are stored as before — plaintext — and a warning is logged once.
 */
import { and, isNotNull, not, like, eq } from 'drizzle-orm';
import { unsafeUnscopedDb as db } from '../db/client.js';
import * as s from '../db/schema.js';
import { decryptSecret, encryptSecret, type EncryptedSecret } from '../security/secret-crypto.js';
import { log } from '../lib/logger.js';
import { peekEnv } from '../env.js';

const PREFIX = 'enc1:';
const purpose = (adminId: string) => `admin:${adminId}:totp`;

function masterKeyConfigured(): boolean {
  const configured = peekEnv();
  const raw = configured ? configured.SELLRIGHT_MASTER_KEY : process.env.SELLRIGHT_MASTER_KEY;
  return !!raw?.trim();
}

let warned = false;

/** Value to persist for a new TOTP secret. */
export function sealTotpSecret(adminId: string, secretB32: string): string {
  if (!masterKeyConfigured()) {
    if (!warned) { warned = true; log.info('SELLRIGHT_MASTER_KEY is not set — admin TOTP secrets are stored unencrypted'); }
    return secretB32;
  }
  const sealed = encryptSecret(secretB32, { purpose: purpose(adminId) });
  return PREFIX + Buffer.from(JSON.stringify(sealed), 'utf8').toString('base64url');
}

/** True when the stored value is sealed (vs legacy plaintext). */
export function isSealedTotpSecret(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

/** Plaintext base32 secret from the stored value, or null when absent. Throws (fails closed) when a
 *  sealed value cannot be opened — wrong/missing master key or tampering — rather than treating the
 *  account as having no second factor. */
export function openTotpSecret(adminId: string, stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!isSealedTotpSecret(stored)) return stored;
  const sealed = JSON.parse(Buffer.from(stored.slice(PREFIX.length), 'base64url').toString('utf8')) as EncryptedSecret;
  return decryptSecret(sealed, purpose(adminId));
}

/** Seal every legacy plaintext TOTP secret (idempotent; a row is only rewritten if it still holds the
 *  exact plaintext that was read). No-op without a master key. Returns the number sealed. */
export async function sealLegacyTotpSecrets(): Promise<number> {
  if (!masterKeyConfigured()) return 0;
  const rows = await db
    .select({ id: s.adminUser.id, totpSecret: s.adminUser.totpSecret })
    .from(s.adminUser)
    .where(and(isNotNull(s.adminUser.totpSecret), not(like(s.adminUser.totpSecret, `${PREFIX}%`))));
  let n = 0;
  for (const r of rows) {
    const updated = await db
      .update(s.adminUser)
      .set({ totpSecret: sealTotpSecret(r.id, r.totpSecret!) })
      .where(and(eq(s.adminUser.id, r.id), eq(s.adminUser.totpSecret, r.totpSecret!)))
      .returning({ id: s.adminUser.id });
    n += updated.length;
  }
  return n;
}

/** Rollback helper: rewrite sealed secrets back to plaintext (for running an older engine). */
export async function unsealAllTotpSecrets(): Promise<number> {
  const rows = await db
    .select({ id: s.adminUser.id, totpSecret: s.adminUser.totpSecret })
    .from(s.adminUser)
    .where(like(s.adminUser.totpSecret, `${PREFIX}%`));
  let n = 0;
  for (const r of rows) {
    const updated = await db
      .update(s.adminUser)
      .set({ totpSecret: openTotpSecret(r.id, r.totpSecret) })
      .where(and(eq(s.adminUser.id, r.id), eq(s.adminUser.totpSecret, r.totpSecret!)))
      .returning({ id: s.adminUser.id });
    n += updated.length;
  }
  return n;
}
