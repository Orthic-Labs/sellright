/** B2.8 customer credential boundary. Test source only; no production exports. */
import { createHash, randomUUID } from 'node:crypto';
import { withStore } from '../db/client.js';
import { createSession } from '../auth/session.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import type { createAuthorizationFixtures } from './authorization-matrix.fixtures.testkit.js';
import { PRINCIPALS, type MatrixCase, type MatrixCell, type MatrixPrincipal, type MatrixProof, type PreparedMatrixCell } from './authorization-matrix.testkit.js';

type Fixture = Awaited<ReturnType<typeof createAuthorizationFixtures>>;
type Json = Record<string, any>;
type CustomerSeed = {
  customerId: string; email: string; password: string; passwordHash: string;
  headers: Record<string, string>; sessionHash: string; otherSessionHash: string;
  addressId: string; draftId: string; orderId: string; orderCode: string; lineId: string; sku: string;
};
export interface CustomerControl {
  key: string;
  status: number;
  prepare(): Promise<PreparedMatrixCell>;
}
/** Caller supplies an isolated configured Stripe boundary; never permit live network access. */
export interface CustomerCaseOptions {
  billingPortal?: {
    prepare(): Promise<{
      customerId: string;
      headers: Record<string, string>;
      expectedUrl: string;
      assertCommitted(proof: MatrixProof): Promise<void>;
    }>;
  };
}
type PreparedCustomer = {
  url: string; body?: unknown;
  verify(response: Response, proof: MatrixProof): Promise<void>;
};
type Spec = {
  key: string; status: number; concealment?: true;
  prepare(seed: CustomerSeed): Promise<PreparedCustomer>;
};
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const address = { fullName: 'Matrix Customer', line1: '101 Customer Street', line2: null,
  city: 'Matrix Town', province: 'CA', postalCode: '94000', country: 'us',
  phone: '+15550001001', isDefaultShipping: true, isDefaultBilling: false };
const ok = async (response: Response, proof: MatrixProof) => proof.equal(await response.json(), { ok: true }, 'exact customer success envelope');

