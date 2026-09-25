import { describe, it, expect } from 'vitest';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  signToken,
  verifyToken,
  canonicalPayload,
  signEntitlement,
  signLeaseEnvelope,
  verifyLeaseEnvelope,
  _resetSigningKeyCache,
  type SignedPayload,
} from './sign.js';
// Portable wire-format vector: the claim VALUES are arbitrary test data; what
// matters is that a token produced by an external signer (the desktop apps'
// native verifier counterpart) verifies byte-for-byte under canonicalPayload.
import publicVector from './test-vectors/license-v2.json' with { type: 'json' };

const payload: SignedPayload = {
  v: 2,
  id: 'lic_1',
  app: 'testapp',
  tier: 'pro',
  features: ['feature_a', 'feature_b'],
  device_id: 'dev-1',
  iat: 1000,
  exp: 2000,
};

describe('signed entitlement token', () => {
  it('verifies the portable public license-v2 vector', () => {
    const rawKey = Buffer.from(publicVector.publicKeyBase64url, 'base64url');
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]),
      format: 'der',
      type: 'spki',
    });

    expect(verifyToken(publicVector.token, publicKey)).toMatchObject({
      app: publicVector.expectedApp,
      device_id: publicVector.expectedDeviceId,
      tier: publicVector.expectedTier,
      features: publicVector.expectedFeatures,
    });
  });

  it('round-trips: a signed token verifies with the matching public key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const token = signToken(payload, privateKey);
    expect(verifyToken(token, publicKey)).toEqual(payload);
  });

  it('rejects tampering: a forged payload (extra feature) does not verify', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const token = signToken(payload, privateKey);
    const sig = token.slice(token.indexOf('.') + 1);
    const forgedPayload = Buffer.from(
      canonicalPayload({ ...payload, features: [...payload.features, 'feature_c'] }),
      'utf8',
    ).toString('base64url');
    expect(verifyToken(`${forgedPayload}.${sig}`, publicKey)).toBeNull();
  });

  it('rejects a token signed by a different key', () => {
    const a = generateKeyPairSync('ed25519');
    const b = generateKeyPairSync('ed25519');
    const token = signToken(payload, a.privateKey);
    expect(verifyToken(token, b.publicKey)).toBeNull();
  });

  it('rejects malformed tokens', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    expect(verifyToken('', publicKey)).toBeNull();
    expect(verifyToken('no-dot', publicKey)).toBeNull();
    expect(verifyToken('.onlysig', publicKey)).toBeNull();
  });

  // The CROSS-LANGUAGE contract: the client verifier must produce these exact bytes.
  it('canonical payload is fixed field order + compact (the wire contract)', () => {
    expect(canonicalPayload(payload)).toBe(
      '{"v":2,"id":"lic_1","app":"testapp","tier":"pro","features":["feature_a","feature_b"],"device_id":"dev-1","iat":1000,"exp":2000}',
    );
  });

  it('signEntitlement returns null when no signing key is configured (graceful degrade)', () => {
    const prev = process.env.LICENSE_SIGNING_KEY;
    delete process.env.LICENSE_SIGNING_KEY;
    _resetSigningKeyCache();
    try {
      expect(signEntitlement({ licenseId: 'lic_1', app: 'testapp', tier: 'pro', features: [], deviceId: 'd' })).toBeNull();
    } finally {
      if (prev !== undefined) process.env.LICENSE_SIGNING_KEY = prev;
      _resetSigningKeyCache();
    }
  });

  it('signEntitlement mints a verifiable token + sets exp from ttl', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    process.env.LICENSE_SIGNING_KEY = (privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
    _resetSigningKeyCache();
    try {
      const token = signEntitlement(
        { licenseId: 'lic_9', app: 'testapp', tier: 'pro', features: ['routing'], deviceId: 'dev-9', ttlSeconds: 100 },
        10_000, // now = 10s
      );
      expect(token).not.toBeNull();
      const v = verifyToken(token as string, publicKey);
      expect(v).toMatchObject({ v: 2, id: 'lic_9', app: 'testapp', tier: 'pro', features: ['routing'], device_id: 'dev-9', iat: 10, exp: 110 });
    } finally {
      delete process.env.LICENSE_SIGNING_KEY;
      _resetSigningKeyCache();
    }
  });

  it('defaults ttlSeconds to 7 days (SEC: lowered from 30d) when unset and ENTITLEMENT_TTL_SECONDS is unset', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    process.env.LICENSE_SIGNING_KEY = (privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
    _resetSigningKeyCache();
    try {
      const token = signEntitlement(
        { licenseId: 'lic_default_ttl', app: 'testapp', tier: 'pro', features: [], deviceId: 'd' },
        10_000, // now = 10s
      );
      const v = verifyToken(token as string, publicKey);
      expect(v!.iat).toBe(10);
      expect(v!.exp - v!.iat).toBe(7 * 86_400);
    } finally {
      delete process.env.LICENSE_SIGNING_KEY;
      _resetSigningKeyCache();
    }
  });

  it('signEntitlement clamps exp to expiresAtUnix (trial offline token cannot outlive expiry)', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    process.env.LICENSE_SIGNING_KEY = (privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
    _resetSigningKeyCache();
    try {
      // ttl would push exp to 30, but the license expires at 15 → exp clamps to 15.
      const clamped = signEntitlement(
        { licenseId: 'lic_t', app: 'testapp', tier: 'pro', features: [], deviceId: 'd', ttlSeconds: 20, expiresAtUnix: 15 },
        10_000, // now = 10s
      );
      expect(verifyToken(clamped as string, publicKey)).toMatchObject({ iat: 10, exp: 15 });

      // When the rolling TTL ends BEFORE expiry, the TTL wins (no extension).
      const ttlWins = signEntitlement(
        { licenseId: 'lic_t', app: 'testapp', tier: 'pro', features: [], deviceId: 'd', ttlSeconds: 5, expiresAtUnix: 999 },
        10_000,
      );
      expect(verifyToken(ttlWins as string, publicKey)).toMatchObject({ iat: 10, exp: 15 });
    } finally {
      delete process.env.LICENSE_SIGNING_KEY;
      _resetSigningKeyCache();
    }
  });

  it('signs the server-owned license lifecycle and exact expiry boundary', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    process.env.LICENSE_SIGNING_KEY = (privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
    _resetSigningKeyCache();
    try {
      const token = signEntitlement({
        licenseId: 'lic_life',
        app: 'testapp',
        tier: 'pro',
        features: ['wake_word'],
        deviceId: 'dev-life',
        tokenExpiresAtUnix: 2_000,
        licenseKind: 'lifetime',
        entitlementStage: 'provisional',
        licenseIssuedAtUnix: 1_000,
        confirmationDueAtUnix: 2_000,
      }, 1_500_000);

      expect(verifyToken(token as string, publicKey)).toMatchObject({
        iat: 1_500,
        exp: 2_000,
        license_kind: 'lifetime',
        entitlement_stage: 'provisional',
        license_issued_at: 1_000,
        confirmation_due_at: 2_000,
      });
    } finally {
      delete process.env.LICENSE_SIGNING_KEY;
      _resetSigningKeyCache();
    }
  });

  it('signEntitlement reads the key from LICENSE_SIGNING_KEY_FILE (box deploy path)', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const dir = mkdtempSync(join(tmpdir(), 'sr-test-key-'));
    const tmp = join(dir, 'key.pem');
    writeFileSync(tmp, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, { mode: 0o600, flag: 'wx' });
    const prevInline = process.env.LICENSE_SIGNING_KEY;
    delete process.env.LICENSE_SIGNING_KEY;
    process.env.LICENSE_SIGNING_KEY_FILE = tmp;
    _resetSigningKeyCache();
    try {
      const token = signEntitlement({ licenseId: 'lic_f', app: 'testapp', tier: 'pro', features: [], deviceId: 'dev-f' });
      expect(token).not.toBeNull();
      expect(verifyToken(token as string, publicKey)?.id).toBe('lic_f');
    } finally {
      delete process.env.LICENSE_SIGNING_KEY_FILE;
      if (prevInline !== undefined) process.env.LICENSE_SIGNING_KEY = prevInline;
      _resetSigningKeyCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lease envelopes sign and verify independently of the entitlement token', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    process.env.LICENSE_SIGNING_KEY = (privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
    _resetSigningKeyCache();
    try {
      const canonical = '{"leaseId":"l1","deviceIdHash":"d","pool":"computer","issuedAt":"i","expiresAt":"e","graceSeconds":0,"generation":0}';
      const sig = signLeaseEnvelope(canonical);
      expect(sig).not.toBeNull();
      expect(verifyLeaseEnvelope(canonical, sig as string, publicKey)).toBe(true);
      expect(verifyLeaseEnvelope(`${canonical}x`, sig as string, publicKey)).toBe(false);
    } finally {
      delete process.env.LICENSE_SIGNING_KEY;
      _resetSigningKeyCache();
    }
  });
});
