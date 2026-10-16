/** Private, read-only auth export. This module never writes a source database. */
import { z } from 'zod';
import { normalizeEmail } from '../auth/email.js';
import type { ImportContext } from './context.js';
import type { AccountState, AliasRow, AuthMethod, IdentityMapRow, RollbackPackV1, SourceAccountStateV1, Tombstone } from './rollback-auth-v1.js';
import { stableOtherSessionInventory } from './rollback-auth-inventory.js';
import { finalTargetAuthDigest, lexical, parseRollbackPack, rollbackAccountSchema, rollbackCanonical, rollbackDigest,
  rollbackHash, rollbackId, rollbackIdentitySchema, rollbackPassword, rollbackPendingSchema, rollbackPinsSchema,
  rollbackScopeSchema, rollbackSourceAccountSchema, rollbackSourceSessionSchema, rollbackUtc } from './rollback-auth-schema.js';

type Row = Record<string, unknown>;
type Blocker = { code: string; targetCustomerId: string | null };
export interface RollbackAuthBaseline {
  schema: 'sellright.rollback-auth-baseline/v1'; sourceChannelId: string;
  identityMap: IdentityMapRow[]; sourceAccounts: SourceAccountStateV1[]; blockers: Blocker[]; baselineDigest: string;
}
const baselineSchema = z.object({ schema: z.literal('sellright.rollback-auth-baseline/v1'), sourceChannelId: rollbackId,
  identityMap: z.array(rollbackIdentitySchema), sourceAccounts: z.array(rollbackSourceAccountSchema),
  blockers: z.array(z.object({ code: rollbackId, targetCustomerId: rollbackId.nullable() }).strict()), baselineDigest: rollbackHash,
}).strict();
const asId = (value: unknown): string => rollbackId.parse(value);
const nullableId = (value: unknown): string | null => value == null ? null : asId(value);
const utc = (value: unknown): string => rollbackUtc.parse(value instanceof Date ? value.toISOString() : value);
const sortedRows = <T>(rows: T[], key: (row: T) => string): T[] => [...rows].sort((a, b) => lexical(key(a), key(b)));
const uniqueRows = <T>(rows: T[], key: (row: T) => string): void => {
  const seen = new Set<string>();
  for (const row of rows) { const id = key(row); if (seen.has(id)) throw new Error('Duplicate rollback inventory identity'); seen.add(id); }
};

export function parseRollbackBaseline(value: unknown): RollbackAuthBaseline {
  const baseline: RollbackAuthBaseline = baselineSchema.parse(value);
  const { baselineDigest, ...body } = baseline;
  if (rollbackDigest(body) !== baselineDigest) throw new Error('Rollback baseline digest mismatch');
  uniqueRows(baseline.identityMap, row => row.targetCustomerId); uniqueRows(baseline.sourceAccounts, row => row.sourceCustomerId);
  const source = new Map(baseline.sourceAccounts.map(row => [row.sourceCustomerId, row]));
  if (source.size !== baseline.identityMap.length || baseline.identityMap.some(row => row.origin !== 'imported' ||
      !source.has(row.sourceCustomerId!) || source.get(row.sourceCustomerId!)!.sourceUserId !== row.sourceUserId ||
      rollbackDigest(source.get(row.sourceCustomerId!)!) !== row.expectedSourceAccountDigest)) throw new Error('Incomplete immutable rollback mapping');
  return baseline;
}

