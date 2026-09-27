/**
 * WS-A (one-click install plan §1.6): one resolver for "where does this
 * provider credential come from" — environment variables ALWAYS win over the
 * database (existing deployments keep working unmodified; the admin UI must
 * show such a field as "managed by server configuration" and refuse to edit
 * it). Only when the environment has nothing does a value come from the
 * encrypted `store_secret` table.
 *
 * This module owns the precedence decision and the DB read + decrypt; it does
 * NOT know about any provider's specific env var names — each provider module
 * keeps deciding that for itself (e.g. stripe.ts's `stripeCreds()`), and calls
 * `resolveField` only when its own env lookup came back empty.
 */
import { eq, and } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { storeSecret } from '../db/schema-settings.js';
import { decryptSecret, type EncryptedSecret } from './secret-crypto.js';

export type SecretSource = 'env' | 'db' | 'unset';

export interface ResolvedSecret {
  value: string;
  source: SecretSource;
}

export interface FieldScope {
  storeId: string;
  provider: 'stripe' | 'nmi' | 'sezzle' | 'smtp';
  mode: string; // 'test' | 'live' | 'sandbox' | 'production' | 'default'
  field: string;
}

function purposeFor(scope: FieldScope): string {
  return `store:${scope.storeId}:${scope.provider}:${scope.mode}:${scope.field}`;
}

/**
 * Resolve one credential field with env>db precedence. `envValue` is whatever
 * the caller's own env lookup produced (or undefined). Only reads the
 * database when `envValue` is missing, so an env-configured deployment never
 * pays for or depends on a DB round-trip for that field.
 */
export async function resolveField(
  db: Tx,
  scope: FieldScope,
  envValue: string | undefined,
): Promise<ResolvedSecret> {
  if (envValue) return { value: envValue, source: 'env' };

  const rows = await db
    .select()
    .from(storeSecret)
    .where(and(
      eq(storeSecret.storeId, scope.storeId),
      eq(storeSecret.provider, scope.provider),
      eq(storeSecret.mode, scope.mode),
      eq(storeSecret.field, scope.field),
    ))
    .limit(1);

  const row = rows[0];
  if (!row) return { value: '', source: 'unset' };

  const sealed: EncryptedSecret = { v: row.keyVersion, iv: row.iv, ct: row.ciphertext, tag: row.authTag };
  const value = decryptSecret(sealed, purposeFor(scope));
  return { value, source: 'db' };
}

/**
 * Whether a field is "managed by server configuration" — i.e. an env value is
 * present and the admin UI must show it read-only rather than let it be
 * edited/overwritten in the database.
 */
export function isEnvManaged(envValue: string | undefined): boolean {
  return !!envValue;
}
