import { describe, expect, it } from 'vitest';
import { signFederatedLink, verifyFederatedLink } from '../auth/federated-link.js';
import { assertFederatedIssuanceCoverage, RollbackAuthBlocked } from './rollback-auth-artifacts.js';
import { stableOtherSessionInventory } from './rollback-auth-inventory.js';
import { buildRollbackAuthPack, captureRollbackAuthBaseline, frozenSourceAuthDigest, originalEvidenceDigest, parseRollbackBaseline,
  type RollbackAuthBaseline, type RollbackExportConfig } from './rollback-auth.js';
import { finalTargetAuthDigest, parseRollbackPack, rollbackCanonical, rollbackDigest, rollbackPassword } from './rollback-auth-schema.js';
import type { SourceAccountStateV1 } from './rollback-auth-v1.js';
import type { ImportContext } from './context.js';

const NOW = Date.UTC(2026, 9, 16, 12);
const stamp = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const H = 'a'.repeat(64);
const BCRYPT = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
const PHC = '$argon2id$v=19$m=19456,t=2,p=1$' + Buffer.from('sixteen-byte-salt').toString('base64').replace(/=+$/, '') +
  '$' + Buffer.alloc(32, 7).toString('base64').replace(/=+$/, '');
function fixture() {
  const source: SourceAccountStateV1 = { sourceCustomerId: '11', sourceUserId: '21', channelIds: ['1'],
    hasAdministratorIdentity: false, deleted: false, account: { email: 'buyer@example.test', emailVerified: true,
      firstName: 'Buyer', lastName: '', phone: '', password: { format: 'bcrypt', value: BCRYPT }, providers: [] } };
  const baselineBody = { schema: 'sellright.rollback-auth-baseline/v1' as const, sourceChannelId: '1',
    identityMap: [{ targetCustomerId: 'customer-imported', origin: 'imported' as const, sourceCustomerId: '11',
      sourceUserId: '21', expectedSourceAccountDigest: rollbackDigest(source) }], sourceAccounts: [source], blockers: [] };
  const baseline: RollbackAuthBaseline = { ...baselineBody, baselineDigest: rollbackDigest(baselineBody) };
  const customer = { id: 'customer-imported', store_id: 'store', email: 'buyer@example.test', email_verified: true,
    first_name: 'Buyer', last_name: null, phone: '', password_hash: BCRYPT, google_sub: null as string | null, apple_user_id: null as string | null, deleted_at: null };
  const session = { id: 'session-imported', store_id: 'store', customer_id: customer.id, admin_user_id: null,
    api_token_id: null, token_hash: H, expires_at: stamp(3), legacy_expires_at: stamp(2) };
  const grant = { id: 'grant-imported', store_id: 'store', source_key: 'vendure:fixture', source_session_id: '31',
    source_user_id: '21', source_customer_id: '11', authenticated: true, token_hash: H,
    customer_id: customer.id, session_id: session.id, expires_at: stamp(2) };
  const manifest = { version: 1 as const, storeId: 'store', sourceKey: 'vendure:fixture', afterDigest: 'b'.repeat(64),
    after: { customer: [structuredClone(customer)], session: [structuredClone(session)], legacy_session_grant: [structuredClone(grant)], cart: [{ token: 'raw-cart-token-must-stay-private' }] },
    rollbackAuthBaseline: baseline };
  const frozenSource = { scope: { sourceKey: manifest.sourceKey, sourceChannelId: '1', targetStoreId: 'store' }, accounts: [structuredClone(source)],
    sessions: [{ sourceSessionId: '31', sourceUserId: '21', sourceCustomerId: '11', sourceChannelId: '1', tokenHash: H,
      invalidated: false, expiresAt: stamp(1) }] };
  const config: RollbackExportConfig = { cloneId: 'isolated-fixture', issuedAt: stamp(0), expiresAt: stamp(0.5),
    pins: { originalImportDigest: originalEvidenceDigest(manifest), frozenSourceAuthBeforeDigest: frozenSourceAuthDigest(frozenSource),
      engineCommit: '1'.repeat(40), sourceAdminCommit: '2'.repeat(40), sourceStoreCommit: '3'.repeat(40),
      sourceAdminTreeDigest: '4'.repeat(64), sourceStoreTreeDigest: '5'.repeat(64), adapterCapabilitiesDigest: '6'.repeat(64),
      sourceNode: '24.20.0', sourceVendure: '3.7.3' }, configuredAuthMethods: ['password'], providerConfigurationDigest: '7'.repeat(64) };
  return { manifest, config, frozenSource, now: NOW, customers: [customer], sessions: [session], grants: [grant],
    pendingArtifacts: [] as Record<string, unknown>[] };
}

