/**
 * Frozen signed-claims golden (plan 3.7 / compat goldens 1.3).
 *
 * Pins, byte for byte: the v:2 canonical field order, tokens for fixed inputs
 * under a fixed test-only signing key, and the lease-envelope canonical bytes
 * (which carry NO version field). Any change fails; regenerate deliberately
 * with UPDATE_GOLDENS=1 and review the diff as a wire-format change.
 *
 * Also proves the "existing verifier" property with an INDEPENDENT minimal
 * verifier written here (no import from sign.ts), shaped like the shipped
 * native verifiers: split on '.', verify Ed25519 over the decoded first
 * segment's raw bytes, then read claims by name.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, createPrivateKey, createPublicKey, verify as edVerify, type KeyObject } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  V2_FIELD_ORDER, _resetSigningKeyCache, canonicalPayload, negotiateSignedVersion, parseOfferedVersions,
  registerSignedFormat, resetSignedFormatsForTest, signEntitlement, signLeaseEnvelope, supportedSignedVersions,
} from './sign.js';
import { canonicalLeaseEnvelope } from './device-leases.js';
import { clearEntitlementPolicy, policyClaims } from './entitlement-policy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(HERE, 'test-vectors', 'signed-v2.golden.json');
const FIXED_NOW_MS = 1791547200000; // 2026-10-09T12:00:00.000Z
const SEED = createHash('sha256').update('rightsites-defork-compat-golden-signing-seed-v1').digest();
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const PEM = `-----BEGIN PRIVATE KEY-----\n${Buffer.concat([PKCS8_PREFIX, SEED]).toString('base64')}\n-----END PRIVATE KEY-----\n`;

const privateKey: KeyObject = createPrivateKey(PEM);
const publicKey = createPublicKey(privateKey);
const publicKeyB64u = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');

const BASE = {
  licenseId: '00000000-0000-4000-8000-000000000001', app: 'heardright', tier: 'pro',
  features: ['wake_word', 'voice_commands'], deviceId: 'compat-device-1',
};
const LIFECYCLE = {
  licenseKind: 'term' as const, entitlementStage: 'time_bound' as const,
  licenseIssuedAtUnix: 1791460800, confirmationDueAtUnix: 1792152000, tokenExpiresAtUnix: 1792152000,
};

const CASES: Array<{ name: string; input: Parameters<typeof signEntitlement>[0] }> = [
  { name: 'v2_minimal_default_policy', input: { ...BASE, ttlSeconds: 604800 } },
  { name: 'v2_expiry_clamped', input: { ...BASE, ttlSeconds: 604800, expiresAtUnix: 1791633600 } },
  { name: 'v2_lifecycle_claims', input: { ...BASE, ...LIFECYCLE } },
  { name: 'v2_lifecycle_null_confirmation', input: { ...BASE, ...LIFECYCLE, confirmationDueAtUnix: null } },
  { name: 'v2_scope_mobile', input: { ...BASE, ttlSeconds: 604800, entitlementScope: 'mobile' } },
  { name: 'v2_all_claims', input: { ...BASE, ...LIFECYCLE, entitlementScope: 'full' } },
];

const LEASE_CORE = {
  leaseId: '00000000-0000-4000-8000-0000000000a1', deviceIdHash: 'c71da430419be2357f9656e909647013db8be7c21653ff1b4b9c9bd1a69b712d',
  pool: 'computer', issuedAt: '2026-10-09T12:00:00.000Z', expiresAt: '2026-10-16T12:00:00.000Z', graceSeconds: 1209600, generation: 0,
};
const LEASE_CASES = [
  { name: 'lease_default_policy', core: LEASE_CORE },
  { name: 'lease_scope_mobile', core: { ...LEASE_CORE, pool: 'mobile', entitlementScope: 'mobile' as const } },
];

/** Independent minimal verifier (native-verifier shape). */
function nativeStyleVerify(token: string, pub: KeyObject): Record<string, unknown> | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const msg = Buffer.from(token.slice(0, dot), 'base64url');
  const sig = Buffer.from(token.slice(dot + 1), 'base64url');
  if (!edVerify(null, msg, pub, sig)) return null;
  return JSON.parse(msg.toString('utf8')) as Record<string, unknown>;
}

