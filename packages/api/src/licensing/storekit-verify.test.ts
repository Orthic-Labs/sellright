/**
 * Unit tests for `verifyStoreKitTransaction` — ported upstream from
 * RightSites (storekit-official-verifier / storekit-sandbox-path), genericized
 * to a per-app StoreKitDeploymentConfig (no HeardRight constants, no env).
 *
 * The official `@apple/app-store-server-library` package is installed &
 * lockfile-pinned. Tests inject a verifier rooted in a throwaway CA;
 * production uses Apple's pinned roots plus online checks.
 *
 * Fixture shape, and why it differs from a hand-rolled-verifier test:
 * the OFFICIAL library enforces requirements a naive verifier doesn't model:
 *   - the x5c header array must have EXACTLY 3 certs (leaf, intermediate,
 *     root) — `INVALID_CHAIN_LENGTH` otherwise.
 *   - the leaf certificate must carry Apple's own custom certificate
 *     EXTENSION whose OID is "1.2.840.113635.100.6.11.1" (present as its
 *     own extension entry, not as an extendedKeyUsage purpose value), and
 *     the intermediate must carry "1.2.840.113635.100.6.2.1" the same way
 *     — these are Apple-specific "this cert may sign StoreKit receipts"
 *     markers with no real-world equivalent in a throwaway CA; the fixture
 *     below adds them manually via openssl (`<oid>=critical,ASN1:NULL` in
 *     the -extfile, NOT `extendedKeyUsage=<oid>` — the library's own check
 *     (`X509#getExtInfo(oid)`) matches an extension's OID, not a value
 *     inside the standard EKU extension).
 *   - `enableOnlineChecks` is used for the real verifier in production, but
 *     enabling it here would mean firing real OCSP requests against
 *     `cert.infoAccess`, which a throwaway CA doesn't have and no test
 *     network can serve — so the test-only verifier constructed below sets
 *     `enableOnlineChecks: false` (via the `_verifierForTests` escape hatch).
 *     Production ALWAYS uses `enableOnlineChecks: true` — see
 *     storekit-verify.ts's `buildVerifier`; that is NOT exercised by these
 *     tests.
 *
 * Negative coverage:
 *   - a forged/unsigned transaction is rejected (tampered payload -> bad_signature)
 *   - a corrupted signature is rejected (-> bad_signature)
 *   - a chain to an untrusted (attacker) root is rejected (-> bad_signature)
 *   - a revoked/refunded transaction does not verify as grantable (-> 'revoked')
 *   - wrong bundle id is rejected (-> 'wrong_bundle', enforced BY THE LIBRARY
 *     via the verifier's configured bundleId)
 *   - wrong product id is rejected (-> 'wrong_product', our own check, since
 *     Apple's library has no concept of "which product ids are ours")
 *   - a Sandbox transaction against a verifier configured for Production
 *     environment is rejected (-> 'wrong_environment' — environment is pinned
 *     by the VERIFIER's config, never taken from the request)
 *   - malformed JWS is rejected
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, sign as cryptoSign, X509Certificate } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Environment, SignedDataVerifier } from '@apple/app-store-server-library';
import {
  verifyStoreKitNotificationForDeployment,
  verifyStoreKitTransaction,
  verifyStoreKitTransactionForDeployment,
} from './storekit-verify.js';

const BUNDLE_ID = 'app.example.ios';
const PRODUCT_ID = 'app.example.pro.lifetime';
const LEAF_EKU_OID = '1.2.840.113635.100.6.11.1';
const INTERMEDIATE_EKU_OID = '1.2.840.113635.100.6.2.1';

let dir: string;
let rootDerB64: string;
let interDerB64: string;
let leafDerB64: string;
let leafPrivPem: string;
let goodVerifier: SignedDataVerifier;

function run(cmd: string, args: string[]) {
  execFileSync(cmd, args, { cwd: dir, stdio: 'pipe' });
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function derB64Of(pemFile: string): string {
  const pem = readFileSync(join(dir, pemFile), 'utf8');
  return pem.replace(/-----BEGIN CERTIFICATE-----/, '').replace(/-----END CERTIFICATE-----/, '').replace(/\s+/g, '');
}

function makeJws(payload: Record<string, unknown>, opts?: { x5c?: string[]; corruptSig?: boolean; corruptPayload?: boolean; signingKeyPem?: string }): string {
  const header = { alg: 'ES256', x5c: opts?.x5c ?? [leafDerB64, interDerB64, rootDerB64] };
  const headerB64 = b64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const key = createPrivateKey(opts?.signingKeyPem ?? leafPrivPem);
  const sig = cryptoSign('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' });
  const sigBuf = opts?.corruptSig ? Buffer.from(sig).map((b, i) => (i === 0 ? b ^ 0xff : b)) : sig;
  if (opts?.corruptPayload) {
    const tamperedPayloadB64 = b64url(Buffer.from(JSON.stringify({ ...payload, bundleId: 'com.attacker.evil' })));
    return `${headerB64}.${tamperedPayloadB64}.${b64url(Buffer.from(sigBuf))}`;
  }
  return `${headerB64}.${payloadB64}.${b64url(Buffer.from(sigBuf))}`;
}

function basePayload(overrides?: Record<string, unknown>) {
  return {
    transactionId: '2000000123456789',
    originalTransactionId: '2000000123456789',
    bundleId: BUNDLE_ID,
    productId: PRODUCT_ID,
    environment: 'Sandbox',
    purchaseDate: Date.now(),
    originalPurchaseDate: Date.now(),
    signedDate: Date.now(),
    type: 'Non-Consumable',
    ...overrides,
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sk-verify-test-'));

  // Root CA (self-signed, EC P-256 — matches Apple's real root/ES256 leaf curve family)
  run('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'root.key']);
  run('openssl', ['req', '-x509', '-new', '-key', 'root.key', '-days', '3650', '-subj', '/CN=Test Root CA/', '-addext', 'basicConstraints=critical,CA:true', '-out', 'root.pem']);

  // Intermediate CA, signed by root, carrying Apple's intermediate EKU OID
  run('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'inter.key']);
  run('openssl', ['req', '-new', '-key', 'inter.key', '-subj', '/CN=Test Intermediate CA/', '-out', 'inter.csr']);
  writeFileSync(join(dir, 'inter.ext'), `basicConstraints=critical,CA:true\n${INTERMEDIATE_EKU_OID}=critical,ASN1:NULL\n`);
  run('openssl', ['x509', '-req', '-in', 'inter.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-days', '3650', '-extfile', 'inter.ext', '-out', 'inter.pem']);

  // Leaf (end-entity), signed by intermediate, carrying Apple's leaf EKU OID
  run('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'leaf.key']);
  run('openssl', ['req', '-new', '-key', 'leaf.key', '-subj', '/CN=Test StoreKit Leaf/', '-out', 'leaf.csr']);
  writeFileSync(join(dir, 'leaf.ext'), `basicConstraints=critical,CA:false\n${LEAF_EKU_OID}=critical,ASN1:NULL\n`);
  run('openssl', ['x509', '-req', '-in', 'leaf.csr', '-CA', 'inter.pem', '-CAkey', 'inter.key', '-CAcreateserial', '-days', '3650', '-extfile', 'leaf.ext', '-out', 'leaf.pem']);

  leafPrivPem = readFileSync(join(dir, 'leaf.key'), 'utf8');
  rootDerB64 = derB64Of('root.pem');
  interDerB64 = derB64Of('inter.pem');
  leafDerB64 = derB64Of('leaf.pem');

  const rootDer = new X509Certificate(readFileSync(join(dir, 'root.pem'), 'utf8')).raw;
  // enableOnlineChecks: false — see file header; production always uses true.
  goodVerifier = new SignedDataVerifier([rootDer], false, Environment.SANDBOX, BUNDLE_ID);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('verifyStoreKitTransaction (official Apple verifier)', () => {
  it('accepts a validly-signed transaction and returns the verified payload', async () => {
    const jws = makeJws(basePayload());
    const out = await verifyStoreKitTransaction(jws, {
      allowedProductIds: [PRODUCT_ID], bundleId: BUNDLE_ID, environment: Environment.SANDBOX, _verifierForTests: goodVerifier,
    });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.payload.originalTransactionId).toBe('2000000123456789');
      expect(out.payload.bundleId).toBe(BUNDLE_ID);
    }
  });

  it('rejects a forged/unsigned transaction — payload tampered after signing', async () => {
    const jws = makeJws(basePayload(), { corruptPayload: true });
    const out = await verifyStoreKitTransaction(jws, {
      allowedProductIds: [PRODUCT_ID], bundleId: BUNDLE_ID, environment: Environment.SANDBOX, _verifierForTests: goodVerifier,
    });
    expect(out.kind).toBe('bad_signature');
  });

  it('rejects a transaction with a corrupted signature', async () => {
    const jws = makeJws(basePayload(), { corruptSig: true });
    const out = await verifyStoreKitTransaction(jws, {
      allowedProductIds: [PRODUCT_ID], bundleId: BUNDLE_ID, environment: Environment.SANDBOX, _verifierForTests: goodVerifier,
    });
    expect(out.kind).toBe('bad_signature');
  });

  it('rejects a chain that does not lead to the trusted root (attacker-controlled CA)', async () => {
    run('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'evil-root.key']);
    run('openssl', ['req', '-x509', '-new', '-key', 'evil-root.key', '-days', '30', '-subj', '/CN=Evil Root/', '-addext', 'basicConstraints=critical,CA:true', '-out', 'evil-root.pem']);
    run('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'evil-inter.key']);
    run('openssl', ['req', '-new', '-key', 'evil-inter.key', '-subj', '/CN=Evil Intermediate/', '-out', 'evil-inter.csr']);
    writeFileSync(join(dir, 'evil-inter.ext'), `basicConstraints=critical,CA:true\n${INTERMEDIATE_EKU_OID}=critical,ASN1:NULL\n`);
    run('openssl', ['x509', '-req', '-in', 'evil-inter.csr', '-CA', 'evil-root.pem', '-CAkey', 'evil-root.key', '-CAcreateserial', '-days', '30', '-extfile', 'evil-inter.ext', '-out', 'evil-inter.pem']);
    run('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'evil-leaf.key']);
    run('openssl', ['req', '-new', '-key', 'evil-leaf.key', '-subj', '/CN=Evil Leaf/', '-out', 'evil-leaf.csr']);
    writeFileSync(join(dir, 'evil-leaf.ext'), `basicConstraints=critical,CA:false\n${LEAF_EKU_OID}=critical,ASN1:NULL\n`);
    run('openssl', ['x509', '-req', '-in', 'evil-leaf.csr', '-CA', 'evil-inter.pem', '-CAkey', 'evil-inter.key', '-CAcreateserial', '-days', '30', '-extfile', 'evil-leaf.ext', '-out', 'evil-leaf.pem']);

    const jws = makeJws(basePayload(), {
      x5c: [derB64Of('evil-leaf.pem'), derB64Of('evil-inter.pem'), derB64Of('evil-root.pem')],
      signingKeyPem: readFileSync(join(dir, 'evil-leaf.key'), 'utf8'),
    });

    // Verified against the REAL (throwaway-test) trusted root, not evil-root — must fail.
    const out = await verifyStoreKitTransaction(jws, {
      allowedProductIds: [PRODUCT_ID], bundleId: BUNDLE_ID, environment: Environment.SANDBOX, _verifierForTests: goodVerifier,
    });
    expect(out.kind).toBe('bad_signature');
  });

  it('rejects a revoked/refunded transaction (revocationDate present)', async () => {
    const jws = makeJws(basePayload({ revocationDate: Date.now(), revocationReason: 1 }));
    const out = await verifyStoreKitTransaction(jws, {
      allowedProductIds: [PRODUCT_ID], bundleId: BUNDLE_ID, environment: Environment.SANDBOX, _verifierForTests: goodVerifier,
    });
    expect(out.kind).toBe('revoked');
  });

  it('rejects a transaction for the wrong bundle id (different app) — enforced by the verifier itself', async () => {
    const jws = makeJws(basePayload({ bundleId: 'com.someoneelse.app' }));
    const out = await verifyStoreKitTransaction(jws, {
      allowedProductIds: [PRODUCT_ID], bundleId: BUNDLE_ID, environment: Environment.SANDBOX, _verifierForTests: goodVerifier,
    });
    expect(out.kind).toBe('wrong_bundle');
  });

  it('rejects a transaction for the wrong product id', async () => {
    const jws = makeJws(basePayload({ productId: 'app.example.pro.monthly.fake' }));
    const out = await verifyStoreKitTransaction(jws, {
      allowedProductIds: [PRODUCT_ID], bundleId: BUNDLE_ID, environment: Environment.SANDBOX, _verifierForTests: goodVerifier,
    });
    expect(out.kind).toBe('wrong_product');
  });

  it('rejects malformed JWS input', async () => {
    // With the official library, a string that isn't JWT-shaped at all
    // fails inside its own JWT decode/validate step, which throws
    // VerificationException(VERIFICATION_FAILURE) (not FAILURE) — our
    // mapping puts that under 'bad_signature' alongside every other
    // signature/chain failure, not the narrower 'malformed'. 'malformed'
    // in THIS module is reserved for the case where the library verifies
    // successfully but a required field the route depends on
    // (bundleId/productId/originalTransactionId/transactionId) is still
    // absent from the decoded payload.
    const out1 = await verifyStoreKitTransaction('not-a-jws', { allowedProductIds: [PRODUCT_ID], bundleId: BUNDLE_ID, environment: Environment.SANDBOX, _verifierForTests: goodVerifier });
    expect(out1.kind).toBe('bad_signature');
    const out2 = await verifyStoreKitTransaction('a.b', { allowedProductIds: [PRODUCT_ID], bundleId: BUNDLE_ID, environment: Environment.SANDBOX, _verifierForTests: goodVerifier });
    expect(out2.kind).toBe('bad_signature');
  });

  it('rejects a Sandbox transaction against a verifier pinned to Production — environment comes from CONFIG, not the payload', async () => {
    // Environment is baked into the verifier's own construction. A verifier
    // built for PRODUCTION rejects a Sandbox-labelled payload even though the
    // signature itself is perfectly valid.
    const rootDer = new X509Certificate(readFileSync(join(dir, 'root.pem'), 'utf8')).raw;
    const prodVerifier = new SignedDataVerifier([rootDer], false, Environment.PRODUCTION, BUNDLE_ID, 123456789);
    const jws = makeJws(basePayload({ environment: 'Sandbox' }));
    const out = await verifyStoreKitTransaction(jws, {
      allowedProductIds: [PRODUCT_ID], bundleId: BUNDLE_ID, environment: Environment.PRODUCTION, appAppleId: 123456789, _verifierForTests: prodVerifier,
    });
    expect(out.kind).toBe('wrong_environment');
  });
});

describe('verifyStoreKitNotificationForDeployment', () => {
  it('verifies outer notification plus nested refunded transaction', async () => {
    const nested = makeJws(basePayload({ revocationDate: Date.now(), revocationReason: 1 }));
    const outer = makeJws({
      notificationType: 'REFUND',
      notificationUUID: '11111111-2222-4333-8444-555555555555',
      data: {
        environment: 'Sandbox',
        appAppleId: 6806854037,
        bundleId: BUNDLE_ID,
        bundleVersion: '1',
        signedTransactionInfo: nested,
      },
      version: '2.0',
      signedDate: Date.now(),
    });
    const out = await verifyStoreKitNotificationForDeployment(outer, {
      allowedProductIds: [PRODUCT_ID],
      bundleId: BUNDLE_ID,
      _verifiersForTests: { sandbox: goodVerifier },
    });
    expect(out.kind).toBe('ok');
    expect(out.matchedEnvironment).toBe(Environment.SANDBOX);
    if (out.kind === 'ok') {
      expect(out.payload.notificationType).toBe('REFUND');
      expect(out.payload.originalTransactionId).toBe('2000000123456789');
      expect(out.payload.revocationDate).not.toBeNull();
    }
  });

  it('rejects notification app metadata for another bundle', async () => {
    const outer = makeJws({
      notificationType: 'TEST',
      notificationUUID: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      data: { environment: 'Sandbox', bundleId: 'com.attacker.app' },
      version: '2.0',
      signedDate: Date.now(),
    });
    const out = await verifyStoreKitNotificationForDeployment(outer, {
      allowedProductIds: [PRODUCT_ID],
      bundleId: BUNDLE_ID,
      _verifiersForTests: { sandbox: goodVerifier },
    });
    expect(out.kind).toBe('wrong_bundle');
  });
});

// Dual-environment coverage for `verifyStoreKitTransactionForDeployment`
// (`verifyAcrossEnvironments` also has a focused dependency-free test file).
describe('verifyStoreKitTransactionForDeployment (Production+Sandbox dual verification)', () => {
  const APP_APPLE_ID = 123456789;
  let prodVerifier: SignedDataVerifier;

  beforeAll(() => {
    const rootDer = new X509Certificate(readFileSync(join(dir, 'root.pem'), 'utf8')).raw;
    prodVerifier = new SignedDataVerifier([rootDer], false, Environment.PRODUCTION, BUNDLE_ID, APP_APPLE_ID);
  });

  it('a genuine Sandbox transaction verifies as Sandbox when appAppleId (Production) IS configured', async () => {
    // Production is attempted first (per the function's documented order)
    // and correctly reports wrong_environment for a Sandbox-labelled
    // payload, falling through to Sandbox, which matches.
    const jws = makeJws(basePayload({ environment: 'Sandbox' }));
    const out = await verifyStoreKitTransactionForDeployment(jws, {
      allowedProductIds: [PRODUCT_ID], bundleId: BUNDLE_ID, appAppleId: APP_APPLE_ID,
      _verifiersForTests: { production: prodVerifier, sandbox: goodVerifier },
    });
    expect(out.kind).toBe('ok');
    expect(out.matchedEnvironment).toBe(Environment.SANDBOX);
  });

  it('a genuine Production transaction verifies as Production when appAppleId IS configured', async () => {
    const jws = makeJws(basePayload({ environment: 'Production' }));
    const out = await verifyStoreKitTransactionForDeployment(jws, {
      allowedProductIds: [PRODUCT_ID], bundleId: BUNDLE_ID, appAppleId: APP_APPLE_ID,
      _verifiersForTests: { production: prodVerifier, sandbox: goodVerifier },
    });
    expect(out.kind).toBe('ok');
    expect(out.matchedEnvironment).toBe(Environment.PRODUCTION);
  });

  it('a Production-labelled transaction is REJECTED (never silently accepted as Sandbox) when appAppleId is unset', async () => {
    // The core isolation property: without appAppleId configured, this
    // deployment never even constructs a Production verifier — a
    // Production-environment transaction must not be accepted by falling
    // through to the Sandbox verifier just because that's the only one
    // available. It correctly fails as wrong_environment, not 'ok'.
    const jws = makeJws(basePayload({ environment: 'Production' }));
    const out = await verifyStoreKitTransactionForDeployment(jws, {
      allowedProductIds: [PRODUCT_ID], bundleId: BUNDLE_ID, appAppleId: undefined,
      _verifiersForTests: { sandbox: goodVerifier },
    });
    expect(out.kind).toBe('wrong_environment');
    expect(out.matchedEnvironment).toBeNull();
  });

  it('a genuine Sandbox transaction still verifies when appAppleId is unset (TestFlight keeps working without Production configured)', async () => {
    const jws = makeJws(basePayload({ environment: 'Sandbox' }));
    const out = await verifyStoreKitTransactionForDeployment(jws, {
      allowedProductIds: [PRODUCT_ID], bundleId: BUNDLE_ID, appAppleId: undefined,
      _verifiersForTests: { sandbox: goodVerifier },
    });
    expect(out.kind).toBe('ok');
    expect(out.matchedEnvironment).toBe(Environment.SANDBOX);
  });

  it('a bad signature for the matching environment is NOT masked by falling through to the other environment', async () => {
    const jws = makeJws(basePayload({ environment: 'Sandbox' }), { corruptSig: true });
    const out = await verifyStoreKitTransactionForDeployment(jws, {
      allowedProductIds: [PRODUCT_ID], bundleId: BUNDLE_ID, appAppleId: APP_APPLE_ID,
      _verifiersForTests: { production: prodVerifier, sandbox: goodVerifier },
    });
    expect(out.kind).toBe('bad_signature');
    expect(out.matchedEnvironment).toBeNull();
  });

  it('a Sandbox transaction is REJECTED when the deployment policy disallows Sandbox (allowSandbox: false)', async () => {
    // Environment policy: an app/store that forbids Sandbox purchases must
    // never accept one — the Sandbox verifier simply isn't attempted, so the
    // transaction reports wrong_environment rather than 'ok'.
    const jws = makeJws(basePayload({ environment: 'Sandbox' }));
    const out = await verifyStoreKitTransactionForDeployment(jws, {
      allowedProductIds: [PRODUCT_ID], bundleId: BUNDLE_ID, appAppleId: APP_APPLE_ID, allowSandbox: false,
      _verifiersForTests: { production: prodVerifier, sandbox: goodVerifier },
    });
    expect(out.kind).toBe('wrong_environment');
    expect(out.matchedEnvironment).toBeNull();
  });
});