describe('RollbackPackV1 wire & immutable evidence', () => {
  it('uses lexical object-key order, explicit nulls & rejects non-JSON values', () => {
    expect(rollbackCanonical({ z: null, a: ['z', 'A'] })).toBe('{"a":["z","A"],"z":null}');
    expect(() => rollbackCanonical({ absent: undefined })).toThrow();
    expect(() => rollbackCanonical(new Date())).toThrow();
  });
  it('binds complete manifest, baseline map & dirty working-tree code pins', () => {
    const f = fixture(); const pack = buildRollbackAuthPack(f);
    expect(pack.identityMap).toHaveLength(1);
    expect(pack.accounts).toHaveLength(1);
    expect(pack.pins.finalTargetAuthDigest).toBe(finalTargetAuthDigest(pack));
    expect(parseRollbackPack(pack, NOW)).toEqual(pack);
    expect(() => parseRollbackPack({ ...pack, pins: { ...pack.pins, sourceAdminTreeDigest: '9'.repeat(64) } }, NOW)).toThrow(/digest/);
    f.manifest.after.cart[0]!.token = 'changed-private-artifact';
    expect(() => buildRollbackAuthPack(f)).toThrow(/evidence pin/);
  });
  it('requires every imported customer even when no sessions survive', () => {
    const f = fixture(); f.sessions = [];
    const pack = buildRollbackAuthPack(f);
    expect(pack.identityMap[0]!.sourceCustomerId).toBe('11');
    expect(pack.accounts[0]!.state).toBe('active');
    expect(pack.aliases).toEqual([]);
    expect(pack.tombstones[0]!.reason).toBe('logout');
    const { baselineDigest: _digest, ...body } = f.manifest.rollbackAuthBaseline;
    body.identityMap = [];
    expect(() => parseRollbackBaseline({ ...body, baselineDigest: rollbackDigest(body) })).toThrow(/mapping/);
  });
  it('rejects missing fields, raw credential fields & expired/replayed packs', () => {
    const pack = buildRollbackAuthPack(fixture());
    expect(() => parseRollbackPack({ ...pack, authToken: 'raw-browser-token' }, NOW)).toThrow();
    const { otherSessionInventoryDigest: _inventory, ...missing } = pack;
    expect(() => parseRollbackPack(missing, NOW)).toThrow();
    expect(() => parseRollbackPack(pack, NOW + 3_600_000)).toThrow(/expired/);
    expect(JSON.stringify(pack)).not.toContain('raw-cart-token');
  });
});

