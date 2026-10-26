/** Shared source-only corpus for engine CI & identity-pinned composed qualification. */
import type { createAuthorizationFixtures } from './authorization-matrix.fixtures.testkit.js';
import { createReadCases } from './authorization-matrix.read-cases.testkit.js';
import { createMutationCases } from './authorization-matrix.mutation-cases.testkit.js';
import { createPermissionCases, assertGrantedStaffLicense } from './authorization-matrix.permission-cases.testkit.js';
import { createResourceCases } from './authorization-matrix.resource-cases.testkit.js';
import { createContentCases } from './authorization-matrix.content-cases.testkit.js';
import { createCustomerCases, createCustomerControls } from './authorization-matrix.customer-cases.testkit.js';
import { createOrderCases } from './authorization-matrix.order-cases.testkit.js';
import { createIdentityCases, runIdentityControls } from './authorization-matrix.identity-cases.testkit.js';
import { createPublicReadCases, prepareSheeridCustomerControl } from './authorization-matrix.public-read-cases.testkit.js';
import { createConfigurationCases } from './authorization-matrix.configuration-cases.testkit.js';
import { createCartCases, createCartControls } from './authorization-matrix.cart-cases.testkit.js';
import { createIntegrationCases } from './authorization-matrix.integration-cases.testkit.js';
import { createAccountCreditCases } from './authorization-matrix.account-credit-cases.testkit.js';
import { createPublicAuthCases, createPublicAuthControls } from './authorization-matrix.public-auth-cases.testkit.js';
import { createLicenseCases, createLicenseCapabilityControls } from './authorization-matrix.license-cases.testkit.js';
import { createBoundaryCases } from './authorization-matrix.boundary-cases.testkit.js';
import { createReconciliationCases, prepareReconciliationGrantedControls } from './authorization-matrix.reconciliation-cases.testkit.js';
import { createStorefrontCases, createStorefrontControls } from './authorization-matrix.storefront-cases.testkit.js';
import { createWebhookCases } from './authorization-matrix.webhook-cases.testkit.js';
import { createAssetCases, createAssetControls } from './authorization-matrix.asset-cases.testkit.js';
import { createProviderCases, createProviderBillingPortal } from './authorization-matrix.provider-cases.testkit.js';
import { createPaymentCases, createPaymentControls } from './authorization-matrix.payment-cases.testkit.js';
import { createFederatedCases, runFederatedControls, type FederatedTransport } from './authorization-matrix.federated-cases.testkit.js';
import { createLegacyContactCases, createSheerIdWebhookCases, createSheerIdRevokeCases, createSetupCases, assertGrantedStaffSheerIdRevoke,
  type LegacyContactOptions, type SetupBootstrapReceipt } from './authorization-matrix.setup-cases.testkit.js';
import type { AppleAuthorization } from './authorization-matrix.apple-cases.testkit.js';
import type { AuthorizationTransport } from './authorization-matrix.transport.testkit.js';
import type { MatrixApp, MatrixCase, MatrixProof, PreparedMatrixCell } from './authorization-matrix.testkit.js';

type Fixture = Awaited<ReturnType<typeof createAuthorizationFixtures>>;
export interface CoreAuthorizationAdapters {
  transport: AuthorizationTransport;
  federated: FederatedTransport;
  apple: AppleAuthorization;
  /** Harness configures exact synthetic UUID-store binding before constructing cases. */
  legacyContact: LegacyContactOptions;
}