/** Called for every imported customer, independently of session eligibility. */
export async function captureRollbackAuthBaseline(ctx: ImportContext, customers: Row[]): Promise<RollbackAuthBaseline> {
  const blockers: Blocker[] = [];
  const block = (code: string, targetCustomerId: string | null) => blockers.push({ code, targetCustomerId });
  const columns = ctx.sourceColumns.get('authentication_method');
  const field = (name: string) => columns?.has(name) ? 'am."' + name + '"' : 'NULL';
  const methods = await ctx.q(`SELECT am."userId"::text AS uid, am.type, am."passwordHash" AS password,
    ${field('identifier')} AS identifier, ${field('strategy')} AS strategy,
    ${field('externalIdentifier')} AS subject FROM authentication_method am ORDER BY am."userId", am.type`);
  const memberships = ctx.sourceColumns.get('customer_channels_channel');
  const channels = memberships?.has('customerId') && memberships.has('channelId')
    ? await ctx.q('SELECT "customerId"::text AS cid, "channelId"::text AS channel FROM customer_channels_channel ORDER BY "customerId", "channelId"')
    : [];
  if (!memberships?.has('customerId') || !memberships.has('channelId')) block('source_channel_membership_unavailable', null);
  const sourceAccounts: SourceAccountStateV1[] = [];
  const identityMap: IdentityMapRow[] = [];
  for (const row of customers) {
    const sourceCustomerId = asId(row.source_customer_id); const sourceUserId = nullableId(row.source_user_id);
    const targetCustomerId = ctx.id('customer', sourceCustomerId);
    const email = normalizeEmail(asId(row.email));
    const ownMethods = sourceUserId === null ? [] : methods.filter(method => method.uid === sourceUserId);
    const providers: AccountState['providers'] = [];
    for (const method of ownMethods) {
      if (method.type === 'NativeAuthenticationMethod') {
        if (method.identifier != null && method.identifier !== email) block('source_native_identifier_mismatch', targetCustomerId);
      } else if (method.type === 'ExternalAuthenticationMethod') {
        if ((method.strategy !== 'google' && method.strategy !== 'apple') || typeof method.subject !== 'string' || !method.subject) {
          block('unsupported_source_provider_identity', targetCustomerId); continue;
        }
        if (!providers.some(provider => provider.provider === method.strategy && provider.subject === method.subject)) {
          providers.push({ provider: method.strategy, subject: method.subject });
        }
      } else block('unsupported_source_authentication_method', targetCustomerId);
    }
    if (row.user_identifier != null && row.user_identifier !== email) block('source_user_identifier_mismatch', targetCustomerId);
    if (ownMethods.filter(method => method.type === 'NativeAuthenticationMethod').length > 1) block('duplicate_source_native_method', targetCustomerId);
    const providerNames = new Set(providers.map(provider => provider.provider));
    if (providerNames.size !== providers.length) block('multiple_source_provider_subjects', targetCustomerId);
    const channelIds = sortedRows(channels.filter(channel => channel.cid === sourceCustomerId).map(channel => asId(channel.channel)), value => value);
    if (!channelIds.includes(String(ctx.channelId))) block('source_customer_channel_mismatch', targetCustomerId);
    if (channelIds.some(channel => channel !== String(ctx.channelId))) block('shared_source_customer_identity', targetCustomerId);
    if (row.has_administrator_identity === true) block('source_administrator_identity', targetCustomerId);
    if (row.source_user_deleted_at != null) block('deleted_source_user_identity', targetCustomerId);
    const account: SourceAccountStateV1 = { sourceCustomerId, sourceUserId, channelIds,
      hasAdministratorIdentity: row.has_administrator_identity === true, deleted: row.source_user_deleted_at != null,
      account: row.source_user_deleted_at != null ? null : { email, emailVerified: row.verified === true, firstName: typeof row.fn === 'string' ? row.fn : '',
        lastName: typeof row.ln === 'string' ? row.ln : '', phone: typeof row.phone === 'string' ? row.phone : null,
        password: rollbackPassword(row.password || null), providers: sortedRows(providers, provider => provider.provider + '\0' + provider.subject) } };
    sourceAccounts.push(account);
    identityMap.push({ targetCustomerId, origin: 'imported', sourceCustomerId, sourceUserId, expectedSourceAccountDigest: rollbackDigest(account) });
  }
  const body = { schema: 'sellright.rollback-auth-baseline/v1' as const, sourceChannelId: String(ctx.channelId),
    identityMap: sortedRows(identityMap, row => row.targetCustomerId), sourceAccounts: sortedRows(sourceAccounts, row => row.sourceCustomerId),
    blockers: sortedRows(blockers, row => row.code + '\0' + (row.targetCustomerId ?? '')) };
  const baseline = parseRollbackBaseline({ ...body, baselineDigest: rollbackDigest(body) });
  ctx.rollbackAuthBaseline = baseline;
  if (blockers.length) ctx.exclusions.push({ type: 'unmapped-source-field', table: 'authentication_method', blocking: true,
    detail: 'Auth rollback unavailable; immutable baseline contains explicit identity blockers', count: blockers.length });
  return baseline;
}