describe('forward import rollback account mapping', () => {
  const sourceCustomer = { source_customer_id: '11', source_user_id: '21', email: 'buyer@example.test',
    user_identifier: 'buyer@example.test', verified: true, fn: 'Buyer', ln: null, phone: '', password: BCRYPT,
    has_administrator_identity: false, source_user_deleted_at: null };
  const context = (methods: Record<string, unknown>[]) => ({ storeId: 'store', sourceKey: 'vendure:fixture', channelId: 1,
    id: (_entity: string, id: unknown) => 'target:' + String(id), exclusions: [],
    sourceColumns: new Map([['authentication_method', new Set(['identifier', 'strategy', 'externalIdentifier'])],
      ['customer_channels_channel', new Set(['customerId', 'channelId'])]]),
    q: async (sql: string) => sql.includes('FROM authentication_method') ? methods : [{ cid: '11', channel: '1' }],
  } as unknown as ImportContext);
  it('records exact source customer & user IDs even with no source sessions', async () => {
    const ctx = context([{ uid: '21', type: 'NativeAuthenticationMethod', identifier: sourceCustomer.email }]);
    const baseline = await captureRollbackAuthBaseline(ctx, [sourceCustomer]);
    expect(baseline.blockers).toEqual([]);
    expect(baseline.identityMap).toEqual([{ targetCustomerId: 'target:11', origin: 'imported', sourceCustomerId: '11',
      sourceUserId: '21', expectedSourceAccountDigest: rollbackDigest(baseline.sourceAccounts[0]) }]);
    expect(baseline.sourceAccounts[0]!.account!.phone).toBe('');
    expect(ctx.rollbackAuthBaseline).toEqual(baseline);
  });
  it('records explicit unavailable-baseline blockers instead of guessing identities', async () => {
    const ctx = context([{ uid: '21', type: 'NativeAuthenticationMethod', identifier: 'Buyer@example.test' },
      { uid: '21', type: 'ExternalAuthenticationMethod', strategy: 'unsupported', subject: 'ExactSubject' }]);
    const baseline = await captureRollbackAuthBaseline(ctx, [sourceCustomer]);
    expect(baseline.blockers.map(row => row.code)).toEqual(['source_native_identifier_mismatch', 'unsupported_source_provider_identity']);
    expect(ctx.exclusions).toEqual([expect.objectContaining({ blocking: true, count: 2 })]);
  });
});