function compute() {
  _resetSigningKeyCache();
  process.env.LICENSE_SIGNING_KEY = PEM.replace(/\n/g, '\\n');
  const tokens = CASES.map(({ name, input }) => {
    const token = signEntitlement(input, FIXED_NOW_MS)!;
    const msg = Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8');
    return { name, input, canonical: msg, token };
  });
  const leases = LEASE_CASES.map(({ name, core }) => {
    const canonical = canonicalLeaseEnvelope(core as Parameters<typeof canonicalLeaseEnvelope>[0]);
    return { name, canonical, signature: signLeaseEnvelope(canonical) };
  });
  return {
    schemaVersion: 1, fixedNowMs: FIXED_NOW_MS, publicKeyBase64url: publicKeyB64u,
    v2FieldOrder: [...V2_FIELD_ORDER], tokens, leases,
  };
}

beforeAll(() => { clearEntitlementPolicy(); });
afterAll(() => { delete process.env.LICENSE_SIGNING_KEY; _resetSigningKeyCache(); resetSignedFormatsForTest(); });

describe('signed entitlement golden (frozen v:2)', () => {
  it('matches the golden bytes', () => {
    const actual = compute();
    if (process.env.UPDATE_GOLDENS === '1') writeFileSync(GOLDEN_PATH, JSON.stringify(actual, null, 2) + '\n');
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
    expect(actual).toEqual(golden);
  });

  it('pins the v:2 field order literally', () => {
    expect([...V2_FIELD_ORDER]).toEqual([
      'v', 'id', 'app', 'tier', 'features', 'device_id', 'iat', 'exp',
      'license_kind', 'entitlement_stage', 'license_issued_at', 'confirmation_due_at', 'entitlement_scope',
    ]);
  });

  it('default-policy tokens carry no policy claim and are verifiable by an independent verifier', () => {
    const { tokens } = compute();
    for (const t of tokens) {
      const claims = nativeStyleVerify(t.token, publicKey);
      expect(claims, t.name).not.toBeNull();
      expect(claims!.v).toBe(2);
      const keys = Object.keys(claims!);
      // keys appear in frozen order (subsequence of V2_FIELD_ORDER)
      expect(keys.map((k) => V2_FIELD_ORDER.indexOf(k as never))).toEqual([...keys.map((k) => V2_FIELD_ORDER.indexOf(k as never))].sort((a, b) => a - b));
      expect(keys.every((k) => V2_FIELD_ORDER.includes(k as never))).toBe(true);
    }
    const minimal = tokens.find((t) => t.name === 'v2_minimal_default_policy')!;
    expect(Object.keys(JSON.parse(minimal.canonical))).toEqual(['v', 'id', 'app', 'tier', 'features', 'device_id', 'iat', 'exp']);
  });

  it('default policy yields no claims (so default bytes equal the pre-policy bytes)', () => {
    expect(policyClaims({ path: 'lease_issue', license: { appKey: 'heardright', metadata: { entitlement_scope: 'mobile' } }, pool: 'mobile' })).toEqual({});
  });

  it('the shipped public vector still verifies under canonicalPayload', () => {
    const vec = JSON.parse(readFileSync(join(HERE, 'test-vectors', 'license-v2.json'), 'utf8'));
    const pub = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(vec.publicKeyBase64url, 'base64url')]), format: 'der', type: 'spki' });
    const claims = nativeStyleVerify(vec.token, pub)!;
    expect(claims).not.toBeNull();
    const msg = Buffer.from(vec.token.split('.')[0], 'base64url').toString('utf8');
    expect(canonicalPayload(claims as never)).toBe(msg);
  });
});

