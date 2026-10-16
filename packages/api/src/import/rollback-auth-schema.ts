import { createHash } from 'node:crypto';
import { z } from 'zod';
import { normalizeEmail } from '../auth/email.js';
import { isLegacyBcryptHash } from '../auth/password.js';
import type { Password, RollbackPackV1 } from './rollback-auth-v1.js';

export const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
/** Wire JSON only: undefined, non-finite numbers & non-JSON objects fail closed. */
export function rollbackCanonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(rollbackCanonical).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort(lexical).map(key => JSON.stringify(key) + ':' +
      rollbackCanonical((value as Record<string, unknown>)[key])).join(',') + '}';
  }
  throw new Error('Rollback canonical JSON requires explicit JSON values');
}
export const rollbackDigest = (value: unknown): string => createHash('sha256').update(rollbackCanonical(value), 'utf8').digest('hex');
export const rollbackId = z.string().min(1);
export const rollbackHash = z.string().regex(/^[0-9a-f]{64}$/);
const commit = z.string().regex(/^[0-9a-f]{40}$/);
export const rollbackUtc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const sorted = <T>(rows: T[], key: (row: T) => string): boolean => rows.every((row, i) => i === 0 || lexical(key(rows[i - 1]!), key(row)) < 0);

/** Same accepted encodings & resource bounds as auth/password.ts; hashes stay unchanged. */
export function rollbackPassword(value: unknown): Password {
  if (value === null) return { format: 'none', value: null };
  if (typeof value !== 'string' || !value) throw new Error('Unsupported rollback password encoding');
  if (isLegacyBcryptHash(value)) return { format: 'bcrypt', value };
  const phc = /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(value);
  if (phc) {
    const [version, memory, passes, parallelism] = phc.slice(1, 5).map(Number);
    const decode = (part: string): Buffer | null => {
      const bytes = Buffer.from(part, 'base64');
      return bytes.toString('base64').replace(/=+$/u, '') === part ? bytes : null;
    };
    const salt = decode(phc[5]!); const expected = decode(phc[6]!);
    if (version === 19 && Number.isSafeInteger(memory) && memory! >= 8 * parallelism! && memory! <= 65_536 &&
      Number.isSafeInteger(passes) && passes! >= 1 && passes! <= 10 && Number.isSafeInteger(parallelism) &&
      parallelism! >= 1 && parallelism! <= 8 && salt && salt.length >= 8 && salt.length <= 64 &&
      expected && expected.length >= 16 && expected.length <= 64) return { format: 'argon2id-phc', value };
  }
  const [scheme, salt, hash] = value.split('$');
  if (scheme === 'scrypt' && salt && hash && /^[0-9a-f]+$/iu.test(salt) && /^[0-9a-f]+$/iu.test(hash) &&
      Buffer.from(salt, 'hex').length > 0 && Buffer.from(hash, 'hex').length === 64) return { format: 'sellright-scrypt', value };
  throw new Error('Unsupported rollback password encoding');
}
const password = z.object({ format: z.enum(['none', 'bcrypt', 'argon2id-phc', 'sellright-scrypt']), value: z.string().nullable() }).strict()
  .refine(row => { try { return rollbackPassword(row.value).format === row.format; } catch { return false; } });
const provider = z.object({ provider: z.enum(['google', 'apple']), subject: rollbackId }).strict();
export const rollbackAccountSchema = z.object({
  email: z.string().min(1).refine(value => normalizeEmail(value) === value), emailVerified: z.boolean(),
  firstName: z.string(), lastName: z.string(), phone: z.string().nullable(), password,
  providers: z.array(provider).refine(rows => sorted(rows, row => row.provider + '\0' + row.subject)),
}).strict();
export const rollbackSourceAccountSchema = z.object({
  sourceCustomerId: rollbackId, sourceUserId: rollbackId.nullable(), channelIds: z.array(rollbackId).refine(rows => sorted(rows, row => row)),
  hasAdministratorIdentity: z.boolean(), deleted: z.boolean(), account: rollbackAccountSchema.nullable(),
}).strict().refine(row => row.deleted ? row.account === null : row.account !== null);
export const rollbackSourceSessionSchema = z.object({
  sourceSessionId: rollbackId, sourceUserId: rollbackId, sourceCustomerId: rollbackId, sourceChannelId: rollbackId,
  tokenHash: rollbackHash, invalidated: z.boolean(), expiresAt: rollbackUtc,
}).strict();
export const rollbackIdentitySchema = z.object({
  targetCustomerId: rollbackId, origin: z.enum(['imported', 'target_native']), sourceCustomerId: rollbackId.nullable(),
  sourceUserId: rollbackId.nullable(), expectedSourceAccountDigest: rollbackHash.nullable(),
}).strict().refine(row => row.origin === 'imported'
  ? row.sourceCustomerId !== null && row.expectedSourceAccountDigest !== null
  : row.sourceCustomerId === null && row.sourceUserId === null && row.expectedSourceAccountDigest === null);