describe('rollback account authority & alias dispositions', () => {
  it('keeps password-change sessions, exact hashes, verified email & provider subjects', () => {
    const f = fixture(); f.customers[0]!.password_hash = PHC;
    f.customers[0]!.email = 'changed@example.test';
    f.customers[0]!.google_sub = 'Case-Sensitive-Subject';
    const pack = buildRollbackAuthPack(f);
    expect(pack.accounts[0]!.account).toMatchObject({ email: 'changed@example.test', emailVerified: true,
      password: { format: 'argon2id-phc', value: PHC }, providers: [{ provider: 'google', subject: 'Case-Sensitive-Subject' }] });
    expect(pack.aliases[0]!.imported?.sourceSessionId).toBe('31');
    expect(pack.aliases[0]!.expiresAt).toBe(stamp(1));
    expect(pack.requiredAuthMethods).toEqual(['google', 'password']);
  });
  it('includes native & deleted accounts without email matching', () => {
    const f = fixture(); const original = f.customers[0]!;
    f.customers = [{ ...original, id: 'customer-native', email: 'native@example.test' }];
    f.sessions = [{ ...f.sessions[0]!, id: 'session-native', customer_id: 'customer-native', token_hash: 'c'.repeat(64) }];
    const pack = buildRollbackAuthPack(f);
    expect(pack.identityMap).toEqual(expect.arrayContaining([expect.objectContaining({ targetCustomerId: 'customer-native', origin: 'target_native', sourceCustomerId: null })]));
    expect(pack.accounts.find(row => row.targetCustomerId === original.id)).toMatchObject({ state: 'deleted', account: null });
    expect(pack.aliases[0]).toMatchObject({ targetSessionId: 'session-native', imported: null, expiresAt: stamp(2) });
    expect(pack.tombstones[0]!.reason).toBe('account_deleted');
  });
  it('never resurrects missing grants or invalidated frozen source sessions', () => {
    const missing = fixture(); missing.grants = [];
    expect(buildRollbackAuthPack(missing)).toMatchObject({ aliases: [], tombstones: [expect.objectContaining({ reason: 'missing' })] });
    const revoked = fixture(); revoked.frozenSource.sessions[0]!.invalidated = true;
    revoked.config.pins.frozenSourceAuthBeforeDigest = frozenSourceAuthDigest(revoked.frozenSource);
    expect(buildRollbackAuthPack(revoked)).toMatchObject({ aliases: [], tombstones: [expect.objectContaining({ reason: 'source_invalidated' })] });
  });
  it('tombstones original hash while retaining independently changed target hash', () => {
    const f = fixture(); f.sessions[0]!.token_hash = 'd'.repeat(64);
    const pack = buildRollbackAuthPack(f);
    expect(pack.aliases[0]).toMatchObject({ tokenHash: 'd'.repeat(64), imported: null });
    expect(pack.tombstones[0]).toMatchObject({ tokenHash: H, reason: 'identity_changed' });
  });
  it('tombstones expired legacy caps for native & changed-hash sessions', () => {
    for (const id of ['session-native', 'session-imported']) {
      const f = fixture(); f.sessions = [{ ...f.sessions[0]!, id, token_hash: 'd'.repeat(64), legacy_expires_at: stamp(-1) }];
      const pack = buildRollbackAuthPack(f);
      expect(pack.aliases).toEqual([]);
      expect(pack.tombstones).toContainEqual({ targetCustomerId: 'customer-imported', targetSessionId: id,
        sourceSessionId: null, tokenHash: 'd'.repeat(64), reason: 'expired' });
    }
  });
  it('caps native & changed-hash aliases at earlier future legacy expiry', () => {
    for (const id of ['session-native', 'session-imported']) {
      const f = fixture(); f.sessions = [{ ...f.sessions[0]!, id, token_hash: 'd'.repeat(64), legacy_expires_at: stamp(0.25) }];
      expect(buildRollbackAuthPack(f).aliases).toEqual([{ targetSessionId: id, targetCustomerId: 'customer-imported',
        tokenHash: 'd'.repeat(64), expiresAt: stamp(0.25), imported: null }]);
    }
  });
  it('denies malformed target or legacy deadlines before exporting native aliases', () => {
    for (const field of ['expires_at', 'legacy_expires_at'] as const) {
      const f = fixture(); f.sessions[0]!.token_hash = 'd'.repeat(64); f.sessions[0]![field] = 'invalid-deadline';
      expect(() => buildRollbackAuthPack(f)).toThrow();
    }
  });
  it('refuses tenant, source identity, unknown grant & account-map contamination', () => {
    const tenant = fixture(); tenant.sessions[0]!.store_id = 'other';
    expect(() => buildRollbackAuthPack(tenant)).toThrow(/tenant/);
    const source = fixture(); source.frozenSource.accounts[0]!.sourceUserId = 'different';
    source.config.pins.frozenSourceAuthBeforeDigest = frozenSourceAuthDigest(source.frozenSource);
    expect(() => buildRollbackAuthPack(source)).toThrow(/immutable mapping/);
    const extra = fixture(); extra.grants.push({ ...extra.grants[0]!, id: 'untrusted-grant' });
    expect(() => buildRollbackAuthPack(extra)).toThrow(/Unrecognized/);
  });
  it('inventories active auth artifacts by SHA256 only & rejects unsupported kinds', () => {
    const f = fixture(); f.pendingArtifacts.push({ id: 'artifact', store_id: 'store', customer_id: 'customer-imported',
      kind: 'magic_link', token_hash: 'e'.repeat(64), expires_at: stamp(1), used_at: null });
    const pack = buildRollbackAuthPack(f);
    expect(pack.requiredAuthMethods).toContain('email_magic_link');
    expect(pack.pendingAuthArtifacts[0]!.tokenHash).toBe('e'.repeat(64));
    f.pendingArtifacts[0]!.kind = 'set_password';
    expect(() => buildRollbackAuthPack(f)).toThrow();
  });
  it('copies all supported stored hashes unchanged & bounds hostile encodings', () => {
    for (const value of [BCRYPT, PHC, 'scrypt$aa$' + 'ab'.repeat(64)]) expect(rollbackPassword(value).value).toBe(value);
    expect(rollbackPassword(null)).toEqual({ format: 'none', value: null });
    expect(() => rollbackPassword(BCRYPT.replace('$10$', '$31$'))).toThrow();
    expect(() => rollbackPassword(PHC.replace('m=19456', 'm=999999999'))).toThrow();
    expect(() => rollbackPassword('scrypt$aa$aa')).toThrow();
  });
});


