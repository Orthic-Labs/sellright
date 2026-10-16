import { lexical, rollbackCanonical, rollbackDigest, rollbackHash, rollbackId } from './rollback-auth-schema.js';

type Row = Record<string, unknown>;
const expiry = (value: unknown): string | null => {
  if (value == null) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
/** Token-free planner output; time-derived flags never enter stable inventory digests. */
export function legacyRollbackSessionInventory(input: {
  storeId: string; importedSessions: Row[]; currentSessions: Row[]; now?: number;
}) {
  const now = input.now ?? Date.now();
  const before = new Map(input.importedSessions.map(row => [rollbackId.parse(row.id), row]));
  const current = new Map(input.currentSessions.map(row => [rollbackId.parse(row.id), row]));
  return [...new Set([...before.keys(), ...current.keys()])].sort(lexical).map(id => {
    const original = before.get(id); const row = current.get(id);
    if ((original && original.store_id !== input.storeId) || (row && row.store_id !== input.storeId)) throw new Error('Session inventory tenant mismatch');
    const identity = row ?? original!;
    const exactImported = !!original && !!row && ['customer_id', 'admin_user_id', 'api_token_id', 'token_hash']
      .every(key => rollbackCanonical(original[key] ?? null) === rollbackCanonical(row[key] ?? null));
    const targetExpiresAt = expiry(row?.expires_at); const legacyExpiresAt = expiry(row?.legacy_expires_at);
    const effective = targetExpiresAt === null ? NaN : Math.min(Date.parse(targetExpiresAt), legacyExpiresAt === null ? Infinity : Date.parse(legacyExpiresAt));
    const active = !!row && Number.isFinite(effective) && effective > now;
    return { targetSessionId: id, targetCustomerId: identity.customer_id ?? null,
      targetAdminUserId: identity.admin_user_id ?? null, targetApiTokenId: identity.api_token_id ?? null,
      imported: !!original, exactImported, state: !row ? 'deleted' : active ? 'active' : 'expired',
      expiresAt: Number.isFinite(effective) ? new Date(effective).toISOString() : null,
      originalExpiresAt: expiry(original?.expires_at), originalLegacyExpiresAt: expiry(original?.legacy_expires_at),
      targetExpiresAt, legacyExpiresAt, sourceBridgeRequired: active && !exactImported };
  });
}

/** Sealed stable projection: row existence & deadlines, independent of wall-clock expiry. */
export function stableOtherSessionInventory(input: {
  storeId: string; importedSessions: Row[]; currentSessions: Row[];
}) {
  const present = new Set(input.currentSessions.map(row => rollbackId.parse(row.id)));
  const hashes = new Map(input.currentSessions.map(row => [rollbackId.parse(row.id), rollbackHash.parse(row.token_hash)]));
  return legacyRollbackSessionInventory({ ...input, now: 0 }).map(row => ({
    targetSessionId: row.targetSessionId, targetCustomerId: row.targetCustomerId, targetAdminUserId: row.targetAdminUserId,
    targetApiTokenId: row.targetApiTokenId, imported: row.imported, exactImported: row.exactImported,
    expiresAt: row.expiresAt, originalExpiresAt: row.originalExpiresAt, originalLegacyExpiresAt: row.originalLegacyExpiresAt,
    targetExpiresAt: row.targetExpiresAt, legacyExpiresAt: row.legacyExpiresAt, presentInFinalTarget: present.has(row.targetSessionId),
    tokenHashFingerprint: present.has(row.targetSessionId) ? rollbackDigest({ tokenHash: hashes.get(row.targetSessionId)! }) : null,
  }));
}