export const rollbackScopeSchema = z.object({ sourceKey: rollbackId, sourceChannelId: rollbackId, targetStoreId: rollbackId }).strict();
const accountRow = z.object({ targetCustomerId: rollbackId, state: z.enum(['active', 'deleted']), account: rollbackAccountSchema.nullable() })
  .strict().refine(row => row.state === 'active' ? row.account !== null : row.account === null);
const alias = z.object({ targetSessionId: rollbackId, targetCustomerId: rollbackId, tokenHash: rollbackHash, expiresAt: rollbackUtc,
  imported: z.object({ sourceSessionId: rollbackId, sourceUserId: rollbackId, sourceCustomerId: rollbackId, originalExpiresAt: rollbackUtc }).strict().nullable(),
}).strict();
const tombstone = z.object({ targetCustomerId: rollbackId.nullable(), targetSessionId: rollbackId.nullable(),
  sourceSessionId: rollbackId.nullable(), tokenHash: rollbackHash.nullable(),
  reason: z.enum(['logout', 'missing', 'expired', 'identity_changed', 'account_deleted', 'source_invalidated']),
}).strict().refine(row => row.sourceSessionId !== null || row.tokenHash !== null);
export const rollbackPendingSchema = z.object({ id: rollbackId, targetCustomerId: rollbackId,
  kind: z.enum(['password_reset', 'email_verify', 'email_change', 'magic_link', 'federated_link']), tokenHash: rollbackHash, expiresAt: rollbackUtc,
}).strict();
export const rollbackPinsSchema = z.object({ originalImportDigest: rollbackHash, finalTargetAuthDigest: rollbackHash,
  frozenSourceAuthBeforeDigest: rollbackHash, engineCommit: commit, sourceAdminCommit: commit, sourceStoreCommit: commit,
  sourceAdminTreeDigest: rollbackHash, sourceStoreTreeDigest: rollbackHash, adapterCapabilitiesDigest: rollbackHash,
  sourceNode: z.literal('24.20.0'), sourceVendure: z.literal('3.7.3'),
}).strict();
export const rollbackPackSchema = z.object({ schema: z.literal('sellright.rollback-auth/v1'), mode: z.literal('isolated-clone'),
  cloneId: rollbackId, issuedAt: rollbackUtc, expiresAt: rollbackUtc, scope: rollbackScopeSchema, pins: rollbackPinsSchema,
  requiredAuthMethods: z.array(z.enum(['password', 'google', 'apple', 'email_magic_link'])).refine(rows => sorted(rows, row => row)),
  providerConfigurationDigest: rollbackHash, identityMap: z.array(rollbackIdentitySchema), accounts: z.array(accountRow),
  aliases: z.array(alias), tombstones: z.array(tombstone), pendingAuthArtifacts: z.array(rollbackPendingSchema),
  otherSessionInventoryDigest: rollbackHash, packDigest: rollbackHash,
}).strict();

export function finalTargetAuthDigest(pack: Pick<RollbackPackV1, 'scope' | 'requiredAuthMethods' | 'providerConfigurationDigest' |
  'identityMap' | 'accounts' | 'aliases' | 'tombstones' | 'pendingAuthArtifacts' | 'otherSessionInventoryDigest'>): string {
  const { scope, requiredAuthMethods, providerConfigurationDigest, identityMap, accounts, aliases, tombstones, pendingAuthArtifacts, otherSessionInventoryDigest } = pack;
  return rollbackDigest({ scope, requiredAuthMethods, providerConfigurationDigest, identityMap, accounts, aliases, tombstones, pendingAuthArtifacts, otherSessionInventoryDigest });
}

