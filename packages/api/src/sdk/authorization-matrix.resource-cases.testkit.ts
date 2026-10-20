/** B2.8 existing-resource read contracts. Test source only; never part of engine exports. */
import { randomUUID } from 'node:crypto';
import type { createAuthorizationFixtures } from './authorization-matrix.fixtures.testkit.js';
import type { MatrixCase, MatrixCell, MatrixPrincipal, MatrixProof, PreparedMatrixCell } from './authorization-matrix.testkit.js';

export type MatrixResourceFixture = Pick<Awaited<ReturnType<typeof createAuthorizationFixtures>>,
  'seedProduct' | 'queryStore' | 'requestHeaders' | 'storeId' | 'storeSlug' | 'expectedCustomerId'>;
type Json = Record<string, unknown>;
type PreparedResource = { url: string; verify(body: Json, proof: MatrixProof, principal: MatrixPrincipal): void };
type ResourceSpec = { key: string; prepare(): Promise<PreparedResource> };

function object(value: unknown, proof: MatrixProof, label: string): Json {
  proof.ok(value !== null && typeof value === 'object' && !Array.isArray(value), label);
  return value as Json;
}
function array(value: unknown, proof: MatrixProof, label: string): Json[] {
  proof.ok(Array.isArray(value), label);
  return value.map((row, i) => object(row, proof, label + '[' + i + ']'));
}
function code(message: string): string {
  return message.normalize('NFKD').replace(/[^a-zA-Z0-9\s_]/g, '').trim().toUpperCase().replace(/\s+/g, '_').slice(0, 64) || 'ERROR';
}

