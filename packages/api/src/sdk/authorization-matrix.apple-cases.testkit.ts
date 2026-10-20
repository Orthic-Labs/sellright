/** StoreKit authorization through real ES256/x5c verification against SYNTHETIC TEST ROOTS ONLY.
 * No Apple issuer, Apple production trust, network OCSP, or real purchase claim is made. */
import type { MatrixProof } from './authorization-matrix.testkit.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createAppleFixture, type AppleFixture } from '../licensing/storekit/jws-fixture.js';
import { _setStoreKitVerifierOverrideForTests } from '../licensing/storekit-config.js';
import { hashActivationToken } from '../licensing/tokens.js';
import { storeKitLinkOperationId, storeKitPayloadOperationId, storeKitNotificationOperationId } from '../licensing/storekit-events.js';
import { LINK_MESSAGES } from '../licensing/storekit/default-policy.js';
import { slugifyCode } from '../lib/api-error.js';
import type { createAuthorizationFixtures } from './authorization-matrix.fixtures.testkit.js';
import { PRINCIPALS, type MatrixCase, type MatrixCell, type MatrixPrincipal, type PreparedMatrixCell } from './authorization-matrix.testkit.js';

type Fixture = Awaited<ReturnType<typeof createAuthorizationFixtures>>;
type Json = Record<string, any>;
export interface AppleControl { key: string; status: number; prepare(): Promise<PreparedMatrixCell> }
export interface AppleAuthorization {
  readonly trust: 'synthetic-test-root-only; real ES256/x5c; online OCSP disabled';
  cases: MatrixCase[];
  controls: AppleControl[];
  cleanup(): void;
}
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
const webhookPath = '/v1/webhooks/apple/storekit', linkPath = '/v1/shop/pro/link-storekit';
const tamper = (jws: string) => {
  const [header, payload, signature] = jws.split('.');
  assert.ok(header && payload && signature, 'fixture must create a three-part JWS');
  return `${header}.${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
};

/** Parent calls this only inside its disposable test setup; creating certificates executes existing fixture helper. */
export async function installAppleAuthorization(f: Fixture): Promise<AppleAuthorization> {
  const unique = randomUUID().replaceAll('-', ''), appKey = 'matrix-apple-' + unique;
  const bundleId = 'invalid.matrix.' + unique, productId = bundleId + '.pro', appAppleId = 987654321;
  let trusted: AppleFixture | undefined, wrongRoot: AppleFixture | undefined;
  try {
    trusted = createAppleFixture(bundleId, appAppleId);
    wrongRoot = createAppleFixture(bundleId, appAppleId);
  } catch (error) { trusted?.cleanup(); wrongRoot?.cleanup(); throw error; }
  const trustedFixture = trusted, untrustedFixture = wrongRoot;
  // The real Apple SignedDataVerifier validates chains, signatures, bundle & environment.
  // Only this one synthetic bundle receives test-root verifiers; every other bundle retains normal trust.
  _setStoreKitVerifierOverrideForTests(bundle => bundle === bundleId
    ? { production: trustedFixture.prodVerifier, sandbox: trustedFixture.sandboxVerifier } : undefined);
  const rows = async (sql: string, values: unknown[] = []) => (await f.queryStore(f.storeId, sql, values)).rows;
  const appId = randomUUID();
  try {
    await rows('INSERT INTO storekit_app(id,store_id,app_key,bundle_id,app_apple_id,allow_sandbox,product_map) VALUES($1,$2,$3,$4,$5,true,$6::jsonb)',
      [appId, f.storeId, appKey, bundleId, appAppleId, JSON.stringify({ [productId]: { tier: 'pro', seats: 0 } })]);
  } catch (error) {
    _setStoreKitVerifierOverrideForTests(undefined); trustedFixture.cleanup(); untrustedFixture.cleanup(); throw error;
  }

  const eventRows = async () => (await rows('SELECT to_jsonb(e) AS value FROM storekit_event e ORDER BY id')).map(r => r.value as Json);
  /** Exact exception approved for routes/storekit-webhooks.ts:98-112 & 289-301:
   * verification instrumentation may append one operation-bound verify receipt (or no duplicate failed receipt).
   * Only complete newly-proven storekit_event rows are removed from snapshot comparison; no field is wildcarded.
   * Existing rows, every other table, files, outbox & provider calls remain byte-for-byte represented. */
  function verificationSnapshot(operationId: string, outcome: 'ok' | 'failed', error: string | null) {
    let baseline: Json[] | undefined;
    let baselineRaw: unknown;
    const earliest = Date.now();
    return async () => {
      const raw = await f.snapshot(), current = await eventRows();
      if (!baseline) { baseline = current; baselineRaw = raw; return raw; }
      const byId = new Map(current.map(row => [row.id, row]));
      for (const row of baseline) assert.deepEqual(byId.get(row.id), row, 'StoreKit denial must retain every preexisting verification/audit row');
      const ids = new Set(baseline.map(row => row.id)), added = current.filter(row => !ids.has(row.id));
      const duplicate = outcome === 'failed' && baseline.some(row => row.store_id === f.storeId && row.operation_id === operationId && row.stage === 'verify'
        && row.outcome === 'failed' && new Date(row.created_at).getTime() > Date.now() - 3_600_000);
      assert.equal(added.length, duplicate ? 0 : 1, 'StoreKit denial appends exactly its permitted verification receipt, bounded on failure replay');
      for (const row of added) {
        assert.match(String(row.id), /^[0-9a-f-]{36}$/, 'verification receipt uses real UUID');
        assert.ok(new Date(row.created_at).getTime() >= earliest && new Date(row.created_at).getTime() <= Date.now(), 'verification receipt has request-time timestamp');
        assert.deepEqual(row, { id: row.id, store_id: f.storeId, operation_id: operationId, stage: 'verify', outcome, error,
          resolved_by_event_id: null, created_at: row.created_at }, 'verification receipt binds exact store/operation/stage/outcome/error');
      }
      const newIds = new Set(added.map(row => row.id));
      const normalized = structuredClone(raw) as { data: unknown[][] };
      for (const table of normalized.data) if (table[1] === 'public' && table[2] === 'storekit_event') {
        table[3] = (table[3] as Json[]).filter(row => !(row.store_id === f.storeId && newIds.has(row.id)));
      }
      assert.deepEqual(normalized, baselineRaw, 'StoreKit denial changes no domain/outbox/files/provider/other audit state');
      return normalized;
    };
  }
  const request = (url: string, signedBody: unknown, headers: Record<string, string>): Pick<PreparedMatrixCell, 'url' | 'init'> => ({
    url, init: { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(signedBody) },
  });
  function transaction(originalTransactionId: string, extra: Json = {}) {
    const now = Date.now();
    return { transactionId: originalTransactionId + '-latest', originalTransactionId, bundleId, productId,
      environment: 'Sandbox', purchaseDate: now, originalPurchaseDate: now, signedDate: now, type: 'Non-Consumable', ...extra };
  }
  function notification(originalTransactionId: string, notificationUUID: string, extra: Json = {}, signer = trustedFixture) {
    const txn = signer.makeJws(transaction(originalTransactionId, { revocationDate: Date.now(), ...extra }));
    return signer.makeJws({ notificationType: 'REFUND', notificationUUID, data: { environment: String(extra.environment ?? 'Sandbox'), bundleId, bundleVersion: '1', appAppleId,
      signedTransactionInfo: txn }, version: '2.0', signedDate: Date.now() });
  }
  const domain = async () => ({
    purchases: await rows('SELECT to_jsonb(p) AS value FROM storekit_purchase p WHERE app_key=$1 ORDER BY id', [appKey]),
    licenses: await rows('SELECT to_jsonb(l) AS value FROM license l WHERE app_key=$1 ORDER BY id', [appKey]),
    activations: await rows('SELECT to_jsonb(a) AS value FROM license_activation a WHERE app_key=$1 ORDER BY id', [appKey]),
  });
  let linkTarget: Promise<{ originalId: string; jws: string; device: string }> | undefined;
  const link = () => linkTarget ??= Promise.resolve().then(() => {
    const originalId = 'matrix-link-' + randomUUID();
    return { originalId, jws: trustedFixture.makeJws(transaction(originalId)), device: digest('matrix-apple-device-' + originalId) };
  });
  let hookTarget: Promise<{ originalId: string; notificationId: string; valid: string; invalid: string; licenseId: string; activationId: string; purchaseId: string }> | undefined;
  const hook = () => hookTarget ??= (async () => {
    const originalId = 'matrix-refund-' + randomUUID(), notificationId = randomUUID(), licenseId = randomUUID(), activationId = randomUUID(), purchaseId = randomUUID();
    await rows("INSERT INTO license(id,store_id,customer_id,app_key,license_key,status,source,seats,metadata) VALUES($1,$2,$3,$4,$5,'active','storekit',0,$6::jsonb)",
      [licenseId, f.storeId, f.expectedCustomerId, appKey, 'SK-MATRIX-' + licenseId, JSON.stringify({ tier: 'pro', storekit_environment: 'Sandbox', storekit_original_transaction_id: originalId, storekit_bundle_id: bundleId, storekit_product_id: productId })]);
    await rows("INSERT INTO license_activation(id,store_id,license_id,app_key,device_id_hash,activation_token_hash,state,generation) VALUES($1,$2,$3,$4,$5,$6,'active',0)",
      [activationId, f.storeId, licenseId, appKey, digest(originalId), hashActivationToken('sr_act_matrix_' + activationId)]);
    await rows("INSERT INTO storekit_purchase(id,store_id,storekit_app_id,license_id,app_key,environment,bundle_id,product_id,original_transaction_id,transaction_id,customer_id,status) VALUES($1,$2,$3,$4,$5,'Sandbox',$6,$7,$8,$9,$10,'active')",
      [purchaseId, f.storeId, appId, licenseId, appKey, bundleId, productId, originalId, originalId + '-latest', f.expectedCustomerId]);
    const valid = notification(originalId, notificationId);
    return { originalId, notificationId, valid, invalid: tamper(valid), licenseId, activationId, purchaseId };
  })();
  const positiveLink = async (): Promise<PreparedMatrixCell> => {
    const target = await link();
    return { ...request(linkPath, { appKey, signedTransactionInfo: target.jws, deviceIdHash: target.device, platform: 'ios', deviceLabel: 'Synthetic StoreKit fixture' }, f.customerHeaders),
      async verify(response: Response, proof: MatrixProof) {
        const b = await response.json() as Json;
        proof.ok(typeof b.activationToken === 'string' && b.activationToken.startsWith('sr_act_'), 'synthetic-root real ES256 purchase issues opaque activation credential');
        const purchase = await rows('SELECT license_id,customer_id,environment,bundle_id,product_id,status FROM storekit_purchase WHERE original_transaction_id=$1 AND app_key=$2', [target.originalId, appKey]);
        proof.equal(purchase.length, 1, 'verified purchase materializes exactly once', 'state');
        const p = purchase[0]!;
        proof.equal({ ...p, license_id: undefined }, { license_id: undefined, customer_id: f.expectedCustomerId, environment: 'Sandbox', bundle_id: bundleId, product_id: productId, status: 'active' }, 'verified purchase binds real customer & signed app/product/environment', 'state');
        const activation = await rows('SELECT id,device_id_hash,activation_token_hash,state,activated_at FROM license_activation WHERE license_id=$1', [p.license_id]);
        proof.equal(activation.length, 1, 'one activated seat committed for linked purchase', 'state');
        const a = activation[0]!;
        proof.equal(b, { ok: true, activationToken: b.activationToken, lease: { leaseId: a.id, deviceIdHash: target.device, pool: 'mobile', entitlement: 'pro', issuedAt: new Date(a.activated_at).toISOString(), expiresAt: null, graceSeconds: 0, generation: 0, signature: null } }, 'exact genuine-crypto StoreKit link response');
        proof.equal({ device_id_hash: a.device_id_hash, activation_token_hash: a.activation_token_hash, state: a.state },
          { device_id_hash: target.device, activation_token_hash: hashActivationToken(b.activationToken), state: 'active' }, 'linked device stores hashed returned token & signed-purchase seat', 'state');
        proof.equal(await rows('SELECT customer_id,status,source,seats,expires_at,updates_until,metadata FROM license WHERE id=$1', [p.license_id]),
          [{ customer_id: f.expectedCustomerId, status: 'active', source: 'storekit', seats: 0, expires_at: null, updates_until: null,
            metadata: { tier: 'pro', storekit_original_transaction_id: target.originalId, storekit_bundle_id: bundleId, storekit_environment: 'Sandbox', storekit_product_id: productId } }], 'license derives only configured entitlement & signed transaction facts', 'state');
        const operationId = storeKitLinkOperationId(appKey, target.jws);
        proof.equal(await rows("SELECT stage,outcome,error FROM storekit_event WHERE operation_id=$1 AND stage='apply'", [operationId]), [{ stage: 'apply', outcome: 'ok', error: null }], 'link issuance & apply receipt committed together', 'state');
      } };
  };
  const positiveHook = async (): Promise<PreparedMatrixCell> => {
    const t = await hook();
    return { ...request(webhookPath, { signedPayload: t.valid }, f.requestHeaders.owner), async verify(response: Response, proof: MatrixProof) {
      proof.equal(await response.json(), { received: true }, 'synthetic-root real ES256/x5c refund notification acknowledged');
      proof.equal(await rows('SELECT status,last_notification_type,last_notification_uuid FROM storekit_purchase WHERE id=$1', [t.purchaseId]),
        [{ status: 'revoked', last_notification_type: 'REFUND', last_notification_uuid: t.notificationId }], 'verified notification revokes actual bound purchase', 'state');
      proof.equal(await rows('SELECT status FROM license WHERE id=$1', [t.licenseId]), [{ status: 'revoked' }], 'verified refund revokes actual license', 'state');
      proof.equal(await rows('SELECT state,generation FROM license_activation WHERE id=$1', [t.activationId]), [{ state: 'revoked', generation: 1 }], 'verified refund tombstones active device & bumps generation', 'state');
      proof.equal(await rows('SELECT type FROM processed_event WHERE id=$1', ['apple-storekit:' + t.notificationId]), [{ type: 'apple.storekit.REFUND' }], 'notification idempotency claim committed', 'state');
      proof.equal(await rows('SELECT stage,outcome,error FROM storekit_event WHERE operation_id=$1', [storeKitNotificationOperationId(t.notificationId)]),
        [{ stage: 'apply', outcome: 'ok', error: null }], 'refund apply receipt commits with state transition', 'state');
      proof.equal(await rows('SELECT stage,outcome,error FROM storekit_event WHERE operation_id=$1', [storeKitPayloadOperationId(t.valid)]),
        [{ stage: 'verify', outcome: 'ok', error: null }], 'genuine signature verification records success', 'state');
    } };
  };
  const linkCells = {} as Record<MatrixPrincipal, MatrixCell>, hookCells = {} as Record<MatrixPrincipal, MatrixCell>;
  for (const principal of PRINCIPALS) {
    linkCells[principal] = { effect: 'deny', status: 401, errorCode: slugifyCode(LINK_MESSAGES.unauth), async prepare() {
      const t = await link(), before = await domain(), operation = storeKitLinkOperationId(appKey, t.jws);
      return { ...request(linkPath, { appKey, signedTransactionInfo: t.jws, deviceIdHash: t.device, platform: 'ios', deviceLabel: 'Synthetic StoreKit fixture' }, f.requestHeaders[principal]),
        snapshot: verificationSnapshot(operation, 'ok', null), async verify(response: Response, proof: MatrixProof) {
          const b = await response.json() as Json;
          proof.equal(b.error?.code, slugifyCode(LINK_MESSAGES.unauth), 'admin/service/cache token cannot authorize customer purchase link');
          proof.equal(b.error?.message, LINK_MESSAGES.unauth, 'exact customer ownership denial after genuine cryptographic verification');
          proof.equal(await domain(), before, 'denied customer link materializes no purchase/license/device', 'state');
          proof.ok((await rows("SELECT id FROM storekit_event WHERE operation_id=$1 AND stage='verify' AND outcome='ok'", [operation])).length > 0,
            'real synthetic-root ES256 chain verified before customer denial', 'state');
        } };
    } };
    hookCells[principal] = { effect: 'deny', status: 400, signatureFailure: 'apple-storekit', async prepare() {
      const t = await hook(), before = await domain();
      return { ...request(webhookPath, { signedPayload: t.invalid }, f.requestHeaders[principal]),
        snapshot: verificationSnapshot(storeKitPayloadOperationId(t.invalid), 'failed', 'verify:bad_signature'), async verify(response: Response, proof: MatrixProof) {
          proof.equal(await response.json(), { error: 'notification verification failed' }, 'admin/service/cache token cannot authorize bad ES256 notification signature');
          proof.equal(await domain(), before, 'invalid signature leaves real purchase/license/device unchanged', 'state');
          proof.equal(await rows('SELECT id FROM processed_event WHERE id=$1', ['apple-storekit:' + t.notificationId]), [], 'invalid signature never claims genuine notification', 'state');
        } };
    } };
  }
  const cases: MatrixCase[] = [
    { key: 'POST ' + linkPath, contract: 'customer', cells: linkCells },
    { key: 'POST ' + webhookPath, contract: 'webhook', cells: hookCells, signatureControl: positiveHook },
  ];
  const controls: AppleControl[] = [{ key: 'synthetic-root real ES256 customer purchase link', status: 200, prepare: positiveLink }];
  for (const route of ['link', 'webhook'] as const) for (const fault of ['signature', 'root', 'product', 'environment'] as const) controls.push({
    key: `synthetic-root ${route} rejects wrong ${fault}`, status: 400, async prepare() {
      const originalId = 'matrix-negative-' + randomUUID(), notificationId = randomUUID();
      const signer = fault === 'root' ? untrustedFixture : trustedFixture;
      const extra = fault === 'product' ? { productId: productId + '.unconfigured' } : {};
      let jws = route === 'link' ? signer.makeJws(transaction(originalId, extra)) : notification(originalId, notificationId, extra, signer);
      if (fault === 'signature') jws = tamper(jws);
      // Keep real signed Sandbox claims, but prove deployment's Production-only policy rejects them.
      if (fault === 'environment') await rows('UPDATE storekit_app SET allow_sandbox=false WHERE id=$1', [appId]);
      const reason = fault === 'product' ? 'wrong_product' : fault === 'environment' ? 'wrong_environment' : 'bad_signature';
      const operation = route === 'link' ? storeKitLinkOperationId(appKey, jws) : storeKitPayloadOperationId(jws);
      const snapshot = verificationSnapshot(operation, 'failed', 'verify:' + reason), beforeDomain = await domain();
      const prepared = route === 'link'
        ? request(linkPath, { appKey, signedTransactionInfo: jws, deviceIdHash: digest(originalId), platform: 'ios' }, f.customerHeaders)
        : request(webhookPath, { signedPayload: jws }, f.requestHeaders.owner);
      return { ...prepared, snapshot, async verify(response: Response, proof: MatrixProof) {
        try {
          const b = await response.json() as Json;
          if (route === 'webhook') proof.equal(b, { error: 'notification verification failed' }, 'exact signed-notification verification refusal');
          else {
            const message = fault === 'product' ? LINK_MESSAGES.notForApp : fault === 'environment' ? LINK_MESSAGES.environment : LINK_MESSAGES.unverified;
            proof.equal(b.error?.code, slugifyCode(message), 'exact transaction verification error code');
            proof.equal(b.error?.message, message, 'exact signature/root/product/environment policy reason');
          }
          proof.equal(await domain(), beforeDomain, 'negative crypto/policy leaves all existing purchases/licenses/devices unchanged', 'state');
          proof.equal(await rows('SELECT id FROM storekit_purchase WHERE original_transaction_id=$1', [originalId]), [], 'rejected crypto/policy never materializes purchase', 'state');
        } finally { if (fault === 'environment') await rows('UPDATE storekit_app SET allow_sandbox=true WHERE id=$1', [appId]); }
      } };
    },
  });
  return { trust: 'synthetic-test-root-only; real ES256/x5c; online OCSP disabled', cases, controls,
    cleanup() { _setStoreKitVerifierOverrideForTests(undefined); trustedFixture.cleanup(); untrustedFixture.cleanup(); } };
}