describe('stable other-session inventory', () => {
  it('binds present hashes & all deadlines without exporting hashes or clock-derived flags', () => {
    const f = fixture();
    const input = { storeId: 'store', importedSessions: f.manifest.after.session, currentSessions: f.sessions };
    const inventory = stableOtherSessionInventory(input);
    expect(inventory[0]).toMatchObject({ presentInFinalTarget: true, originalExpiresAt: stamp(3), targetExpiresAt: stamp(3),
      legacyExpiresAt: stamp(2), tokenHashFingerprint: rollbackDigest({ tokenHash: H }) });
    expect(inventory[0]).not.toHaveProperty('state');
    expect(inventory[0]).not.toHaveProperty('sourceBridgeRequired');
    expect(JSON.stringify(inventory)).not.toContain(H);
    f.sessions[0]!.token_hash = 'f'.repeat(64);
    expect(rollbackDigest(stableOtherSessionInventory(input))).not.toBe(rollbackDigest(inventory));
    expect(stableOtherSessionInventory({ ...input, currentSessions: [] })[0]).toMatchObject({ presentInFinalTarget: false, tokenHashFingerprint: null });
    f.sessions[0]!.token_hash = 'raw-token';
    expect(() => stableOtherSessionInventory(input)).toThrow();
  });
});

describe('stateless federated issuance coverage', () => {
  const key = Buffer.alloc(32, 29); // Synthetic fixture key; never deployment configuration.
  const claims = { provider: 'google' as const, storeId: 'store', subject: 'Exact-Subject', email: 'private@example.test', firstName: null, lastName: null };
  const verify = (token: string, storeId: string, now: number) => verifyFederatedLink(token, storeId, now, key);
  const issue = (time: number) => signFederatedLink(claims, H, time, key);
  const payload = (token: string) => ({ url: 'https://store.example.test/sign-in/confirm?token=' + token });
  it('blocks active unlinked & consumed-marked issuances without invoking writes', () => {
    const token = issue(NOW); let verifications = 0;
    for (const row of [{ id: 'unlinked', customer_id: null, payload: payload(token) },
      { id: 'consumed', consumed_at: stamp(-1), payload: payload(token) }]) {
      try {
        assertFederatedIssuanceCoverage({ storeId: 'store', rows: [row], now: NOW }, (value, storeId, now) => {
          verifications++; expect(now).toBe(0); return verify(value, storeId, now);
        });
        throw new Error('Active issuance escaped admission');
      } catch (error) {
        expect(error).toBeInstanceOf(RollbackAuthBlocked);
        expect(error).toMatchObject({ code: 'federated_issuance_active', entityId: row.id });
        const diagnostics = JSON.stringify(error) + String(error);
        expect(diagnostics).not.toContain(token); expect(diagnostics).not.toContain(claims.email);
      }
    }
    expect(verifications).toBe(2);
  });
  it('admits only authenticated expired issuances, rejecting malformed & forged expiry', () => {
    const expired = issue(NOW - 3_600_000);
    expect(() => assertFederatedIssuanceCoverage({ storeId: 'store', rows: [{ id: 'expired', payload: payload(expired) }], now: NOW }, verify)).not.toThrow();
    expect(() => assertFederatedIssuanceCoverage({ storeId: 'store', rows: [{ id: 'malformed', payload: { url: 'broken' } }], now: NOW }, verify)).toThrow('federated_issuance_unparseable');
    const forged = expired.split('.')[0] + '.invalid_signature';
    expect(() => assertFederatedIssuanceCoverage({ storeId: 'store', rows: [{ id: 'forged', payload: payload(forged) }], now: NOW }, verify)).toThrow('federated_issuance_expiry_unproven');
    expect(() => assertFederatedIssuanceCoverage({ storeId: 'other', rows: [{ id: 'wrong-store', payload: payload(expired) }], now: NOW }, verify)).toThrow('federated_issuance_expiry_unproven');
  });
});