export function createResourceCases(fixture: MatrixResourceFixture): MatrixCase[] {
  const { storeId, storeSlug, queryStore } = fixture;
  // Every prepare creates genuine, isolated store-A targets, including denial cells.
  async function product() {
    const seed = await fixture.seedProduct();
    await queryStore(storeId, 'UPDATE stock SET on_hand=17,allocated=2 WHERE variant_id=$1', [seed.variantId]);
    return seed;
  }
  async function customer() {
    const id = randomUUID(), email = 'resource-' + id + '@matrix.invalid';
    await queryStore(storeId, 'INSERT INTO customer(id,store_id,email,first_name,last_name,email_verified,tags) VALUES($1,$2,$3,$4,$5,true,$6::text[])',
      [id, storeId, email, 'Resource', 'Customer', ['matrix-resource']]);
    return { id, email };
  }
  async function movement() {
    const seed = await product(), movementId = randomUUID();
    await queryStore(storeId, 'INSERT INTO stock_movement(id,store_id,variant_id,delta,reason,actor) VALUES($1,$2,$3,17,$4,$5)',
      [movementId, storeId, seed.variantId, 'authorization matrix opening stock', 'matrix:resource']);
    return { ...seed, movementId };
  }
  const specs: ResourceSpec[] = [
    { key: 'GET /v1/admin/products/{id}', async prepare() {
      const seed = await product();
      return { url: '/v1/admin/products/' + seed.productId, verify(body: Json, proof: MatrixProof) {
        proof.equal(body.id, seed.productId, 'exact existing store-A product');
        proof.equal(body.status, 'active', 'product status');
        proof.equal(typeof body.slug, 'string', 'product slug');
        const variants = array(body.variants, proof, 'product variants');
        proof.equal(variants.length, 1, 'one seeded variant');
        const variant = variants[0]!;
        proof.equal(variant.id, seed.variantId, 'exact seeded variant');
        proof.equal(variant.name, 'Matrix variant', 'variant name');
        proof.equal(variant.price, 2500, 'variant price');
        proof.equal(variant.onHand, 17, 'live stock');
        proof.equal(variant.allocated, 2, 'allocated stock');
        proof.equal(variant.available, 15, 'available stock');
      } };
    } },
    { key: 'GET /v1/admin/products/{id}/options', async prepare() {
      const seed = await product(), groupId = randomUUID(), optionId = randomUUID();
      await queryStore(storeId, 'INSERT INTO product_option_group(id,store_id,product_id,name,position) VALUES($1,$2,$3,$4,3)',
        [groupId, storeId, seed.productId, 'Matrix size']);
      await queryStore(storeId, 'INSERT INTO product_option(id,store_id,group_id,value,position) VALUES($1,$2,$3,$4,7)',
        [optionId, storeId, groupId, 'Matrix large']);
      return { url: '/v1/admin/products/' + seed.productId + '/options', verify(body: Json, proof: MatrixProof) {
        const groups = array(body.groups, proof, 'option groups');
        proof.equal(groups.length, 1, 'one seeded option group');
        proof.equal(groups[0]!.id, groupId, 'seeded group identity');
        proof.equal(groups[0]!.name, 'Matrix size', 'group name');
        proof.equal(groups[0]!.position, 3, 'group ordering');
        proof.equal(groups[0]!.options, [{ id: optionId, value: 'Matrix large', position: 7 }], 'seeded option projection');
      } };
    } },
    { key: 'GET /v1/admin/variants/{id}/movements', async prepare() {
      const seed = await movement();
      return { url: '/v1/admin/variants/' + seed.variantId + '/movements', verify(body: Json, proof: MatrixProof) {
        const items = array(body.items, proof, 'stock movements');
        proof.equal(items.length, 1, 'one existing movement');
        proof.equal(items[0]!.delta, 17, 'movement quantity');
        proof.equal(items[0]!.reason, 'authorization matrix opening stock', 'movement reason');
        proof.equal(items[0]!.refOrderId, null, 'opening stock is not order-linked');
        proof.equal(typeof items[0]!.createdAt, 'string', 'movement timestamp');
      } };
    } },
    { key: 'GET /v1/admin/variants/{id}/stock/history', async prepare() {
      const seed = await movement();
      return { url: '/v1/admin/variants/' + seed.variantId + '/stock/history?page=1&pageSize=25', verify(body: Json, proof: MatrixProof) {
        const items = array(body.items, proof, 'stock history');
        proof.equal(body.total, 1, 'one movement total');
        proof.equal(body.page, 1, 'history page');
        proof.equal(body.pageSize, 25, 'history page size');
        proof.equal(items.length, 1, 'one returned movement');
        proof.equal(items[0]!.id, seed.movementId, 'exact movement identity');
        proof.equal(items[0]!.delta, 17, 'movement quantity');
        proof.equal(items[0]!.reason, 'authorization matrix opening stock', 'movement reason');
        proof.equal(items[0]!.actor, 'matrix:resource', 'movement attribution');
      } };
    } },
    { key: 'GET /v1/admin/variants/{id}/stock/locations', async prepare() {
      const seed = await product(), locationId = randomUUID(), locationCode = 'matrix-' + locationId;
      await queryStore(storeId, 'INSERT INTO location(id,store_id,name,code,is_default,enabled) VALUES($1,$2,$3,$4,false,true)',
        [locationId, storeId, 'Matrix resource warehouse', locationCode]);
      await queryStore(storeId, 'INSERT INTO stock_location(store_id,variant_id,location_id,on_hand) VALUES($1,$2,$3,17)',
        [storeId, seed.variantId, locationId]);
      return { url: '/v1/admin/variants/' + seed.variantId + '/stock/locations', verify(body: Json, proof: MatrixProof) {
        proof.equal(body.items, [{ locationId, name: 'Matrix resource warehouse', code: locationCode, onHand: 17 }], 'exact seeded location & stock');
      } };
    } },
    { key: 'GET /v1/admin/customers/{id}', async prepare() {
      const seed = await customer();
      return { url: '/v1/admin/customers/' + seed.id, verify(body: Json, proof: MatrixProof) {
        proof.equal(body.id, seed.id, 'exact existing store-A customer');
        proof.equal(body.email, seed.email, 'customer email');
        proof.equal(body.firstName, 'Resource', 'customer first name');
        proof.equal(body.lastName, 'Customer', 'customer last name');
        proof.equal(body.emailVerified, true, 'customer verification');
        proof.equal(body.tags, ['matrix-resource'], 'customer tags');
        proof.equal(body.orderCount, 0, 'fresh customer order count');
        proof.equal(body.spent, 0, 'fresh customer spend');
        proof.equal(body.orders, [], 'fresh customer order projection');
        proof.equal(body.addresses, [], 'fresh customer address projection');
      } };
    } },
    { key: 'GET /v1/admin/customers/{id}/loyalty', async prepare() {
      const seed = await customer(), ledgerId = randomUUID();
      await queryStore(storeId, 'INSERT INTO loyalty_ledger(id,store_id,customer_id,kind,points,reason,actor,source_ref) VALUES($1,$2,$3,$4,37,$5,$6,$7)',
        [ledgerId, storeId, seed.id, 'adjust', 'authorization matrix opening points', 'matrix:resource', 'matrix-resource:' + ledgerId]);
      // Read current effective divisor, so another in-scope settings case cannot invalidate this fixture.
      const settings = await queryStore(storeId, 'SELECT config FROM store WHERE id=$1', [storeId]);
      const loyalty = (settings.rows[0]!.config as { loyalty?: { pointsPerDollarOff?: number } } | null)?.loyalty;
      const divisor = loyalty?.pointsPerDollarOff ?? 10;
      return { url: '/v1/admin/customers/' + seed.id + '/loyalty', verify(body: Json, proof: MatrixProof) {
        proof.equal(body.customerId, seed.id, 'exact loyalty customer');
        proof.equal(body.balance, 37, 'seeded points balance');
        proof.equal(body.available, 37, 'available non-expiring points');
        proof.equal(body.pendingExpiry, 0, 'no expired lots');
        proof.equal(body.availableValue, Math.floor(3700 / divisor), 'points value');
        const ledger = array(body.ledger, proof, 'loyalty ledger');
        proof.equal(ledger.length, 1, 'one seeded ledger entry');
        proof.equal(ledger[0]!.id, ledgerId, 'exact ledger entry');
        proof.equal(ledger[0]!.kind, 'adjust', 'adjustment kind');
        proof.equal(ledger[0]!.points, 37, 'ledger points');
        proof.equal(ledger[0]!.reason, 'authorization matrix opening points', 'ledger reason');
        proof.equal(ledger[0]!.actor, 'matrix:resource', 'ledger attribution');
        proof.equal(ledger[0]!.reversible, false, 'ordinary adjustment is not bonus reversal');
      } };
    } },
    { key: 'GET /v1/admin/customers/{id}/verification', async prepare() {
      const seed = await customer(), attemptId = randomUUID(), verificationId = 'matrix-verification-' + randomUUID();
      const verifiedAt = '2026-10-01T00:00:00.000Z', expiresAt = '2099-10-01T00:00:00.000Z';
      const entry = { category: 'student', programId: 'matrix-program', discountPercent: 12, verifiedAt, expiresAt, verificationId };
      await queryStore(storeId, 'UPDATE customer SET active_verifications=$2::text[],sheerid_verifications=$3::jsonb WHERE id=$1',
        [seed.id, ['student'], JSON.stringify([entry])]);
      await queryStore(storeId, 'INSERT INTO sheerid_verification(id,store_id,customer_id,verification_id,program_id,category,status,discount_percent,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,12,$8)',
        [attemptId, storeId, seed.id, verificationId, 'matrix-program', 'student', 'success', expiresAt]);
      return { url: '/v1/admin/customers/' + seed.id + '/verification', verify(body: Json, proof: MatrixProof, principal: MatrixPrincipal) {
        proof.equal(body.customerId, seed.id, 'exact verified customer');
        proof.equal(body.active, ['student'], 'active category');
        proof.equal(body.entries, [{ category: 'student', programId: 'matrix-program', discountPercent: 12, verifiedAt, expiresAt, source: 'sheerid' }], 'stored verification provenance');
        const attempts = array(body.attempts, proof, 'verification attempts');
        proof.equal(attempts.length, 1, 'one seeded attempt');
        proof.equal(attempts[0]!.id, attemptId, 'exact verification attempt');
        proof.equal(attempts[0]!.category, 'student', 'attempt category');
        proof.equal(attempts[0]!.status, 'success', 'attempt status');
        proof.equal(body.canClear, principal === 'owner' || principal === 'manager', 'permission-derived clear control');
      } };
    } },
  ];
  function cell(spec: ResourceSpec, principal: MatrixPrincipal): MatrixCell {
    const invalid = principal === 'release_service' || principal === 'cache_token';
    const foreign = principal === 'foreign_store';
    const denied = invalid || foreign;
    const foreignMessage = 'no access to store: ' + storeSlug;
    return {
      effect: denied ? 'deny' : 'allow',
      status: invalid ? 401 : foreign ? 403 : 200,
      ...(denied ? { errorCode: invalid ? 'NOT_AUTHENTICATED' : code(foreignMessage) } : {}),
      async prepare(): Promise<PreparedMatrixCell> {
        const resource = await spec.prepare();
        return {
          url: resource.url,
          init: { method: 'GET', headers: { ...fixture.requestHeaders[principal], 'x-store-slug': storeSlug } },
          async verify(response: Response, proof: MatrixProof) {
            const body = object(await response.json(), proof, 'resource JSON');
            if (denied) {
              const error = object(body.error, proof, 'authorization error');
              proof.equal(error.message, foreign ? foreignMessage : principal === 'cache_token' ? 'not authenticated' : 'invalid or expired session', 'exact authorization refusal for existing target');
            } else resource.verify(body, proof, principal);
          },
        };
      },
    };
  }
  return specs.map(spec => ({ key: spec.key, contract: 'admin' as const, cells: {
    owner: cell(spec, 'owner'), manager: cell(spec, 'manager'), staff: cell(spec, 'staff'),
    read_only: cell(spec, 'read_only'), agent: cell(spec, 'agent'), foreign_store: cell(spec, 'foreign_store'),
    release_service: cell(spec, 'release_service'), cache_token: cell(spec, 'cache_token'),
  } }));
}
