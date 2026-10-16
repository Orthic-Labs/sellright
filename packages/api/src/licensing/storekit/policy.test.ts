// Unit tests for the StoreKit policy contract (STOREKIT §3, §8 T-K10, T-K13).
import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetStoreKitPoliciesForTests,
  registerStoreKitPolicy,
  storeKitPolicyFor,
  type LinkOutcome,
} from './policy.js';
import { sellrightDefaultPolicy, sellrightRespond } from './default-policy.js';
import { forkReferencePolicy, FORK_APP_KEY, FORK_MESSAGE, FORK_PRODUCTS } from './fork-reference-policy.kit.js';
import type { StoreKitAppConfig } from '../storekit-config.js';

const PRODUCT = 'app.example.pro.lifetime';
const appCfg = (appKey: string): StoreKitAppConfig => ({
  id: 'app-1', storeId: 'store-1', appKey, bundleId: 'app.example.ios', productMap: { [PRODUCT]: { tier: 'pro', seats: 2 }, [FORK_PRODUCTS.mobile]: { tier: 'mobile', seats: 0 } },
} as unknown as StoreKitAppConfig);

beforeEach(() => {
  _resetStoreKitPoliciesForTests();
  registerStoreKitPolicy(sellrightDefaultPolicy);
  registerStoreKitPolicy(forkReferencePolicy);
});

describe('policy registry', () => {
  it('serves each appKey from its own policy and everything else from the fallback', () => {
    expect(storeKitPolicyFor(FORK_APP_KEY).id).toBe('rightsuite-fork-reference');
    expect(storeKitPolicyFor('exampleapp').id).toBe('sellright-default');
  });

  it('refuses a second policy for an appKey that is already served', () => {
    expect(() => registerStoreKitPolicy({ ...forkReferencePolicy, id: 'dup' })).toThrow(/already served/);
  });

  it('refuses a second fallback policy', () => {
    expect(() => registerStoreKitPolicy({ ...sellrightDefaultPolicy, id: 'second-default' })).toThrow(/fallback/);
  });

  it('throws when no policy is registered', () => {
    _resetStoreKitPoliciesForTests();
    expect(() => storeKitPolicyFor('exampleapp')).toThrow(/no StoreKit policy/);
  });
});

describe('decideMaterialize (T-K13)', () => {
  const purchase = { storeId: 'store-1', environment: 'Sandbox', originalTransactionId: '1' };
  const base = { appCfg: appCfg('exampleapp'), environment: 'Sandbox', purchase };

  it('default policy: materialize only for renew and restore, with the configured entitlement', () => {
    const d = (action: 'revoke' | 'restore' | 'renew' | 'expire') =>
      sellrightDefaultPolicy.decideMaterialize({ ...base, action, productId: PRODUCT });
    expect(d('renew')).toEqual({ materialize: true, entitlement: { tier: 'pro', seats: 2 } });
    expect(d('restore')).toEqual({ materialize: true, entitlement: { tier: 'pro', seats: 2 } });
    expect(d('revoke')).toEqual({ materialize: false });
    expect(d('expire')).toEqual({ materialize: false });
  });

  it('fork reference: heardright materializes every action except the upgrade product', () => {
    const fork = { ...base, appCfg: appCfg(FORK_APP_KEY) };
    for (const action of ['revoke', 'restore', 'renew', 'expire'] as const) {
      expect(forkReferencePolicy.decideMaterialize({ ...fork, action, productId: FORK_PRODUCTS.legacy }).materialize).toBe(true);
      expect(forkReferencePolicy.decideMaterialize({ ...fork, action, productId: FORK_PRODUCTS.upgrade }).materialize).toBe(false);
    }
  });
});

describe('respond precedence (T-K10, default wire)', () => {
  const cases: Array<[string, LinkOutcome, number, string | null]> = [
    ['no_config', { kind: 'no_config' }, 400, 'StoreKit purchases are not configured for this app'],
    ['malformed', { kind: 'verify_failed', reason: 'malformed' }, 400, 'the App Store transaction could not be verified'],
    ['bad_signature', { kind: 'verify_failed', reason: 'bad_signature' }, 400, 'the App Store transaction could not be verified'],
    ['wrong_bundle', { kind: 'verify_failed', reason: 'wrong_bundle' }, 400, 'this transaction was not issued for this app'],
    ['wrong_product', { kind: 'verify_failed', reason: 'wrong_product' }, 400, 'this transaction was not issued for this app'],
    ['wrong_environment', { kind: 'verify_failed', reason: 'wrong_environment' }, 400, 'unexpected App Store environment'],
    ['revoked', { kind: 'verify_failed', reason: 'revoked' }, 422, 'this purchase was refunded or revoked by Apple'],
    ['unauth', { kind: 'unauth' }, 401, 'not authenticated, or purchase already linked to a different account'],
    ['validation 409', { kind: 'validation', status: 409, message: 'x' }, 409, 'x'],
    ['account_conflict', { kind: 'issue_rejected', result: { kind: 'account_conflict' } }, 401, 'not authenticated, or purchase already linked to a different account'],
    ['notfound', { kind: 'issue_rejected', result: { kind: 'rejected', code: 'notfound' } }, 400, 'license could not be activated'],
    ['seat_limit', { kind: 'issue_rejected', result: { kind: 'rejected', code: 'seat_limit' } }, 409, 'device seat limit reached'],
    ['lock_unstable', { kind: 'lock_unstable' }, 503, 'purchase is being updated; retry shortly'],
  ];
  for (const [name, outcome, status, message] of cases) {
    it(`${name} -> ${status}`, () => {
      const r = sellrightDefaultPolicy.respond(outcome);
      expect(r.status).toBe(status);
      if (r.status !== 200) expect((r as { message: string }).message).toBe(message);
    });
  }

  it('issued -> 200 lease-shaped body (SellRight wire)', () => {
    const expires = new Date('2030-01-01T00:00:00.000Z');
    const r = sellrightRespond({
      kind: 'issued',
      deviceIdHash: 'h',
      deviceLabel: null,
      result: {
        kind: 'ok', license: { id: 'l1', licenseKey: 'SK-X' }, entitlement: { tier: 'pro', seats: 2 } as never,
        disclosed: {},
        credential: {
          kind: 'activation', activationId: 'a1', deviceIdHash: 'h', activatedAt: null, activationToken: 'tok',
          lic: { id: 'l1', expiresAt: expires, metadata: {} },
        },
      },
    });
    expect(r).toEqual({
      status: 200,
      body: {
        ok: true,
        activationToken: 'tok',
        lease: {
          leaseId: 'a1', deviceIdHash: 'h', pool: 'mobile', entitlement: 'pro', issuedAt: null,
          expiresAt: expires.toISOString(), graceSeconds: 0, generation: 0, signature: null,
        },
      },
    });
  });
});

describe('fork-reference respond (heardright wire)', () => {
  it('platform rejection and every invalid-purchase issue result collapse to the fork 400 message', () => {
    const platform = forkReferencePolicy.respond({ kind: 'validation', status: 400, message: FORK_MESSAGE });
    expect(platform).toEqual({ status: 400, message: FORK_MESSAGE });
    for (const code of ['invalid_product', 'mobile_source_required', 'credit_used'] as const) {
      expect(forkReferencePolicy.respond({ kind: 'issue_rejected', result: { kind: 'rejected', code } }))
        .toEqual({ status: 400, message: FORK_MESSAGE });
    }
  });
});
