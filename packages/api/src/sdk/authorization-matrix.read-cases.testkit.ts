/** Concrete read-only admin contracts for B2.8. Source-only; excluded from engine exports. */
import type { MatrixCase, MatrixCell, MatrixPrincipal, MatrixProof } from './authorization-matrix.testkit.js';

export interface MatrixReadFixture {
  /** All store-scoped requests, including ownerB, explicitly select this existing store. */
  storeSlug: string;
  requestHeaders: Record<MatrixPrincipal, Record<string, string>>;
  /** Seeded visible rows strengthen positive collection identity checks when supplied. */
  expectedProductId?: string;
  expectedCustomerId?: string;
  /** Unique seeded email filters created-desc pagination to the retained store A target. */
  readonly expectedCustomerEmail?: string;
  foreignProductId?: string;
  foreignCustomerId?: string;
}
type Json = Record<string, unknown>;
type Verify = (body: Json, proof: MatrixProof, principal: MatrixPrincipal) => void;
type Fields = Record<string, 'string' | 'number' | 'boolean' | 'array' | 'object' | 'nullable-string' | 'nullable-number'>;
interface ReadSpec {
  path: string;
  query?: string;
  gate?: 'manage' | 'refunds';
  /** me & 2fa authenticate globally, without resolving x-store-slug. */
  global?: boolean;
  verify: Verify;
}
function object(value: unknown, proof: MatrixProof, label: string): Json {
  proof.ok(value !== null && typeof value === 'object' && !Array.isArray(value), label);
  return value as Json;
}
function fields(value: Json, expected: Fields, proof: MatrixProof, prefix = ''): void {
  for (const [key, kind] of Object.entries(expected)) {
    const item = value[key], label = prefix + key;
    if (kind === 'array') proof.ok(Array.isArray(item), label + ' is array');
    else if (kind === 'object') object(item, proof, label + ' is object');
    else if (kind === 'nullable-number') proof.ok(item === null || (typeof item === 'number' && Number.isFinite(item)), label + ' is nullable number');
    else if (kind === 'nullable-string') proof.ok(item === null || typeof item === 'string', label + ' is nullable string');
    else proof.equal(typeof item, kind, label + ' type');
    if (kind === 'number') proof.ok(Number.isFinite(item), label + ' is finite');
  }
}
function rows(body: Json, proof: MatrixProof, expected: Fields, key = 'items'): Json[] {
  proof.ok(Array.isArray(body[key]), key + ' is array');
  return (body[key] as unknown[]).map((row, i) => {
    const item = object(row, proof, key + '[' + i + ']');
    fields(item, expected, proof, key + '[' + i + '].');
    return item;
  });
}
function list(expected: Fields, extra: Fields = {}): Verify {
  return (body: Json, proof: MatrixProof) => { rows(body, proof, expected); fields(body, extra, proof); };
}
function page(expected: Fields): Verify {
  return (body: Json, proof: MatrixProof) => {
    rows(body, proof, expected);
    fields(body, { total: 'number', page: 'number', pageSize: 'number' }, proof);
    proof.equal(body.page, 1, 'first page');
    proof.equal(body.pageSize, 25, 'requested page size');
    proof.ok(Number.isInteger(body.total) && Number(body.total) >= (body.items as unknown[]).length, 'total covers returned rows');
  };
}
/** Independent expected error wording, sourced from admin-helpers.ts; no production guard import. */
function fallbackCode(message: string): string {
  return message.normalize('NFKD').replace(/[^a-zA-Z0-9\s_]/g, '').trim().toUpperCase().replace(/\s+/g, '_').slice(0, 64) || 'ERROR';
}