describe('capability-negotiated versions', () => {
  afterAll(() => resetSignedFormatsForTest());

  it('defaults to v:2 with no offer, an unknown offer, or an empty offer', () => {
    resetSignedFormatsForTest();
    expect(supportedSignedVersions()).toEqual([2]);
    expect(negotiateSignedVersion(undefined)).toBe(2);
    expect(negotiateSignedVersion([])).toBe(2);
    expect(negotiateSignedVersion([3, 4])).toBe(2);
  });

  it('parses the offer header defensively', () => {
    expect(parseOfferedVersions('2, 3')).toEqual([2, 3]);
    expect(parseOfferedVersions('x,,-1,99999999')).toBeUndefined();
    expect(parseOfferedVersions(undefined)).toBeUndefined();
  });

  it('cannot replace or shadow v:2, or register the same version twice', () => {
    resetSignedFormatsForTest();
    expect(() => registerSignedFormat({ v: 2, fieldOrder: ['v'] })).toThrow(/frozen/);
    registerSignedFormat({ v: 3, fieldOrder: [...V2_FIELD_ORDER, 'extra'], extraClaims: () => ({ extra: 'x' }) });
    expect(() => registerSignedFormat({ v: 3, fieldOrder: ['v'] })).toThrow(/already registered/);
  });

  it('a registered format must carry EVERY v:2 claim (cannot drop entitlement_scope)', () => {
    resetSignedFormatsForTest();
    const withoutScope = V2_FIELD_ORDER.filter((k) => k !== 'entitlement_scope');
    expect(() => registerSignedFormat({ v: 3, fieldOrder: withoutScope })).toThrow(/entitlement_scope/);
    expect(supportedSignedVersions()).toEqual([2]);
    // so a mobile-scope holder offering v3 can never receive a token without the restriction
    expect(negotiateSignedVersion([3])).toBe(2);
  });

  it('format extras can add claims but never override or inject a v:2 claim', () => {
    resetSignedFormatsForTest();
    registerSignedFormat({
      v: 3, fieldOrder: [...V2_FIELD_ORDER, 'extra'],
      extraClaims: () => ({ extra: 'x', entitlement_scope: 'full', exp: 1, tier: 'enterprise' }),
    });
    compute();
    const mobile = nativeStyleVerify(signEntitlement({ ...BASE, ttlSeconds: 604800, entitlementScope: 'mobile', offeredVersions: [3] }, FIXED_NOW_MS)!, publicKey)!;
    expect(mobile.v).toBe(3);
    expect(mobile.entitlement_scope).toBe('mobile');
    expect(mobile.tier).toBe('pro');
    expect(mobile.exp).toBe(FIXED_NOW_MS / 1000 + 604800);
    const noScope = nativeStyleVerify(signEntitlement({ ...BASE, ttlSeconds: 604800, offeredVersions: [3] }, FIXED_NOW_MS)!, publicKey)!;
    expect(noScope).not.toHaveProperty('entitlement_scope'); // an extra cannot inject the scope claim either
    expect(noScope.extra).toBe('x');
  });

  it('emits a higher version only to a client that offered it; others keep byte-identical v:2', () => {
    resetSignedFormatsForTest();
    registerSignedFormat({ v: 3, fieldOrder: [...V2_FIELD_ORDER, 'extra'], extraClaims: () => ({ extra: 'x' }) });
    compute();
    const base = { ...BASE, ttlSeconds: 604800 };
    const legacy = signEntitlement(base, FIXED_NOW_MS)!;
    expect(signEntitlement({ ...base, offeredVersions: [2] }, FIXED_NOW_MS)).toBe(legacy);
    expect(signEntitlement({ ...base, offeredVersions: [9] }, FIXED_NOW_MS)).toBe(legacy);
    const v3 = nativeStyleVerify(signEntitlement({ ...base, offeredVersions: [2, 3] }, FIXED_NOW_MS)!, publicKey)!;
    expect(v3.v).toBe(3);
    expect(v3.extra).toBe('x');
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
    expect(legacy).toBe(golden.tokens.find((t: { name: string }) => t.name === 'v2_minimal_default_policy').token);
  });
});