export function targetAccount(row: Row): AccountState {
  const providers: AccountState['providers'] = [];
  if (row.google_sub != null) providers.push({ provider: 'google', subject: asId(row.google_sub) });
  if (row.apple_user_id != null) providers.push({ provider: 'apple', subject: asId(row.apple_user_id) });
  return rollbackAccountSchema.parse({ email: row.email, emailVerified: row.email_verified,
    firstName: row.first_name ?? '', lastName: row.last_name ?? '', phone: row.phone ?? null,
    password: rollbackPassword(row.password_hash ?? null), providers: sortedRows(providers, provider => provider.provider + '\0' + provider.subject) });
}

export const rollbackExportConfigSchema = z.object({ cloneId: rollbackId, issuedAt: rollbackUtc, expiresAt: rollbackUtc,
  pins: rollbackPinsSchema.omit({ finalTargetAuthDigest: true }),
  configuredAuthMethods: z.array(z.enum(['password', 'google', 'apple', 'email_magic_link'])), providerConfigurationDigest: rollbackHash,
}).strict();
export type RollbackExportConfig = z.infer<typeof rollbackExportConfigSchema>;
export const frozenSourceAuthSchema = z.object({ scope: rollbackScopeSchema,
  accounts: z.array(rollbackSourceAccountSchema), sessions: z.array(rollbackSourceSessionSchema),
}).strict();
export type FrozenSourceAuth = z.infer<typeof frozenSourceAuthSchema>;
export const originalEvidenceDigest = (manifest: unknown): string => rollbackDigest(manifest);
export function frozenSourceAuthDigest(value: FrozenSourceAuth): string {
  const snapshot = frozenSourceAuthSchema.parse(value);
  uniqueRows(snapshot.accounts, row => row.sourceCustomerId); uniqueRows(snapshot.sessions, row => row.sourceSessionId);
  return rollbackDigest({ scope: snapshot.scope, accounts: sortedRows(snapshot.accounts, row => row.sourceCustomerId),
    sessions: sortedRows(snapshot.sessions, row => row.sourceSessionId) });
}
const manifestSchema = z.object({ version: z.literal(1), storeId: rollbackId, sourceKey: rollbackId,
  afterDigest: rollbackHash, after: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))), rollbackAuthBaseline: baselineSchema,
}).passthrough();