export function createReadCases(fixture: MatrixReadFixture): MatrixCase[] {
  const specs: ReadSpec[] = [

    { path: '/v1/admin/discounts', verify: list({ id: 'string', code: 'nullable-string', type: 'string', value: 'number', freeShipping: 'boolean', enabled: 'boolean', usedCount: 'number' }) },
    { path: '/v1/admin/promotions', verify: list({ id: 'string', code: 'nullable-string', type: 'string', value: 'number', freeShipping: 'boolean', enabled: 'boolean', usedCount: 'number' }) },
    { path: '/v1/admin/licenses', verify: list({ id: 'string', appKey: 'string', licenseKey: 'string', source: 'string', status: 'string', seats: 'number' }) },
    { path: '/v1/admin/licenses/entitlement-inventory', verify(body: Json, proof: MatrixProof) {
      proof.equal(body.appKey, null, 'unfiltered entitlement inventory');
      fields(body, { canonicalV2: 'number', legacyOrUnknown: 'number', canRemoveLegacyVerifier: 'boolean' }, proof);
      proof.equal(body.canRemoveLegacyVerifier, body.legacyOrUnknown === 0, 'legacy removal readiness');
    } },
    { path: '/v1/admin/subscriptions', query: '?page=1&pageSize=25', verify: page({ id: 'string', status: 'string', priceId: 'nullable-string', stripeSubscriptionId: 'string', cancelAtPeriodEnd: 'boolean', createdAt: 'string' }) },
    { path: '/v1/admin/sheerid/config', verify(body: Json, proof: MatrixProof) {
      fields(body, { configured: 'boolean', programId: 'nullable-string', hasWebhookSecret: 'boolean', hasClientCredentials: 'boolean', verificationTtlDays: 'number' }, proof);
      proof.ok(!('webhookSecret' in body) && !('clientSecret' in body), 'SheerID secrets omitted');
    } },
    { path: '/v1/admin/sheerid/verifications', verify: list({ id: 'string', verificationId: 'nullable-string', programId: 'string', category: 'nullable-string', status: 'string', createdAt: 'string' }) },
    { path: '/v1/admin/disputes', verify: list({ id: 'string', provider: 'string', providerRef: 'string', amount: 'nullable-number', currency: 'nullable-string', status: 'string', createdAt: 'string' }) },
    { path: '/v1/admin/me', global: true, verify(body: Json, proof: MatrixProof, principal: MatrixPrincipal) {
      fields(body, { email: 'string', isInstallationAdmin: 'boolean', stores: 'array', totpEnabled: 'boolean', totpEnrollmentRequired: 'boolean' }, proof);
      proof.equal(body.kind, principal === 'agent' ? 'agent' : 'human', 'principal kind');
      proof.equal(body.auth, principal === 'agent' ? 'api_token' : 'session', 'credential kind');
      const stores = rows(body, proof, { storeId: 'string', slug: 'string', role: 'string' }, 'stores');
      if (principal === 'foreign_store') proof.ok(!stores.some(s => s.slug === fixture.storeSlug), 'foreign owner has no A membership');
      else proof.ok(stores.some(s => s.slug === fixture.storeSlug), 'principal belongs to selected store');
    } },
    { path: '/v1/admin/2fa', global: true, verify(body: Json, proof: MatrixProof) {
      fields(body, { enabled: 'boolean', required: 'boolean', recoveryCodesRemaining: 'number' }, proof);
      proof.ok(Number.isInteger(body.recoveryCodesRemaining) && Number(body.recoveryCodesRemaining) >= 0, 'recovery count');
    } },
    { path: '/v1/admin/products', query: '?page=1&pageSize=25', verify(body: Json, proof: MatrixProof, principal: MatrixPrincipal) {
      page({ id: 'string', slug: 'string', name: 'string', status: 'string', variants: 'number', stock: 'number' })(body, proof, principal);
      if (fixture.expectedProductId) proof.ok((body.items as Json[]).some(p => p.id === fixture.expectedProductId), 'seeded store A product visible');
      if (fixture.foreignProductId) proof.ok(!(body.items as Json[]).some(p => p.id === fixture.foreignProductId), 'store B product absent');
    } },
    { path: '/v1/admin/customers', query: '?page=1&pageSize=25' + (fixture.expectedCustomerEmail ? '&q=' + encodeURIComponent(fixture.expectedCustomerEmail) : ''), verify(body: Json, proof: MatrixProof, principal: MatrixPrincipal) {
      page({ id: 'string', email: 'string' })(body, proof, principal);
      if (fixture.expectedCustomerId) proof.ok((body.items as Json[]).some(p => p.id === fixture.expectedCustomerId), 'seeded store A customer visible');
      if (fixture.expectedCustomerEmail) {
        proof.equal((body.items as Json[]).map(p => p.email), [fixture.expectedCustomerEmail], 'sentinel search returns exactly the retained store A customer email');
        proof.equal(body.total, 1, 'sentinel search has one matching customer independent of created-desc ordering');
      }
      if (fixture.foreignCustomerId) proof.ok(!(body.items as Json[]).some(p => p.id === fixture.foreignCustomerId), 'store B customer absent');
    } },
    { path: '/v1/admin/orders', query: '?page=1&pageSize=25', verify: page({ code: 'string', state: 'string', status: 'string', grandTotal: 'number', currency: 'string', createdAt: 'string' }) },
    { path: '/v1/admin/returns', query: '?page=1&pageSize=25', verify: page({ id: 'string', status: 'string', orderCode: 'string', createdAt: 'string' }) },
    { path: '/v1/admin/inventory', query: '?page=1&pageSize=25', verify: page({ variantId: 'string', sku: 'string', name: 'string', productName: 'string', available: 'number' }) },
    { path: '/v1/admin/subscribers', query: '?page=1&pageSize=25', verify: page({ id: 'string', email: 'string', kind: 'string', status: 'string' }) },
    { path: '/v1/admin/abandoned-carts', query: '?page=1&pageSize=25', verify: page({ token: 'string', status: 'string', updatedAt: 'string', items: 'number' }) },
    { path: '/v1/admin/reviews', query: '?page=1&pageSize=25', verify(body: Json, proof: MatrixProof, principal: MatrixPrincipal) {
      page({ id: 'string', rating: 'number', body: 'string', status: 'string', verifiedBuyer: 'boolean' })(body, proof, principal);
      fields(object(body.counts, proof, 'review counts'), { pending: 'number', approved: 'number', rejected: 'number' }, proof);
    } },
    { path: '/v1/admin/assets', verify: list({ id: 'string', path: 'string', url: 'string' }, { total: 'number' }) },
    { path: '/v1/admin/collections', verify: list({ id: 'string', slug: 'string', name: 'string', products: 'number' }) },
    { path: '/v1/admin/locations', verify: list({ id: 'string', name: 'string', isDefault: 'boolean' }) },
    { path: '/v1/admin/blog', verify: list({ id: 'string', title: 'string', slug: 'string', isPublished: 'boolean' }, { seoContract: 'string', createContract: 'string' }) },
    { path: '/v1/admin/shipping-methods', verify: list({ id: 'string', name: 'string', code: 'string', enabled: 'boolean' }) },
    { path: '/v1/admin/tax-zones', verify: list({ id: 'string', name: 'string', priority: 'number' }) },
    { path: '/v1/admin/currency-rates', verify: list({ currency: 'string', rate: 'number', enabled: 'boolean' }) },
    { path: '/v1/admin/webhooks', verify(body: Json, proof: MatrixProof) {
      for (const row of rows(body, proof, { id: 'string', url: 'string', topics: 'array', enabled: 'boolean' })) proof.ok(!('secret' in row), 'webhook signing secret omitted');
    } },
    { path: '/v1/admin/affiliates', verify: list({ id: 'string', email: 'string', promotionId: 'string', code: 'string', onboardedAt: 'string' }, { commissionPct: 'number' }) },
    { path: '/v1/admin/gift-cards', verify: list({ id: 'string', code: 'string', enabled: 'boolean' }) },
    { path: '/v1/admin/subscribers/stats', verify(body: Json, proof: MatrixProof) { rows(body, proof, { kind: 'string', topic: 'string', status: 'string', n: 'number' }, 'counts'); } },
    { path: '/v1/admin/marketing/config', verify(body: Json, proof: MatrixProof) {
      fields(body, { configured: 'boolean', url: 'nullable-string' }, proof);
      proof.ok(body.listId === null || (Number.isInteger(body.listId) && Number(body.listId) > 0), 'listId is null or positive integer');
      proof.ok(!('apiToken' in body), 'Listmonk credential omitted');
    } },
    { path: '/v1/admin/activity', verify: list({ actor: 'string', entity: 'string', action: 'string', at: 'string' }) },
    { path: '/v1/admin/import-tracking/recent', verify: list({ actor: 'string', at: 'string' }) },
    { path: '/v1/admin/fulfillment/open-orders', verify: list({ code: 'string', placedAt: 'string', isPreOrder: 'boolean', fulfillmentStatus: 'string', items: 'array', shippedTracking: 'array' }, { total: 'number' }) },
    { path: '/v1/admin/reports/sales', verify(body: Json, proof: MatrixProof) {
      fields(body, { totalRevenue: 'number', totalOrders: 'number' }, proof);
      rows(body, proof, { day: 'string', orders: 'number', revenue: 'number' }, 'series');
    } },
    { path: '/v1/admin/reports/top-products', verify: list({ name: 'string', sku: 'string', qty: 'number', revenue: 'number' }) },
    { path: '/v1/admin/reports/top-customers', verify: list({ id: 'string', email: 'string', spent: 'number', orders: 'number' }) },
    { path: '/v1/admin/reports/metrics', verify(body: Json, proof: MatrixProof) { fields(body, { aov: 'number', orders: 'number', revenue: 'number', repeatRate: 'number', newCustomers: 'number', returningCustomers: 'number' }, proof); } },
    { path: '/v1/admin/search', query: '?q=matrix', verify(body: Json, proof: MatrixProof) {
      rows(body, proof, { code: 'string', state: 'string' }, 'orders');
      rows(body, proof, { id: 'string', name: 'string', status: 'string' }, 'products');
      rows(body, proof, { id: 'string', email: 'string' }, 'customers');
    } },
    { path: '/v1/admin/dashboard', verify(body: Json, proof: MatrixProof) {
      const store = object(body.store, proof, 'dashboard store');
      proof.equal(store.slug, fixture.storeSlug, 'dashboard selected store');
      fields(store, { name: 'string', currency: 'string', published: 'boolean' }, proof);
      fields(body, { revenue: 'number', orders: 'number', aov: 'number', pendingFulfillment: 'number', customers: 'number', lowStock: 'number', recentOrders: 'array' }, proof);
    } },
    { path: '/v1/admin/settings/store', verify(body: Json, proof: MatrixProof) {
      proof.equal(body.slug, fixture.storeSlug, 'settings selected store');
      fields(body, { name: 'string', currency: 'string', taxRate: 'number', taxInclusive: 'boolean', shippingTaxable: 'boolean', stripeMode: 'string' }, proof);
    } },
    { path: '/v1/admin/settings/order-numbering', verify(body: Json, proof: MatrixProof) {
      fields(body, { prefix: 'string', suffix: 'string', minDigits: 'number', nextNumber: 'number', preview: 'string' }, proof);
      proof.ok(body.highestExisting === null || typeof body.highestExisting === 'string', 'highestExisting is null or a code');
    } },
    { path: '/v1/admin/settings/identity', verify(body: Json, proof: MatrixProof) { fields(body, { identity: 'object', published: 'boolean', hasPreviewToken: 'boolean' }, proof); } },
    { path: '/v1/admin/settings/security', verify(body: Json, proof: MatrixProof) {
      fields(body, { requireTotp: 'boolean' }, proof);
      // admin-security.ts exposes the install policy enum; every matrix harness
      // configures ADMIN_REQUIRE_TOTP=all before constructing its real app.
      proof.equal(body.installRequireTotp, 'all', 'installation MFA policy remains all');
    } },
    { path: '/v1/admin/reviews-settings', verify(body: Json, proof: MatrixProof) { fields(body, { enabled: 'boolean', allowGuests: 'boolean', autoApprove: 'boolean', requirePurchase: 'boolean' }, proof); } },
    { path: '/v1/admin/email/settings', verify(body: Json, proof: MatrixProof) {
      fields(body, { envManaged: 'boolean', credentialConfigured: 'boolean' }, proof);
      proof.ok(body.config === null || (typeof body.config === 'object' && !Array.isArray(body.config)), 'SMTP config is null or object');
      if (body.config !== null) proof.ok(!('credential' in object(body.config, proof, 'SMTP config')), 'SMTP credential omitted');
    } },
    { path: '/v1/admin/payments/settings', verify(body: Json, proof: MatrixProof) {
      for (const [provider, modes, keys] of [
        ['stripe', ['test', 'live'], ['publishableKey', 'secretKey', 'webhookSecret']],
        ['nmi', ['test', 'live'], ['securityKey', 'tokenizationKey', 'privateKey']],
        ['sezzle', ['sandbox', 'production'], ['publicKey', 'privateKey']],
      ] as const) {
        const statuses = object(body[provider], proof, provider + ' statuses');
        for (const mode of modes) for (const key of keys) {
          const status = object(statuses[mode + ':' + key], proof, provider + ' ' + mode + ':' + key);
          fields(status, { envManaged: 'boolean', configured: 'boolean', last4: 'nullable-string' }, proof);
          proof.equal(Object.keys(status).sort(), ['configured', 'envManaged', 'last4'], 'only credential status projected');
        }
      }
    } },
    { path: '/v1/admin/loyalty/settings', verify(body: Json, proof: MatrixProof) { fields(body, { enabled: 'boolean', earnRatePerDollar: 'number', pointsPerDollarOff: 'number', minRedeemPoints: 'number', reviewBonusPoints: 'number', reviewBonusVerifiedOnly: 'boolean', productMultipliers: 'array' }, proof); } },
    { path: '/v1/admin/loyalty/summary', verify(body: Json, proof: MatrixProof) {
      fields(body, { enabled: 'boolean', currency: 'string', pointsPerDollarOff: 'number', issued: 'number', redeemed: 'number', outstanding: 'number', liabilityCents: 'number', customersWithBalance: 'number', byKind: 'array' }, proof);
      fields(object(body.last30Days, proof, 'last30Days'), { issued: 'number', redeemed: 'number' }, proof);
    } },
    { path: '/v1/admin/seo/config', verify(body: Json, proof: MatrixProof) {
      fields(body, { siteUrl: 'nullable-string', contactEmail: 'nullable-string', organization: 'object', robotsDisallow: 'array', staticPaths: 'array', productUrlPattern: 'string', indexNowConfigured: 'boolean' }, proof);
      fields(object(body.organization, proof, 'organization'), { name: 'string', logo: 'nullable-string', sameAs: 'array' }, proof);
    } },
    { path: '/v1/admin/seo/sitemaps', verify(body: Json, proof: MatrixProof) { fields(body, { configured: 'boolean', siteUrl: 'nullable-string', indexUrl: 'nullable-string', totalUrls: 'number', files: 'array', indexNowConfigured: 'boolean', cloudflareConfigured: 'boolean' }, proof); } },
    { path: '/v1/admin/waitlist/report', verify(body: Json, proof: MatrixProof) {
      proof.equal(body.groupBy, 'variant', 'default waitlist grouping');
      fields(body, { rows: 'array', truncated: 'boolean' }, proof);
      fields(object(body.range, proof, 'range'), { from: 'nullable-string', to: 'nullable-string' }, proof);
      fields(object(body.summary, proof, 'summary'), { pending: 'number', notified: 'number', canceled: 'number', unconfirmed: 'number', legacyClosed: 'number', total: 'number', products: 'number', variants: 'number' }, proof);
    } },
    { path: '/v1/admin/staff', gate: 'manage', verify(body: Json, proof: MatrixProof) {
      const items = rows(body, proof, { adminUserId: 'string', email: 'string', kind: 'string', role: 'string', createdAt: 'string', permissions: 'object' });
      proof.ok(items.some(row => row.role === 'owner' && row.kind === 'human'), 'store owner visible');
    } },
    { path: '/v1/admin/staff/invites', gate: 'manage', verify: list({ id: 'string', email: 'string', role: 'string', expiresAt: 'string' }) },
    { path: '/v1/admin/agents', gate: 'manage', verify: list({ id: 'string', adminUserId: 'string', name: 'string', email: 'string', role: 'string', createdAt: 'string' }) },
    { path: '/v1/admin/payment-archives', gate: 'refunds', verify(body: Json, proof: MatrixProof) {
      rows(body, proof, { id: 'string', sourceKey: 'string', sourceId: 'string', sourceDigest: 'string', importCurrencyContext: 'string', refundCount: 'number', referenceCount: 'number' });
      fields(body, { total: 'number' }, proof); proof.equal(body.limit, 25, 'archive limit'); proof.equal(body.offset, 0, 'archive offset');
    } },
    { path: '/v1/admin/payment-reconciliation', gate: 'refunds', verify(body: Json, proof: MatrixProof) { fields(body, { attempts: 'array', events: 'array', alerts: 'array', effects: 'array', paymentsAfterCancel: 'array' }, proof); } },
  ];
  function cell(spec: ReadSpec, principal: MatrixPrincipal): MatrixCell {
    const invalid = principal === 'release_service' || principal === 'cache_token';
    const foreign = principal === 'foreign_store' && !spec.global;
    const restricted = !!spec.gate && ['staff', 'read_only', 'agent'].includes(principal);
    const role = principal === 'read_only' ? 'read_only' : 'staff';
    const message = invalid ? null : foreign ? 'no access to store: ' + fixture.storeSlug
      : restricted ? spec.gate === 'manage' ? "role '" + role + "' cannot manage settings/staff"
      : "role '" + role + "' lacks the 'refunds' permission" : null;
    const denied = invalid || foreign || restricted;
    return {
      effect: denied ? 'deny' : 'allow',
      status: invalid ? 401 : denied ? 403 : 200,
      ...(denied ? { errorCode: invalid ? 'NOT_AUTHENTICATED' : fallbackCode(message!) } : {}),
      async prepare() {
        return {
          url: spec.path + (spec.query ?? ''),
          init: { method: 'GET', headers: { ...fixture.requestHeaders[principal], 'x-store-slug': fixture.storeSlug } },
          async verify(response, proof) {
            const body = object(await response.json(), proof, 'JSON response');
            if (denied) {
              const error = object(body.error, proof, 'error envelope');
              fields(error, { code: 'string', message: 'string' }, proof);
              if (message) proof.equal(error.message, message, 'authorization refusal');
              else if (principal === 'cache_token') proof.equal(error.message, 'not authenticated', 'cache token is not human authentication');
              else proof.equal(error.message, 'invalid or expired session', 'release credential is not human authentication');
            } else spec.verify(body, proof, principal);
          },
        };
      },
    };
  }
  return specs.map(spec => ({
    key: 'GET ' + spec.path,
    contract: 'admin' as const,
    // Every role is explicit. GET agent policy falls through to staff role; no sensitive grants.
    cells: {
      owner: cell(spec, 'owner'), manager: cell(spec, 'manager'), staff: cell(spec, 'staff'),
      read_only: cell(spec, 'read_only'), agent: cell(spec, 'agent'), foreign_store: cell(spec, 'foreign_store'),
      release_service: cell(spec, 'release_service'), cache_token: cell(spec, 'cache_token'),
    },
  }));
}