/** Validate coverage, all bindings & digests before any clone consumes this artifact. */
export function parseRollbackPack(value: unknown, now = Date.now()): RollbackPackV1 {
  const pack: RollbackPackV1 = rollbackPackSchema.parse(value);
  const { packDigest, ...body } = pack;
  if (rollbackDigest(body) !== packDigest || finalTargetAuthDigest(pack) !== pack.pins.finalTargetAuthDigest) throw new Error('Rollback digest mismatch');
  if (Date.parse(pack.issuedAt) > now || Date.parse(pack.expiresAt) <= now || Date.parse(pack.expiresAt) <= Date.parse(pack.issuedAt)) throw new Error('Rollback pack expired or not yet issued');
  if (!sorted(pack.identityMap, row => row.targetCustomerId) || !sorted(pack.accounts, row => row.targetCustomerId)) {
    throw new Error('Rollback account inventory is unsorted or duplicated');
  }
  if (!sorted(pack.aliases, row => row.targetSessionId) || !sorted(pack.pendingAuthArtifacts, row => row.id) ||
      !sorted(pack.tombstones, rollbackCanonical)) throw new Error('Rollback capability inventory is unsorted or duplicated');
  if (rollbackCanonical(pack.identityMap.map(row => row.targetCustomerId)) !== rollbackCanonical(pack.accounts.map(row => row.targetCustomerId))) throw new Error('Incomplete rollback account coverage');
  const identities = new Map(pack.identityMap.map(row => [row.targetCustomerId, row]));
  const accounts = new Map(pack.accounts.map(row => [row.targetCustomerId, row]));
  const sourceIds = new Set<string>(); const sourceUsers = new Set<string>(); const providerIds = new Set<string>(); const hashes = new Set<string>();
  for (const row of pack.identityMap) {
    if (row.origin === 'imported') {
      if (sourceIds.has(row.sourceCustomerId!) || row.sourceUserId !== null && sourceUsers.has(row.sourceUserId)) throw new Error('Ambiguous source identity mapping');
      sourceIds.add(row.sourceCustomerId!); if (row.sourceUserId !== null) sourceUsers.add(row.sourceUserId);
    }
  }
  for (const row of pack.accounts) for (const identity of row.account?.providers ?? []) {
    const key = identity.provider + '\0' + identity.subject;
    if (providerIds.has(key)) throw new Error('Provider subject collision'); providerIds.add(key);
  }
  for (const row of pack.aliases) {
    const identity = identities.get(row.targetCustomerId);
    if (!identity || accounts.get(row.targetCustomerId)?.state !== 'active' || hashes.has(row.tokenHash) || Date.parse(row.expiresAt) <= now) throw new Error('Invalid rollback alias authority');
    hashes.add(row.tokenHash);
    if (row.imported && (identity.origin !== 'imported' || identity.sourceCustomerId !== row.imported.sourceCustomerId ||
      identity.sourceUserId !== row.imported.sourceUserId || Date.parse(row.expiresAt) > Date.parse(row.imported.originalExpiresAt))) throw new Error('Imported alias identity or expiry mismatch');
  }
  for (const row of pack.tombstones) if (row.tokenHash !== null && hashes.has(row.tokenHash)) throw new Error('Revoked capability appears as alias');
  for (const row of pack.pendingAuthArtifacts) if (accounts.get(row.targetCustomerId)?.state !== 'active') throw new Error('Artifact references inactive account');
  const required = new Set(pack.requiredAuthMethods);
  for (const row of pack.accounts) if (row.account) {
    if (row.account.password.format !== 'none' && !required.has('password')) throw new Error('Missing password adapter requirement');
    for (const provider of row.account.providers) if (!required.has(provider.provider)) throw new Error('Missing provider adapter requirement');
  }
  if (pack.pendingAuthArtifacts.some(row => row.kind === 'magic_link') && !required.has('email_magic_link')) throw new Error('Missing magic-link adapter requirement');
  return pack;
}
