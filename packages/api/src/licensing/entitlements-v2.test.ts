import { afterEach, describe, expect, it } from 'vitest';
import {
  buildEntitlements,
  canReceiveTieredUpdate,
  clearTierCatalogs,
  registerTierCatalog,
  resolveAuthorizationTier,
} from './entitlements.js';

afterEach(() => clearTierCatalogs());

const NOW = new Date('2026-08-01T00:00:00Z');

describe('tier catalog registry', () => {
  it('resolves authorization tier through per-app plan aliases', () => {
    registerTierCatalog('myapp', { aliases: { personal: 'pro', household: 'pro' } });
    expect(resolveAuthorizationTier('myapp', 'personal')).toBe('pro');
    expect(resolveAuthorizationTier('myapp', 'household')).toBe('pro');
    expect(resolveAuthorizationTier('myapp', 'team')).toBe('team');
    expect(resolveAuthorizationTier('unregistered', 'pro')).toBe('pro');
    expect(resolveAuthorizationTier('unregistered', null)).toBeNull();
  });

  it('builds the versioned entitlement contract from metadata.tier + catalog features', () => {
    registerTierCatalog('myapp', { features: { pro: ['routing', 'brews'], plus: ['sync'] } });
    expect(buildEntitlements({ appKey: 'myapp', metadata: { tier: 'pro' } })).toEqual({
      v: 1, tier: 'pro', features: ['routing', 'brews'],
    });
    expect(buildEntitlements({ appKey: 'myapp', metadata: { tier: 'plus' } })).toEqual({
      v: 1, tier: 'plus', features: ['sync'],
    });
    // Explicit metadata.features[] overrides the catalog.
    expect(buildEntitlements({ appKey: 'myapp', metadata: { tier: 'pro', features: ['custom'] } })).toEqual({
      v: 1, tier: 'pro', features: ['custom'],
    });
    // Unknown tier → no features, tier still reported.
    expect(buildEntitlements({ appKey: 'myapp', metadata: { tier: 'gold' } })).toEqual({
      v: 1, tier: 'gold', features: [],
    });
    expect(buildEntitlements({ appKey: 'myapp', metadata: null })).toEqual({ v: 1, tier: null, features: [] });
  });

  it('applies tier aliases inside buildEntitlements while preserving the plan in metadata', () => {
    registerTierCatalog('myapp', { aliases: { household: 'pro' }, features: { pro: ['all'] } });
    expect(buildEntitlements({ appKey: 'myapp', metadata: { tier: 'household' } })).toEqual({
      v: 1, tier: 'pro', features: ['all'],
    });
  });
});

describe('canReceiveTieredUpdate', () => {
  const active = { status: 'active', updatesUntil: null as Date | null, expiresAt: null as Date | null, appKey: 'myapp' };

  it('grants private updates only to an active, in-window license at the required tier', () => {
    registerTierCatalog('myapp', { aliases: { household: 'pro' } });
    expect(canReceiveTieredUpdate({ ...active, metadata: { tier: 'pro' } }, 'pro', NOW)).toBe(true);
    expect(canReceiveTieredUpdate({ ...active, metadata: { tier: 'household' } }, 'pro', NOW)).toBe(true);
    expect(canReceiveTieredUpdate({ ...active, metadata: { tier: 'free' } }, 'pro', NOW)).toBe(false);
    expect(canReceiveTieredUpdate({ ...active, metadata: null }, 'pro', NOW)).toBe(false);
    expect(canReceiveTieredUpdate({ ...active, status: 'revoked', metadata: { tier: 'pro' } }, 'pro', NOW)).toBe(false);
    expect(canReceiveTieredUpdate(
      { ...active, updatesUntil: new Date('2026-07-01T00:00:00Z'), metadata: { tier: 'pro' } }, 'pro', NOW,
    )).toBe(false);
    expect(canReceiveTieredUpdate(
      { ...active, expiresAt: new Date('2026-07-01T00:00:00Z'), metadata: { tier: 'pro' } }, 'pro', NOW,
    )).toBe(false);
  });
});