/** Own-file factories use only existing fixture query seams; no shared fixture mutation. */
function customerSource(fixture: Fixture) {
  const rows = async (sql: string, values: unknown[] = []) => (await fixture.queryStore(fixture.storeId, sql, values)).rows;
  async function seed(): Promise<CustomerSeed> {
    const customerId = randomUUID(), email = 'customer-boundary-' + customerId + '@matrix.invalid';
    const password = 'Matrix-customer-' + randomUUID(), passwordHash = await hashPassword(password);
    const addressId = randomUUID(), draftId = randomUUID(), orderId = randomUUID(), lineId = randomUUID();
    const orderCode = 'CUSTOMER-' + randomUUID(), sku = 'CUSTOMER-SKU-' + randomUUID();
    await rows('INSERT INTO customer(id,store_id,email,password_hash,first_name,last_name,email_verified) VALUES($1,$2,$3,$4,$5,$6,true)',
      [customerId, fixture.storeId, email, passwordHash, 'Matrix', 'Customer']);
    const token = await withStore(fixture.storeId, tx => createSession(tx, fixture.storeId, customerId));
    const otherToken = await withStore(fixture.storeId, tx => createSession(tx, fixture.storeId, customerId));
    await rows('INSERT INTO address(id,store_id,customer_id,full_name,line1,city,country) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [addressId, fixture.storeId, customerId, 'Existing customer A', '1 Existing Street', 'Existing Town', 'US']);
    await rows('INSERT INTO customer_address_draft(id,store_id,customer_id,source_key,source_id,source_customer_id,source_digest,line1) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [draftId, fixture.storeId, customerId, 'matrix:customer-boundary', draftId, customerId, 'a'.repeat(64), 'Retained draft street']);
    await rows('INSERT INTO "order"(id,store_id,code,customer_id,state,currency,subtotal,grand_total,placed_at,shipping_address,billing_address,metadata) VALUES($1,$2,$3,$4,$5,$6,2500,2500,now(),$7::jsonb,$7::jsonb,$8::jsonb)',
      [orderId, fixture.storeId, orderCode, customerId, 'Paid', 'USD', JSON.stringify(address), JSON.stringify({ linked_via: 'session', contact: { email } })]);
    await rows('INSERT INTO order_line(id,store_id,order_id,variant_sku,variant_name,quantity,unit_price,line_subtotal,line_total,fulfilled_qty) VALUES($1,$2,$3,$4,$5,1,2500,2500,2500,1)',
      [lineId, fixture.storeId, orderId, sku, 'Customer boundary item']);
    return { customerId, email, password, passwordHash, headers: { authorization: 'Bearer ' + token,
      'x-store-slug': fixture.storeSlug, 'content-type': 'application/json' },
      sessionHash: digest(token), otherSessionHash: digest(otherToken), addressId, draftId, orderId, orderCode, lineId, sku };
  }
  const specs: Spec[] = [
    { key: 'POST /v1/shop/account/addresses', status: 201, async prepare(s) {
      const before = (await rows('SELECT id FROM address WHERE customer_id=$1', [s.customerId])).map(row => row.id);
      return { url: '/v1/shop/account/addresses', body: address, async verify(response: Response, proof: MatrixProof) {
        const body = await response.json() as Json;
        proof.ok(typeof body.id === 'string' && !before.includes(body.id), 'fresh address identity');
        proof.equal(await rows('SELECT customer_id,full_name,line1,line2,city,province,postal_code,country,phone,is_default_shipping,is_default_billing FROM address WHERE id=$1', [body.id]),
          [{ customer_id: s.customerId, full_name: address.fullName, line1: address.line1, line2: null,
            city: address.city, province: address.province, postal_code: address.postalCode, country: 'US',
            phone: address.phone, is_default_shipping: true, is_default_billing: false }], 'created address belongs to authenticated customer', 'state');
      } };
    } },
    { key: 'PATCH /v1/shop/account/addresses/{id}', status: 200, async prepare(s) {
      return { url: '/v1/shop/account/addresses/' + s.addressId, body: { city: 'Changed Customer Town', country: 'ca' },
        async verify(response: Response, proof: MatrixProof) {
          await ok(response, proof);
          proof.equal(await rows('SELECT customer_id,city,country FROM address WHERE id=$1', [s.addressId]),
            [{ customer_id: s.customerId, city: 'Changed Customer Town', country: 'CA' }], 'owned existing address update committed', 'state');
        } };
    } },
    { key: 'DELETE /v1/shop/account/addresses/{id}', status: 200, async prepare(s) {
      return { url: '/v1/shop/account/addresses/' + s.addressId, async verify(response: Response, proof: MatrixProof) {
        await ok(response, proof);
        proof.equal(await rows('SELECT id FROM address WHERE id=$1', [s.addressId]), [], 'owned existing address deleted', 'state');
        proof.equal((await rows('SELECT id FROM customer WHERE id=$1', [s.customerId])).length, 1, 'customer preserved', 'state');
      } };
    } },
    { key: 'POST /v1/shop/account/address-drafts/{id}/complete', status: 201, async prepare(s) {
      return { url: '/v1/shop/account/address-drafts/' + s.draftId + '/complete', body: address, async verify(response: Response, proof: MatrixProof) {
        const body = await response.json() as Json;
        proof.ok(typeof body.id === 'string' && body.id !== s.addressId, 'completed draft returns fresh native address');
        proof.equal(await rows('SELECT id FROM customer_address_draft WHERE id=$1', [s.draftId]), [], 'completed retained draft removed', 'state');
        proof.equal(await rows('SELECT customer_id,line1,city,country,is_default_shipping FROM address WHERE id=$1', [body.id]),
          [{ customer_id: s.customerId, line1: address.line1, city: address.city, country: 'US', is_default_shipping: true }],
          'native completed address committed for same customer', 'state');
      } };
    } },
    { key: 'DELETE /v1/shop/account/address-drafts/{id}', status: 200, async prepare(s) {
      const before = await rows('SELECT * FROM address WHERE customer_id=$1 ORDER BY id', [s.customerId]);
      return { url: '/v1/shop/account/address-drafts/' + s.draftId, async verify(response: Response, proof: MatrixProof) {
        await ok(response, proof);
        proof.equal(await rows('SELECT id FROM customer_address_draft WHERE id=$1', [s.draftId]), [], 'owned retained draft deleted', 'state');
        proof.equal(await rows('SELECT * FROM address WHERE customer_id=$1 ORDER BY id', [s.customerId]), before, 'draft deletion creates no native address', 'state');
      } };
    } },
    { key: 'PUT /v1/shop/account/birthday', status: 200, async prepare(s) {
      return { url: '/v1/shop/account/birthday', body: { month: 6, day: 15 }, async verify(response: Response, proof: MatrixProof) {
        proof.equal(await response.json(), { month: 6, day: 15 }, 'saved customer birthday');
        proof.equal(await rows('SELECT birth_month,birth_day FROM customer WHERE id=$1', [s.customerId]),
          [{ birth_month: 6, birth_day: 15 }], 'verified customer birthday persisted', 'state');
      } };
    } },
    { key: 'PATCH /v1/shop/account/me', status: 200, async prepare(s) {
      const patch = { firstName: 'Changed Matrix', lastName: 'Changed Customer', phone: '+15550002002' };
      return { url: '/v1/shop/account/me', body: patch, async verify(response: Response, proof: MatrixProof) {
        proof.equal(await response.json(), { id: s.customerId, email: s.email, ...patch }, 'updated own profile response');
        proof.equal(await rows('SELECT email,first_name,last_name,phone FROM customer WHERE id=$1', [s.customerId]),
          [{ email: s.email, first_name: patch.firstName, last_name: patch.lastName, phone: patch.phone }],
          'own profile committed', 'state');
      } };
    } },
    { key: 'POST /v1/shop/account/password', status: 200, async prepare(s) {
      const next = 'Next-Matrix-password-' + randomUUID();
      return { url: '/v1/shop/account/password', body: { currentPassword: s.password, newPassword: next }, async verify(response: Response, proof: MatrixProof) {
        await ok(response, proof);
        const saved = (await rows('SELECT password_hash FROM customer WHERE id=$1', [s.customerId]))[0]!;
        proof.ok(saved.password_hash !== s.passwordHash, 'password hash replaced', 'state');
        proof.equal(await verifyPassword(next, saved.password_hash), true, 'new password verifies against committed hash', 'state');
        proof.equal(await verifyPassword(s.password, saved.password_hash), false, 'old password rejected', 'state');
        proof.equal((await rows('SELECT token_hash FROM session WHERE customer_id=$1 ORDER BY token_hash', [s.customerId])).map(row => row.token_hash),
          [s.sessionHash], 'current customer session retained & other session revoked', 'state');
      } };
    } },
    { key: 'DELETE /v1/shop/account', status: 200, async prepare(s) {
      return { url: '/v1/shop/account', async verify(response: Response, proof: MatrixProof) {
        proof.equal(await response.json(), { deleted: true }, 'customer erasure response');
        for (const table of ['customer', 'session', 'address', 'customer_address_draft']) {
          proof.equal(await rows('SELECT id FROM ' + table + ' WHERE ' + (table === 'customer' ? 'id' : 'customer_id') + '=$1', [s.customerId]),
            [], 'erasure removes owned ' + table, 'state');
        }
        const saved = (await rows('SELECT customer_id,shipping_address,billing_address,grand_total,metadata FROM "order" WHERE id=$1', [s.orderId]))[0]!;
        proof.equal({ customer_id: saved.customer_id, shipping_address: saved.shipping_address, billing_address: saved.billing_address, grand_total: saved.grand_total },
          { customer_id: null, shipping_address: null, billing_address: null, grand_total: 2500 }, 'financial record retained & personal links scrubbed', 'state');
        proof.ok(typeof saved.metadata.anonymized_at === 'string' && !('contact' in saved.metadata), 'order contact removed & erasure timestamp recorded', 'state');
      } };
    } },
    { key: 'GET /v1/shop/account/orders/{code}', status: 200, concealment: true, async prepare(s) {
      const before = await rows('SELECT * FROM "order" WHERE id=$1', [s.orderId]);
      return { url: '/v1/shop/account/orders/' + s.orderCode, async verify(response: Response, proof: MatrixProof) {
        const body = await response.json() as Json;
        proof.equal({ code: body.code, state: body.state, currency: body.currency, subtotal: body.subtotal, grandTotal: body.grandTotal },
          { code: s.orderCode, state: 'Paid', currency: 'USD', subtotal: 2500, grandTotal: 2500 }, 'exact existing customer-A order');
        proof.equal(body.lines.map((line: Json) => ({ sku: line.sku, quantity: line.quantity, unitPrice: line.unitPrice, lineTotal: line.lineTotal })),
          [{ sku: s.sku, quantity: 1, unitPrice: 2500, lineTotal: 2500 }], 'owned order line projection');
        proof.equal(body.shippingAddress.line1, address.line1, 'private owned shipping address available only to customer');
        proof.equal(await rows('SELECT * FROM "order" WHERE id=$1', [s.orderId]), before, 'existing concealed order remains unchanged', 'state');
      } };
    } },
    { key: 'GET /v1/shop/account/orders/{code}/returns', status: 200, async prepare(s) {
      return { url: '/v1/shop/account/orders/' + s.orderCode + '/returns', async verify(response: Response, proof: MatrixProof) {
        proof.equal(await response.json(), { returnable: [{ sku: s.sku, name: 'Customer boundary item', quantity: 1 }], items: [] },
          'existing owned paid order has genuinely returnable shipped unit');
      } };
    } },
    { key: 'POST /v1/shop/account/orders/{code}/returns', status: 201, async prepare(s) {
      const reason = 'Matrix customer received damaged item';
      return { url: '/v1/shop/account/orders/' + s.orderCode + '/returns', body: { lines: [{ sku: s.sku, quantity: 1 }], reason },
        async verify(response: Response, proof: MatrixProof) {
          const body = await response.json() as Json;
          proof.equal(body.status, 'requested', 'customer return request status');
          proof.ok(typeof body.id === 'string', 'new return request identity');
          proof.equal(await rows('SELECT order_id,status,reason FROM return_request WHERE id=$1', [body.id]),
            [{ order_id: s.orderId, status: 'requested', reason }], 'owned return request committed', 'state');
          proof.equal(await rows('SELECT order_line_id,quantity,restock FROM return_line WHERE return_id=$1', [body.id]),
            [{ order_line_id: s.lineId, quantity: 1, restock: false }], 'request consumes real shipped unit without customer-controlled restock', 'state');
          proof.equal(await rows('SELECT actor,action,data FROM audit_log WHERE entity=$1 AND entity_id=$2', ['return', body.id]),
            [{ actor: s.email, action: 'create', data: { orderCode: s.orderCode, lines: 1, source: 'customer' } }],
            'committed return audit attributes genuine customer', 'state');
        } };
    } },
    { key: 'POST /v1/shop/auth/request-email-change', status: 200, async prepare(s) {
      const newEmail = 'changed-' + randomUUID() + '@matrix.invalid';
      return { url: '/v1/shop/auth/request-email-change', body: { newEmail, password: s.password }, async verify(response: Response, proof: MatrixProof) {
        await ok(response, proof);
        const tokens = await rows('SELECT kind,payload,used_at,token_hash,expires_at FROM customer_token WHERE customer_id=$1', [s.customerId]);
        proof.equal(tokens.length, 1, 'one committed email-change token', 'state');
        proof.equal({ kind: tokens[0]!.kind, payload: tokens[0]!.payload, used_at: tokens[0]!.used_at },
          { kind: 'email_change', payload: { newEmail }, used_at: null }, 'unused email-change token bound to intended mailbox', 'state');
        proof.ok(tokens[0]!.expires_at instanceof Date && tokens[0]!.expires_at.getTime() > Date.now(), 'email-change token has future expiry', 'state');
        const mail = await rows('SELECT recipient,payload FROM email_outbox WHERE store_id=$1 AND recipient=$2', [fixture.storeId, newEmail]);
        proof.equal(mail.length, 1, 'verification mail committed to new mailbox', 'state');
        proof.equal(mail[0]!.recipient, newEmail, 'mail destination matches token payload', 'state');
        const serialized = JSON.stringify(mail[0]!.payload);
        const raw = /[?&]token=([A-Za-z0-9_-]+)/.exec(serialized)?.[1];
        proof.ok(raw && digest(raw) === tokens[0]!.token_hash, 'committed outbox contains matching token link', 'state');
        proof.equal((await rows('SELECT email FROM customer WHERE id=$1', [s.customerId]))[0]!.email, s.email, 'email remains unchanged before verification', 'state');
        proof.equal((await rows('SELECT token_hash FROM session WHERE customer_id=$1', [s.customerId])).length, 2, 'request preserves customer sessions pending verification', 'state');
      } };
    } },
  ];
  return { rows, seed, specs };
}

const deny = async (response: Response, proof: MatrixProof) => {
  const body = await response.json() as Json;
  proof.equal(Object.keys(body).sort(), ['error'], 'no customer data accompanies denial');
  proof.equal(body.error?.code, 'NOT_AUTHENTICATED', 'admin/service/cache credentials lack customer session');
  proof.equal(body.error?.message, 'not authenticated', 'customer authentication denial');
};

export function createCustomerCases(fixture: Fixture, options: CustomerCaseOptions = {}): MatrixCase[] {
  const source = customerSource(fixture);
  // Shared denial target stays present through all denials; customer controls use fresh destructive fixtures.
  let existing: Promise<CustomerSeed> | undefined;
  const target = () => existing ??= source.seed();
  const cases = source.specs.map(spec => {
    const method = spec.key.split(' ')[0]!;
    const cell = (principal: MatrixPrincipal): MatrixCell => ({
      effect: 'deny', status: spec.concealment ? 404 : 401, errorCode: 'NOT_AUTHENTICATED',
      // account.ts order-detail handler deliberately conceals missing credentials as 404 NOT_AUTHENTICATED.
      ...(spec.concealment ? { concealment: true as const } : {}),
      async prepare() {
        const prepared = await spec.prepare(await target());
        const before = method === 'GET' ? await fixture.snapshot() : undefined;
        return { url: prepared.url, init: { method, headers: fixture.requestHeaders[principal],
          ...(prepared.body === undefined ? {} : { body: JSON.stringify(prepared.body) }) },
          // Shop handlers do not resolve admin principals or emit admin-agent attribution.
          snapshot: fixture.snapshot, async verify(response: Response, proof: MatrixProof) {
            await deny(response, proof);
            if (method === 'GET') proof.equal(await fixture.snapshot(), before, 'denied customer read changes no DB/files/provider state', 'state');
          } };
      },
    });
    return { key: spec.key, contract: 'customer' as const, cells: Object.fromEntries(PRINCIPALS.map(p => [p, cell(p)])) as Record<MatrixPrincipal, MatrixCell>,
      ...(spec.concealment ? { concealmentControl: async () => {
        const s = await target(), prepared = await spec.prepare(s);
        return { url: prepared.url, init: { method, headers: s.headers }, verify: prepared.verify };
      } } : {}) };
  });
  cases.push({ key: 'GET /v1/shop/auth/me', contract: 'customer', cells: Object.fromEntries(PRINCIPALS.map(principal => [principal, {
    effect: 'deny' as const, status: 401, errorCode: 'NOT_AUTHENTICATED', async prepare() {
      const before = await fixture.snapshot();
      return { url: '/v1/shop/auth/me', init: { headers: fixture.requestHeaders[principal] }, snapshot: fixture.snapshot, async verify(response: Response, proof: MatrixProof) {
        await deny(response, proof);
        proof.equal(await fixture.snapshot(), before, 'denied profile read changes no DB/files/provider state', 'state');
      } };
    },
  }])) as Record<MatrixPrincipal, MatrixCell> });
  if (options.billingPortal) cases.push({ key: 'POST /v1/shop/account/billing-portal', contract: 'customer',
    cells: Object.fromEntries(PRINCIPALS.map(principal => [principal, {
      effect: 'deny' as const, status: 401, errorCode: 'NOT_AUTHENTICATED', async prepare() {
        await options.billingPortal!.prepare();
        return { url: '/v1/shop/account/billing-portal', init: { method: 'POST', headers: fixture.requestHeaders[principal] },
          snapshot: fixture.snapshot, verify: deny };
      },
    }])) as Record<MatrixPrincipal, MatrixCell> });
  return cases;
}

/** Run after every matrix denial; prepare/request/verify exactly once per control. */
export function createCustomerControls(fixture: Fixture, options: CustomerCaseOptions = {}): CustomerControl[] {
  const source = customerSource(fixture);
  const controls: CustomerControl[] = source.specs.map(spec => ({
    key: spec.key, status: spec.status, async prepare() {
      const s = await source.seed(), prepared = await spec.prepare(s);
      return { url: prepared.url, init: { method: spec.key.split(' ')[0], headers: s.headers,
        ...(prepared.body === undefined ? {} : { body: JSON.stringify(prepared.body) }) }, verify: prepared.verify };
    },
  }));
  controls.push({ key: 'GET /v1/shop/auth/me', status: 200, async prepare() {
    return { url: '/v1/shop/auth/me', init: { headers: fixture.customerHeaders }, async verify(response: Response, proof: MatrixProof) {
      const body = await response.json() as Json;
      proof.equal(body.id, fixture.expectedCustomerId, 'genuine existing customer-A session');
      proof.ok(body.id !== fixture.foreignCustomerId && typeof body.email === 'string', 'only own customer profile returned');
      proof.equal(body.emailVerified, true, 'real customer verification state');
      proof.ok(!('passwordHash' in body) && !('password_hash' in body), 'credential hash absent from profile');
    } };
  } });
  if (options.billingPortal) controls.push({ key: 'POST /v1/shop/account/billing-portal', status: 200, async prepare() {
    const prepared = await options.billingPortal!.prepare();
    return { url: '/v1/shop/account/billing-portal', init: { method: 'POST', headers: prepared.headers }, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await response.json(), { url: prepared.expectedUrl }, 'isolated provider returns real configured customer portal URL');
      await prepared.assertCommitted(proof);
    } };
  } });
  return controls;
}
