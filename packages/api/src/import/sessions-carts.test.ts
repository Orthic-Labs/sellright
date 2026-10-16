import { describe, expect, it } from 'vitest';
import { legacyTokenHash, validSourceSession } from './sessions-carts.js';
import { legacyRollbackDecision, legacyRollbackSessionInventory } from './restore.js';

const now = Date.UTC(2026, 9, 16);
const future = new Date(now + 3600000).toISOString();
const grant = { id: 'grant', authenticated: true, store_id: 'store', customer_id: 'customer', session_id: 'session', token_hash: 'hash', expires_at: future };
const customer = { email: 'first@example.com', password_hash: 'unchanged', email_verified: true };
const session = { id: 'session', store_id: 'store', customer_id: 'customer', token_hash: 'hash', expires_at: future };
const decision = (over: Partial<Parameters<typeof legacyRollbackDecision>[0]> = {}) => legacyRollbackDecision({
  grant, importedCustomer: customer, currentCustomer: customer, currentSession: session, currentGrant: grant, now, ...over,
});

describe('frozen source session eligibility', () => {
  const source = { type: 'AuthenticatedSession', invalidated: false, expires: future, channel: 1 };
  it('requires future validity & exact selected channel for authenticated or guest capabilities', () => {
    expect(validSourceSession(source, 1, now)).toBe(true);
    expect(validSourceSession({ ...source, type: 'AnonymousSession' }, 1, now)).toBe(true);
    expect(validSourceSession(source, 2, now)).toBe(false);
    expect(validSourceSession({ ...source, invalidated: true }, 1, now)).toBe(false);
    expect(validSourceSession({ ...source, expires: new Date(now).toISOString() }, 1, now)).toBe(false);
    expect(validSourceSession({ ...source, type: 'ApiKeySession' }, 1, now)).toBe(false);
  });
  it('hashes raw proof without retaining a readable token', () => {
    expect(legacyTokenHash('proof')).toMatch(/^[0-9a-f]{64}$/);
    expect(legacyTokenHash('proof')).not.toContain('proof');
  });
});

describe('rollback capability reconciliation', () => {
  it('cannot resurrect deleted/revoked/cross-tenant/expired target capabilities', () => {
    expect(decision({ currentSession: undefined }).invalidate).toBe(true);
    expect(decision({ currentGrant: undefined }).invalidate).toBe(true);
    expect(decision({ currentGrant: { ...grant, source_session_id: 'changed' } }).invalidate).toBe(true);
    expect(decision({ currentGrant: { ...grant, store_id: 'other' } }).invalidate).toBe(true);
    expect(decision({ currentSession: { ...session, store_id: 'other' } }).invalidate).toBe(true);
    expect(decision({ currentSession: { ...session, expires_at: new Date(now).toISOString() } }).invalidate).toBe(true);
  });
  it.each(['email', 'password_hash', 'email_verified', 'google_sub', 'apple_user_id'])('blocks reopening after unsupported %s account delta', key => {
    expect(decision({ currentCustomer: { ...customer, [key]: 'changed' } })).toMatchObject({ invalidate: true, accountReconciliationRequired: true });
  });
  it('preserves earliest expiry & never extends original source lifetime', () => {
    expect(decision({ currentSession: { ...session, expires_at: new Date(now + 7200000).toISOString() } }).expiresAt).toBe(future);
    expect(decision({ currentSession: { ...session, expires_at: new Date(now + 1000).toISOString() } }).expiresAt).toBe(new Date(now + 1000).toISOString());
    expect(decision({ currentSession: { ...session, legacy_expires_at: new Date(now).toISOString() } }).invalidate).toBe(true);
    expect(decision().invalidate).toBe(false);
  });
});

describe('rollback native session inventory', () => {
  it('includes new native sessions, deleted imported sessions & expired sessions without credential material', () => {
    const rows = legacyRollbackSessionInventory({ storeId: 'store', importedSessions: [session], now,
      currentSessions: [{ ...session, id: 'new-native', token_hash: 'never-export-secret' },
        { ...session, id: 'expired-native', expires_at: new Date(now).toISOString() },
        { ...session, id: 'admin-native', customer_id: null, admin_user_id: 'admin' }] });
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetSessionId: 'session', state: 'deleted', sourceBridgeRequired: false }),
      expect.objectContaining({ targetSessionId: 'new-native', state: 'active', imported: false, sourceBridgeRequired: true }),
      expect.objectContaining({ targetSessionId: 'expired-native', state: 'expired', sourceBridgeRequired: false }),
      expect.objectContaining({ targetSessionId: 'admin-native', targetAdminUserId: 'admin', sourceBridgeRequired: true }),
    ]));
    expect(JSON.stringify(rows)).not.toMatch(/token_hash|never-export-secret/);
  });
  it('requires source reconciliation for changed imported identity & rejects tenant contamination', () => {
    expect(legacyRollbackSessionInventory({ storeId: 'store', importedSessions: [session],
      currentSessions: [{ ...session, token_hash: 'changed' }], now })[0]).toMatchObject({ exactImported: false, sourceBridgeRequired: true });
    expect(() => legacyRollbackSessionInventory({ storeId: 'other', importedSessions: [session], currentSessions: [] })).toThrow('tenant mismatch');
  });
});