/** Pure projection used by exporter & source fixtures; no credential material is returned in logs. */
export function buildRollbackAuthPack(input: {
  manifest: unknown; config: RollbackExportConfig; frozenSource: FrozenSourceAuth;
  customers: Row[]; sessions: Row[]; grants: Row[]; pendingArtifacts: Row[];
  now?: number;
}): RollbackPackV1 {
  const manifest = manifestSchema.parse(input.manifest);
  const baseline = parseRollbackBaseline(manifest.rollbackAuthBaseline);
  if (baseline.blockers.length) throw new Error('Immutable import mapping has rollback blockers');
  const config = rollbackExportConfigSchema.parse(input.config); const now = input.now ?? Date.now();
  if (originalEvidenceDigest(input.manifest) !== config.pins.originalImportDigest) throw new Error('Original import evidence pin mismatch');
  const scope = { sourceKey: manifest.sourceKey, sourceChannelId: baseline.sourceChannelId, targetStoreId: manifest.storeId };
  const frozen = frozenSourceAuthSchema.parse(input.frozenSource);
  if (rollbackCanonical(scope) !== rollbackCanonical(frozen.scope) || frozenSourceAuthDigest(frozen) !== config.pins.frozenSourceAuthBeforeDigest) throw new Error('Frozen source pin mismatch');
  const frozenAccounts = new Map(frozen.accounts.map(row => [row.sourceCustomerId, row]));
  for (const row of baseline.identityMap) {
    const source = frozenAccounts.get(row.sourceCustomerId!);
    if (!source || rollbackDigest(source) !== row.expectedSourceAccountDigest || source.hasAdministratorIdentity ||
        source.channelIds.length !== 1 || source.channelIds[0] !== scope.sourceChannelId) throw new Error('Frozen source account differs from immutable mapping');
  }
  const importedCustomers = manifest.after.customer ?? [];
  if (rollbackCanonical(sortedRows(importedCustomers.map(row => asId(row.id)), value => value)) !==
      rollbackCanonical(baseline.identityMap.map(row => row.targetCustomerId))) throw new Error('Incomplete original customer mapping');
  for (const rows of [input.customers, input.sessions, input.grants, input.pendingArtifacts]) for (const row of rows) {
    if (row.store_id !== scope.targetStoreId) throw new Error('Target auth snapshot tenant mismatch');
  }
  uniqueRows(input.customers, row => asId(row.id)); uniqueRows(input.sessions, row => asId(row.id)); uniqueRows(input.grants, row => asId(row.id));
  const customerById = new Map(input.customers.map(row => [asId(row.id), row]));
  const identityMap = [...baseline.identityMap];
  const baselineIds = new Set(identityMap.map(row => row.targetCustomerId));
  for (const row of input.customers) if (!baselineIds.has(asId(row.id))) identityMap.push({ targetCustomerId: asId(row.id),
    origin: 'target_native', sourceCustomerId: null, sourceUserId: null, expectedSourceAccountDigest: null });
  identityMap.sort((a, b) => lexical(a.targetCustomerId, b.targetCustomerId));
  const accounts = identityMap.map(identity => { const row = customerById.get(identity.targetCustomerId);
    return row && row.deleted_at == null ? { targetCustomerId: identity.targetCustomerId, state: 'active' as const, account: targetAccount(row) }
      : { targetCustomerId: identity.targetCustomerId, state: 'deleted' as const, account: null }; });
  const active = new Set(accounts.filter(row => row.state === 'active').map(row => row.targetCustomerId));
  const aliases: AliasRow[] = []; const tombstones: Tombstone[] = [];
  const originalGrants = manifest.after.legacy_session_grant ?? [];
  uniqueRows(originalGrants, row => asId(row.id));
  const originalGrantIds = new Set(originalGrants.map(row => asId(row.id)));
  if (input.grants.some(row => !originalGrantIds.has(asId(row.id)))) throw new Error('Unrecognized target legacy grant');
  const currentGrants = new Map(input.grants.map(row => [asId(row.id), row]));
  const currentSessions = new Map(input.sessions.map(row => [asId(row.id), row]));
  const frozenSessions = new Map(frozen.sessions.map(row => [row.sourceSessionId, row]));
  const coveredSessions = new Set<string>();
  const revoke = (grant: Row, reason: Tombstone['reason']) => tombstones.push({ targetCustomerId: nullableId(grant.customer_id),
    targetSessionId: nullableId(grant.session_id), sourceSessionId: asId(grant.source_session_id), tokenHash: rollbackHash.parse(grant.token_hash), reason });
  for (const grant of originalGrants) {
    if (grant.store_id !== scope.targetStoreId || grant.source_key !== scope.sourceKey) throw new Error('Original grant scope mismatch');
    const current = currentGrants.get(asId(grant.id));
    const sessionId = nullableId(grant.session_id); const session = sessionId === null ? undefined : currentSessions.get(sessionId);
    const source = frozenSessions.get(asId(grant.source_session_id));
    if (grant.authenticated !== true) { revoke(grant, 'identity_changed'); continue; }
    if (!active.has(asId(grant.customer_id))) { if (session) coveredSessions.add(sessionId!); revoke(grant, 'account_deleted'); continue; }
    if (!current || !session) { if (session) coveredSessions.add(sessionId!); revoke(grant, current ? 'logout' : 'missing'); continue; }
    const same = ['store_id', 'source_key', 'source_session_id', 'source_user_id', 'source_customer_id', 'authenticated', 'token_hash', 'customer_id', 'session_id']
      .every(key => rollbackCanonical(current[key] ?? null) === rollbackCanonical(grant[key] ?? null));
    if (!same || session.customer_id !== grant.customer_id || session.token_hash !== grant.token_hash || session.admin_user_id != null || session.api_token_id != null) {
      revoke(grant, 'identity_changed'); if (session.token_hash === grant.token_hash) coveredSessions.add(sessionId!); continue;
    }
    coveredSessions.add(sessionId!);
    if (!source || source.invalidated || source.sourceUserId !== grant.source_user_id || source.sourceCustomerId !== grant.source_customer_id ||
        source.sourceChannelId !== scope.sourceChannelId || source.tokenHash !== grant.token_hash) { revoke(grant, 'source_invalidated'); continue; }
    const expiry = Math.min(Date.parse(utc(session.expires_at)), Date.parse(utc(grant.expires_at)), Date.parse(source.expiresAt),
      Date.parse(utc(current.expires_at)), session.legacy_expires_at == null ? Infinity : Date.parse(utc(session.legacy_expires_at)));
    if (expiry <= now) { revoke(grant, 'expired'); continue; }
    aliases.push({ targetSessionId: sessionId!, targetCustomerId: asId(grant.customer_id), tokenHash: rollbackHash.parse(grant.token_hash),
      expiresAt: new Date(expiry).toISOString(), imported: { sourceSessionId: asId(grant.source_session_id), sourceUserId: asId(grant.source_user_id),
        sourceCustomerId: asId(grant.source_customer_id), originalExpiresAt: utc(grant.expires_at) } });
  }
  for (const session of input.sessions) {
    const targetSessionId = asId(session.id);
    if (coveredSessions.has(targetSessionId) || session.customer_id == null || session.admin_user_id != null || session.api_token_id != null) continue;
    const targetCustomerId = asId(session.customer_id); const tokenHash = rollbackHash.parse(session.token_hash);
    const expiry = Math.min(Date.parse(utc(session.expires_at)),
      session.legacy_expires_at == null ? Infinity : Date.parse(utc(session.legacy_expires_at)));
    if (!active.has(targetCustomerId) || expiry <= now) {
      tombstones.push({ targetCustomerId, targetSessionId, sourceSessionId: null, tokenHash, reason: active.has(targetCustomerId) ? 'expired' : 'account_deleted' }); continue;
    }
    aliases.push({ targetSessionId, targetCustomerId, tokenHash, expiresAt: new Date(expiry).toISOString(), imported: null });
  }
  const pendingAuthArtifacts = input.pendingArtifacts.filter(row => row.used_at == null && Date.parse(utc(row.expires_at)) > now).map(row =>
    rollbackPendingSchema.parse({ id: row.id, targetCustomerId: row.customer_id, kind: row.kind, tokenHash: row.token_hash, expiresAt: utc(row.expires_at) }));
  const required = new Set<AuthMethod>(config.configuredAuthMethods);
  for (const row of accounts) if (row.account) { if (row.account.password.format !== 'none') required.add('password');
    for (const provider of row.account.providers) required.add(provider.provider); }
  if (pendingAuthArtifacts.some(row => row.kind === 'magic_link')) required.add('email_magic_link');
  const body = { schema: 'sellright.rollback-auth/v1' as const, mode: 'isolated-clone' as const, cloneId: config.cloneId,
    issuedAt: config.issuedAt, expiresAt: config.expiresAt, scope, pins: { ...config.pins, finalTargetAuthDigest: '' },
    requiredAuthMethods: [...required].sort(lexical), providerConfigurationDigest: config.providerConfigurationDigest, identityMap, accounts,
    aliases: sortedRows(aliases, row => row.targetSessionId), tombstones: sortedRows(tombstones, rollbackCanonical),
    pendingAuthArtifacts: sortedRows(pendingAuthArtifacts, row => row.id), otherSessionInventoryDigest: rollbackDigest(stableOtherSessionInventory({
      storeId: scope.targetStoreId, importedSessions: manifest.after.session ?? [], currentSessions: input.sessions })) };
  body.pins.finalTargetAuthDigest = finalTargetAuthDigest(body);
  return parseRollbackPack({ ...body, packDigest: rollbackDigest(body) }, now);
}
