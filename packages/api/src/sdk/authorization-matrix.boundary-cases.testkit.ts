/** Public/customer/service contracts keep admin credentials distinct from domain credentials. */
import type { createAuthorizationFixtures } from './authorization-matrix.fixtures.testkit.js';
import { PRINCIPALS, type MatrixCase, type MatrixCell, type MatrixPrincipal, type MatrixProof } from './authorization-matrix.testkit.js';
type Fixture = Awaited<ReturnType<typeof createAuthorizationFixtures>>;
const cells = (make: (principal: MatrixPrincipal) => MatrixCell) => Object.fromEntries(PRINCIPALS.map(p => [p, make(p)])) as Record<MatrixPrincipal, MatrixCell>;
export function createBoundaryCases(fixture: Fixture): MatrixCase[] {
  const cases: MatrixCase[] = [];
  const publicRead = (path: string, verify: (body: Record<string, any>, proof: MatrixProof) => void) => cases.push({
    key: `GET ${path}`, contract: 'public', cells: cells(principal => ({ effect: 'allow', status: 200,
      async prepare() { return { url: path, init: { headers: fixture.requestHeaders[principal] },
        async verify(response: Response, proof: MatrixProof) { verify(await response.json() as Record<string, any>, proof); } }; },
    })),
  });
  publicRead('/v1/health', (body: Record<string, any>, proof: MatrixProof) => { proof.equal(body.status, 'ok', 'public health'); proof.ok(typeof body.version === 'string' && body.version.length > 0, 'engine version'); });
  publicRead('/v1/readyz', (body: Record<string, any>, proof: MatrixProof) => { proof.equal(body, { status: 'ok', db: 'ok' }, 'actual database readiness'); });
  publicRead('/v1/maintenance', (body: Record<string, any>, proof: MatrixProof) => { proof.equal(body, { maintenance: false }, 'no maintenance fixture'); });
  publicRead('/v1/shop/cache-version', (body: Record<string, any>, proof: MatrixProof) => { proof.ok(typeof body.version === 'string' && body.version.length > 0, 'store invalidation version'); });
  cases.push({ key: 'GET /v1/openapi.json', contract: 'admin', cells: cells(principal => {
    const allow = !['release_service', 'cache_token'].includes(principal);
    return { effect: allow ? 'allow' : 'deny', status: allow ? 200 : 401,
      ...(allow ? {} : { errorCode: 'NOT_AUTHENTICATED' }), async prepare() {
        return { url: '/v1/openapi.json', init: { headers: fixture.requestHeaders[principal] }, async verify(response: Response, proof: MatrixProof) {
          const body = await response.json() as Record<string, any>;
          if (allow) { proof.equal(body.openapi, '3.0.0', 'OpenAPI contract version'); proof.ok(Boolean(body.paths?.['/v1/admin/products']?.get), 'protected admin schema exists'); }
          else proof.equal(body.error?.message, 'not authenticated', 'production schema denies non-admin credentials');
        } };
      } };
  }) });
  for (const path of ['/v1/admin/system/build-info', '/v1/admin/system/effective-config']) {
    cases.push({ key: `GET ${path}`, contract: 'admin', cells: cells(principal => {
      const status = ['release_service', 'cache_token'].includes(principal) ? 401 : 403;
      return { effect: 'deny', status, async prepare() { return { url: path, init: { headers: fixture.requestHeaders[principal] },
        async verify(response: Response, proof: MatrixProof) {
          const body = await response.json() as Record<string, any>;
          if (status === 403) proof.equal(body.error?.message, 'requires installation administrator', 'store role grants no installation authority');
          else proof.equal(body.error?.code, 'NOT_AUTHENTICATED', 'service/cache token grants no installation authority');
          proof.ok(!('deployment' in body) && !('build' in body) && !('intended' in body), 'install data absent');
        } }; } };
    }) });
  }
  for (const path of ['/v1/shop/account/address-drafts', '/v1/shop/account/addresses', '/v1/shop/account/orders', '/v1/shop/account/licenses', '/v1/shop/account/export', '/v1/shop/account/loyalty']) {
    cases.push({ key: `GET ${path}`, contract: 'customer', cells: cells(principal => ({ effect: 'deny', status: 401, errorCode: 'NOT_AUTHENTICATED',
      async prepare() { return { url: path, init: { headers: fixture.requestHeaders[principal] }, async verify(response: Response, proof: MatrixProof) {
        const body = await response.json() as Record<string, any>;
        proof.equal(body.error?.message, 'not authenticated', 'admin/service/cache token grants no customer session');
        proof.ok(!('profile' in body) && !('items' in body) && !('balance' in body), 'customer data absent');
      } }; },
    })) });
  }
  cases.push({ key: 'POST /v1/admin/cache/purge', contract: 'service', cells: cells(principal => {
    const allow = principal === 'cache_token';
    return { effect: allow ? 'allow' : 'deny', status: allow ? 200 : 401, async prepare() {
      const before = allow ? await fixture.snapshot() : undefined;
      return { url: '/v1/admin/cache/purge', init: { method: 'POST', headers: fixture.requestHeaders[principal], body: JSON.stringify({ storeSlug: fixture.storeSlug }) },
        ...(allow ? {} : { snapshot: fixture.snapshotFor(principal, 'POST', '/v1/admin/cache/purge', 401) }),
        async verify(response: Response, proof: MatrixProof) {
          const body = await response.json() as Record<string, any>;
          if (allow) {
            proof.equal(body, { ok: true, purged: false, reason: 'no Cloudflare zone/token configured for this store' }, 'cache token owns cache route');
            proof.equal(await fixture.snapshot(), before, 'unconfigured synthetic provider produces no effects', 'state');
          } else proof.equal(body.error?.message, 'invalid or missing cache admin token', 'session/release tokens grant no cache capability');
        } };
    } };
  }) });
  return cases;
}