/** Shared DB suites may exercise these 364 contracts, but this subset never passes the full inventory gate. */
export function createEnrolledAuthorizationCases(f: Fixture, adapters: CoreAuthorizationAdapters): MatrixCase[] {
  const { transport, federated, apple, legacyContact } = adapters;
  const customer = { billingPortal: createProviderBillingPortal(f, transport) };
  return [
    ...createReadCases(f), ...createMutationCases(f), ...createPermissionCases(f), ...createContentCases(f),
    ...createCustomerCases(f, customer), ...createOrderCases(f), ...createIdentityCases(f), ...createPublicReadCases(f),
    ...createResourceCases(f), ...createBoundaryCases(f), ...createCartCases(f), ...createIntegrationCases(f), ...createAccountCreditCases(f),
    ...createPublicAuthCases(f), ...createLicenseCases(f), ...createConfigurationCases(f), ...createReconciliationCases(f),
    ...createStorefrontCases(f), ...createWebhookCases(f), ...createAssetCases(f), ...createProviderCases(f, transport),
    ...createPaymentCases(f, transport), ...createFederatedCases(f, federated), ...createLegacyContactCases(f, legacyContact),
    ...createSheerIdWebhookCases(f, transport), ...createSheerIdRevokeCases(f), ...apple.cases,
  ];
}

/** Dedicated fresh DB: real createApp -> runSetupBootstrap -> principal fixtures -> full actual inventory gate.
 * No fabricated receipt, skipped setup cells, alternate auth app, or cleanup/reset of a shared DB is accepted.
 * Caller combines this corpus with composed plugin cases & invokes runAuthorizationMatrix against actual app.routes.
 */
export function createQualifiedAuthorizationCases(f: Fixture, adapters: CoreAuthorizationAdapters, receipt: SetupBootstrapReceipt): MatrixCase[] {
  return [...createEnrolledAuthorizationCases(f, adapters), ...createSetupCases(f, receipt)];
}

export function createCoreCapabilityControls(f: Fixture, adapters: CoreAuthorizationAdapters): Array<{
  key: string; status: number; prepare(): Promise<PreparedMatrixCell>;
}> {
  const { transport, apple } = adapters;
  return [
    ...createCustomerControls(f, { billingPortal: createProviderBillingPortal(f, transport) }),
    ...createCartControls(f), ...createPublicAuthControls(f), ...createLicenseCapabilityControls(f),
    ...createStorefrontControls(f), ...createAssetControls(f), ...createPaymentControls(f, transport), ...apple.controls,
  ];
}

/** Required genuine grant/installation/identity controls, executed after all matrix denial cells.
 * Capabilities & hostile capability controls come from createCoreCapabilityControls separately.
 */
export async function runCoreSupplementaryControls(options: {
  app: MatrixApp; fixture: Fixture; adapters: CoreAuthorizationAdapters; proof: MatrixProof;
}): Promise<void> {
  const { app, fixture: f, adapters } = options;
  const proof: MatrixProof = options.proof;
  await assertGrantedStaffLicense({ app, fixture: f, proof });
  await assertGrantedStaffSheerIdRevoke({ app, fixture: f, proof });
  for (const prepared of await prepareReconciliationGrantedControls(f)) {
    const response = await app.request(prepared.url, prepared.init, prepared.env);
    proof.equal(response.status, 200, 'explicit human refund grant admits operator reconciliation');
    await prepared.verify(response, proof);
  }
  const sheerid = await prepareSheeridCustomerControl(f);
  const verified = await app.request(sheerid.url, sheerid.init, sheerid.env);
  proof.equal(verified.status, 200, 'genuine SheerID customer credential');
  await sheerid.verify(verified, proof);
  await runIdentityControls(f);
  await runFederatedControls(f, adapters.federated);
  const build = await app.request('/v1/admin/system/build-info', { headers: f.positiveControls.installationAdmin });
  proof.equal(build.status, 200, 'genuine installation administrator reads build identity');
  proof.equal((await build.json() as { engine?: { name?: string } }).engine?.name, '@sellright/api', 'actual engine build identity projection');
  const config = await app.request('/v1/admin/system/effective-config', { headers: f.positiveControls.installationAdmin });
  proof.equal(config.status, 200, 'genuine installation administrator reads effective config');
  const projection = await config.json() as { schema: string; store: { slug: string }; intended: unknown };
  proof.equal(projection.schema, 'config/v1', 'effective config schema');
  proof.equal(projection.store.slug, f.storeSlug, 'effective config selects exact store A');
  proof.ok(projection.intended && typeof projection.intended === 'object', 'effective config includes intended settings');
}
