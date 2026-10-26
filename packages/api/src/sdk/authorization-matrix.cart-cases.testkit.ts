/** B2.8 public cart/capability contracts. Test source only; never exported by engine. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withStore } from '../db/client.js';
import { createSession } from '../auth/session.js';
import { invalidateStoreCache } from '../store-context.js';
import type { createAuthorizationFixtures } from './authorization-matrix.fixtures.testkit.js';
import { PRINCIPALS, type MatrixCase, type MatrixCell, type MatrixPrincipal, type MatrixProof, type PreparedMatrixCell } from './authorization-matrix.testkit.js';

type Fixture = Awaited<ReturnType<typeof createAuthorizationFixtures>>;
type Json = Record<string, any>;
export interface CartControl { key: string; status: number; prepare(): Promise<PreparedMatrixCell> }
type Seed = { productId: string; variantId: string; sku: string; cartId: string; token: string; customerId: string; email: string; customerHeaders: Record<string, string>; legacyId: string };
type Prepared = { url: string; body?: unknown; headers?: Record<string, string>; verify(response: Response, proof: MatrixProof): Promise<void> };
type Spec = { key: string; contract: MatrixCase['contract']; prepare(seed: Seed): Promise<Prepared> };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const json = async (response: Response) => await response.json() as Json;
const principalCells = (make: (principal: MatrixPrincipal) => MatrixCell): Record<MatrixPrincipal, MatrixCell> => ({
  owner: make('owner'), manager: make('manager'), staff: make('staff'), read_only: make('read_only'),
  agent: make('agent'), foreign_store: make('foreign_store'), release_service: make('release_service'), cache_token: make('cache_token'),
});
let peerSequence = 0;
/** Real in-process socket binding, not a forged proxy header; independent synthetic clients avoid throttle contamination. */
const peer = () => ({ remoteAddr: '198.18.' + Math.floor(++peerSequence / 250) + '.' + ((peerSequence % 250) + 1) });

function source(fixture: Fixture) {
  const rows = async (sql: string, values: unknown[] = []) => (await fixture.queryStore(fixture.storeId, sql, values)).rows;
  async function seed(): Promise<Seed> {
    // Earlier admin cells deliberately change store tax & destination zones.
    // Establish this public contract's own pricing basis before its full journal.
    await rows('UPDATE store SET currency=$2,tax_rate=0,tax_inclusive=false,shipping_taxable=false,config=coalesce(config,$3::jsonb)||$4::jsonb WHERE id=$1',
      [fixture.storeId, 'USD', '{}', JSON.stringify({ published: true, pricing: { variantRule: 'preorder' },
        cart: { ttlDays: 1, abandonAfterHours: 1, retentionDays: 1 }, loyalty: { enabled: false } })]);
    await rows('UPDATE tax_zone SET enabled=false WHERE store_id=$1', [fixture.storeId]);
    await rows('UPDATE promotion SET enabled=false WHERE store_id=$1 AND code IS NULL', [fixture.storeId]);
    invalidateStoreCache(fixture.storeSlug);
    const product = await fixture.seedProduct(), cartId = randomUUID(), token = randomUUID(), customerId = randomUUID();
    const email = 'cart-customer-' + customerId + '@matrix.invalid';
    const legacyId = BigInt('0x' + randomBytes(8).toString('hex')).toString();
    const sku = String((await rows('SELECT sku FROM product_variant WHERE id=$1', [product.variantId]))[0]!.sku);
    await rows('UPDATE stock SET on_hand=20,allocated=0 WHERE variant_id=$1', [product.variantId]);
    await rows('UPDATE product_variant SET price=2500,sale_price=NULL,is_pre_order=false,pre_order_price=NULL,fulfillment_type=$3,enabled=true,deleted_at=NULL,metafields=$2::jsonb WHERE id=$1', [product.variantId, JSON.stringify({ vendureId: legacyId }), 'physical']);
    await rows('INSERT INTO customer(id,store_id,email,email_verified) VALUES($1,$2,$3,true)', [customerId, fixture.storeId, email]);
    const customerToken = await withStore(fixture.storeId, tx => createSession(tx, fixture.storeId, customerId));
    await rows('INSERT INTO cart(id,store_id,token,status,revision,expires_at) VALUES($1,$2,$3,$4,0,now()+$5::interval)',
      [cartId, fixture.storeId, token, 'active', '1 day']);
    await rows('INSERT INTO cart_line(store_id,cart_id,variant_id,sku,quantity) VALUES($1,$2,$3,$4,1)',
      [fixture.storeId, cartId, product.variantId, sku]);
    return { ...product, sku, cartId, token, customerId, email, legacyId, customerHeaders: {
      authorization: 'Bearer ' + customerToken, 'x-store-slug': fixture.storeSlug, 'content-type': 'application/json' } };
  }
  async function priced(body: Json, s: Seed, quantity: number, proof: MatrixProof) {
    proof.equal(body.currency, 'USD', 'seeded store currency');
    proof.equal(body.lines.map((line: Json) => ({ sku: line.sku, quantity: line.quantity, unitPrice: line.unitPrice,
      lineTotal: line.lineTotal, available: line.available, availableQuantity: line.availableQuantity })),
      [{ sku: s.sku, quantity, unitPrice: 2500, lineTotal: quantity * 2500, available: true, availableQuantity: 20 }],
      'server prices real in-stock variant');
    proof.equal({ subtotal: body.subtotal, discountTotal: body.discountTotal, shippingTotal: body.shippingTotal,
      taxTotal: body.taxTotal, grandTotal: body.grandTotal, unavailable: body.unavailable },
      { subtotal: quantity * 2500, discountTotal: 0, shippingTotal: 0, taxTotal: 0, grandTotal: quantity * 2500, unavailable: [] },
      'server authoritative undiscounted totals');
    proof.ok(typeof body.quoteHash === 'string' && /^[0-9a-f]{64}$/.test(body.quoteHash), 'server quote identity');
  }
  async function persisted(s: Seed, token: string, quantity: number, revision: number, email: string | null, customerId: string | null, proof: MatrixProof) {
    const cart = await rows('SELECT id,store_id,status,revision,email,customer_id,converted_order_id,expires_at FROM cart WHERE token=$1', [token]);
    proof.equal(cart.length, 1, 'one committed cart for opaque capability', 'state');
    const row = cart[0]!;
    proof.equal({ store_id: row.store_id, status: row.status, revision: row.revision, email: row.email,
      customer_id: row.customer_id, converted_order_id: row.converted_order_id },
      { store_id: fixture.storeId, status: 'active', revision, email, customer_id: customerId, converted_order_id: null },
      'cart lifecycle, ownership & revision committed', 'state');
    proof.ok(row.expires_at instanceof Date && row.expires_at.getTime() > Date.now(), 'committed cart has future expiry', 'state');
    proof.equal(await rows('SELECT variant_id,sku,quantity FROM cart_line WHERE cart_id=$1', [row.id]),
      [{ variant_id: s.variantId, sku: s.sku, quantity }], 'exact committed cart line', 'state');
    proof.equal(await rows('SELECT on_hand,allocated FROM stock WHERE variant_id=$1', [s.variantId]),
      [{ on_hand: 20, allocated: 0 }], 'cart operations reserve no stock', 'state');
    return row;
  }
  const specs: Spec[] = [
    { key: 'POST /v1/shop/cart', contract: 'public', async prepare(s) {
      const email = 'guest-' + randomUUID() + '@matrix.invalid';
      return { url: '/v1/shop/cart', body: { items: [{ sku: s.sku, quantity: 2 }], email }, async verify(response: Response, proof: MatrixProof) {
        const body = await json(response);
        proof.ok(typeof body.token === 'string' && body.token !== s.token, 'new independent opaque cart capability');
        proof.equal({ status: body.status, revision: body.revision, email: body.email, customerId: body.customerId },
          { status: 'active', revision: 1, email, customerId: null }, 'admin credentials create only guest cart');
        await priced(body, s, 2, proof);
        await persisted(s, body.token, 2, 1, email, null, proof);
      } };
    } },
    { key: 'GET /v1/shop/cart/{token}', contract: 'capability', async prepare(s) {
      const before = await rows('SELECT * FROM cart WHERE id=$1', [s.cartId]);
      return { url: '/v1/shop/cart/' + s.token, async verify(response: Response, proof: MatrixProof) {
        const body = await json(response);
        proof.equal({ token: body.token, status: body.status, revision: body.revision, customerId: body.customerId },
          { token: s.token, status: 'active', revision: 0, customerId: null }, 'supplied opaque capability identifies existing guest cart');
        await priced(body, s, 1, proof);
        proof.equal(await rows('SELECT * FROM cart WHERE id=$1', [s.cartId]), before, 'cart read preserves stored cart', 'state');
      } };
    } },
    { key: 'PATCH /v1/shop/cart/{token}', contract: 'capability', async prepare(s) {
      return { url: '/v1/shop/cart/' + s.token, body: { email: s.email, expectedRevision: 0 }, async verify(response: Response, proof: MatrixProof) {
        const body = await json(response);
        proof.equal({ token: body.token, email: body.email, customerId: body.customerId, revision: body.revision },
          { token: s.token, email: s.email, customerId: s.customerId, revision: 1 }, 'cart capability captures email & existing account link');
        await priced(body, s, 1, proof);
        await persisted(s, s.token, 1, 1, s.email, s.customerId, proof);
      } };
    } },
    { key: 'PATCH /v1/shop/cart/{token}/lines', contract: 'capability', async prepare(s) {
      return { url: '/v1/shop/cart/' + s.token + '/lines', body: { lines: [{ sku: s.sku, quantity: 3 }], expectedRevision: 0 }, async verify(response: Response, proof: MatrixProof) {
        const body = await json(response);
        proof.equal({ token: body.token, revision: body.revision, customerId: body.customerId },
          { token: s.token, revision: 1, customerId: null }, 'cart capability changes exact existing cart');
        await priced(body, s, 3, proof);
        await persisted(s, s.token, 3, 1, null, null, proof);
      } };
    } },
    { key: 'POST /v1/shop/cart/estimate', contract: 'public', async prepare(s) {
      const before = await fixture.snapshot();
      return { url: '/v1/shop/cart/estimate', body: { items: [{ sku: s.sku, quantity: 2 }] }, async verify(response: Response, proof: MatrixProof) {
        const body = await json(response);
        await priced(body, s, 2, proof);
        proof.ok(!('token' in body) && !('customerId' in body), 'stateless estimate grants no cart or customer credential');
        proof.equal(await fixture.snapshot(), before, 'estimate changes no DB/files/provider state', 'state');
      } };
    } },
    { key: 'POST /v1/shop/cart/legacy-migration', contract: 'public', async prepare(s) {
      const claimId = randomUUID();
      return { url: '/v1/shop/cart/legacy-migration', body: { claimId, items: [{ variantId: s.legacyId, quantity: 2 }], countryCode: 'US' }, async verify(response: Response, proof: MatrixProof) {
        const body = await json(response);
        proof.equal({ receipt: body.receipt, countryCode: body.countryCode, couponCode: body.couponCode, unresolved: body.unresolved },
          { receipt: claimId, countryCode: 'US', couponCode: null, unresolved: [] }, 'receipt binds fully resolved nonempty legacy cart');
        proof.ok(typeof body.cart?.token === 'string' && body.cart.token !== s.token, 'migration creates fresh cart capability');
        await priced(body.cart, s, 2, proof);
        const saved = await persisted(s, body.cart.token, 2, 1, null, null, proof);
        proof.equal(await rows('SELECT cart_id,grant_id,source_only,country_code,unresolved,retired_at FROM legacy_cart_claim WHERE claim_hash=$1', [hash(claimId)]),
          [{ cart_id: saved.id, grant_id: null, source_only: false, country_code: 'US', unresolved: [], retired_at: null }],
          'durable migration receipt committed without granting customer identity', 'state');
      } };
    } },
    { key: 'POST /v1/shop/cart/{token}/express-quote', contract: 'capability', async prepare(s) {
      const code = 'express-' + randomUUID();
      await rows('UPDATE shipping_method SET enabled=false WHERE store_id=$1', [fixture.storeId]);
      await rows('INSERT INTO shipping_method(store_id,code,name,calculator,enabled) VALUES($1,$2,$3,$4::jsonb,true)',
        [fixture.storeId, code, 'Matrix wallet shipping', JSON.stringify({ flat: 400, countries: ['US'], taxRate: 0, taxInclusive: false })]);
      const before = await fixture.snapshot();
      return { url: '/v1/shop/cart/' + s.token + '/express-quote', body: { country: 'US' }, async verify(response: Response, proof: MatrixProof) {
        const body = await json(response);
        proof.equal({ requiresShipping: body.requiresShipping, shippingMethodCode: body.shippingMethodCode, methods: body.methods },
          { requiresShipping: true, shippingMethodCode: code, methods: [{ code, name: 'Matrix wallet shipping', rate: 400 }] }, 'server-selected eligible wallet shipping');
        proof.equal({ token: body.cart.token, revision: body.cart.revision, shippingTotal: body.cart.shippingTotal, grandTotal: body.cart.grandTotal },
          { token: s.token, revision: 0, shippingTotal: 400, grandTotal: 2900 }, 'opaque capability quotes its own cart lines server-side');
        proof.ok(/^[0-9a-f]{64}$/.test(body.cart.quoteHash), 'server quote identity for checkout consent');
        proof.equal(await fixture.snapshot(), before, 'express quote changes no DB/files/provider state', 'state');
      } };
    } },
    { key: 'GET /v1/shop/cart/{token}/checkout', contract: 'capability', async prepare(s) {
      const orderId = randomUUID(), code = 'CART-RECOVERY-' + randomUUID(), receiptToken = randomBytes(32).toString('base64url');
      await rows('INSERT INTO "order"(id,store_id,code,state,currency,subtotal,grand_total,receipt_token) VALUES($1,$2,$3,$4,$5,2500,2500,$6)',
        [orderId, fixture.storeId, code, 'PendingPayment', 'USD', receiptToken]);
      await rows('UPDATE cart SET status=$2,converted_order_id=$3,revision=1 WHERE id=$1', [s.cartId, 'converted', orderId]);
      const before = await fixture.snapshot();
      return { url: '/v1/shop/cart/' + s.token + '/checkout', async verify(response: Response, proof: MatrixProof) {
        proof.equal(await json(response), { code, state: 'PendingPayment', grandTotal: 2500, discountTotal: 0,
          currency: 'USD', couponApplied: false, giftCardApplied: 0, replay: true, receiptToken, pointsRedeemed: 0, pointsDiscount: 0 },
          'correct opaque cart capability recovers exact existing checkout & receipt');
        proof.equal(response.headers.get('cache-control'), 'private, no-store', 'recovered receipt never publicly cached');
        proof.equal(await fixture.snapshot(), before, 'recovery creates no order or other state', 'state');
      } };
    } },
    { key: 'POST /v1/shop/cart/{token}/reopen', contract: 'capability', async prepare(s) {
      const orderId = randomUUID(), code = 'CART-REOPEN-' + randomUUID(), receiptToken = randomBytes(32).toString('base64url');
      await rows('INSERT INTO "order"(id,store_id,code,state,currency,subtotal,grand_total,receipt_token) VALUES($1,$2,$3,$4,$5,2500,2500,$6)',
        [orderId, fixture.storeId, code, 'PendingPayment', 'USD', receiptToken]);
      await rows('UPDATE cart SET status=$2,converted_order_id=$3,revision=1 WHERE id=$1', [s.cartId, 'converted', orderId]);
      return { url: '/v1/shop/cart/' + s.token + '/reopen', async verify(response: Response, proof: MatrixProof) {
        const body = await json(response);
        proof.equal({ token: body.token, status: body.status, revision: body.revision }, { token: s.token, status: 'active', revision: 2 },
          'correct opaque cart capability reopens its own converted cart (#370)');
        proof.equal(response.headers.get('cache-control'), 'private, no-store', 'reopened cart never publicly cached');
        proof.equal(await rows('SELECT state FROM "order" WHERE id=$1', [orderId]), [{ state: 'Cancelled' }], 'the unpaid order behind it is cancelled', 'state');
        proof.equal(await rows('SELECT status,converted_order_id,revision FROM cart WHERE id=$1', [s.cartId]),
          [{ status: 'active', converted_order_id: null, revision: 2 }], 'the same cart is active again', 'state');
        proof.equal(await rows('SELECT actor,action FROM audit_log WHERE entity_id=$1', [orderId]),
          [{ actor: 'shopper:cart-reopen', action: 'cancel' }], 'the cancel is audited to the shopper, not the admin principal', 'state');
      } };
    } },
    { key: 'POST /v1/shop/checkout', contract: 'public', async prepare(s) {
      // Digital goods avoid a shipping-provider dependency while exercising real cart-to-order conversion.
      await rows('UPDATE product_variant SET fulfillment_type=$2 WHERE id=$1', [s.variantId, 'digital_download']);
      const email = 'checkout-' + randomUUID() + '@matrix.invalid', idem = 'matrix-cart-' + randomUUID();
      return { url: '/v1/shop/checkout', headers: { 'idempotency-key': idem }, body: {
        items: [{ sku: s.sku, quantity: 1 }], email, cartToken: s.token, expectedRevision: 0,
      }, async verify(response: Response, proof: MatrixProof) {
        const body = await json(response);
        proof.equal({ state: body.state, grandTotal: body.grandTotal, discountTotal: body.discountTotal, currency: body.currency,
          couponApplied: body.couponApplied, giftCardApplied: body.giftCardApplied, pointsRedeemed: body.pointsRedeemed, pointsDiscount: body.pointsDiscount },
          { state: 'PendingPayment', grandTotal: 2500, discountTotal: 0, currency: 'USD', couponApplied: false, giftCardApplied: 0, pointsRedeemed: 0, pointsDiscount: 0 },
          'guest checkout creates real unpaid digital order without provider dependency');
        proof.ok(typeof body.code === 'string' && typeof body.receiptToken === 'string' && body.receiptToken.length >= 32, 'new order code & secret receipt capability');
        const order = await rows('SELECT id,customer_id,state,grand_total,subtotal,shipping_total,tax_total,receipt_token,idempotency_key,metadata FROM "order" WHERE code=$1', [body.code]);
        proof.equal(order.length, 1, 'exactly one new committed order', 'state');
        const saved = order[0]!;
        proof.equal({ customer_id: saved.customer_id, state: saved.state, grand_total: saved.grand_total, subtotal: saved.subtotal,
          shipping_total: saved.shipping_total, tax_total: saved.tax_total, receipt_token: saved.receipt_token, idempotency_key: saved.idempotency_key },
          { customer_id: null, state: 'PendingPayment', grand_total: 2500, subtotal: 2500, shipping_total: 0, tax_total: 0, receipt_token: body.receiptToken, idempotency_key: idem },
          'admin credentials confer no customer ownership or payment authority', 'state');
        proof.equal(saved.metadata.contact.email, email, 'guest contact stored from request', 'state');
        proof.equal(await rows('SELECT variant_id,variant_sku,quantity,unit_price,line_total FROM order_line WHERE order_id=$1', [saved.id]),
          [{ variant_id: s.variantId, variant_sku: s.sku, quantity: 1, unit_price: 2500, line_total: 2500 }], 'server-priced digital order line committed', 'state');
        proof.equal(await rows('SELECT status,converted_order_id,revision FROM cart WHERE id=$1', [s.cartId]),
          [{ status: 'converted', converted_order_id: saved.id, revision: 1 }], 'cart conversion committed with order', 'state');
        proof.equal(await rows('SELECT id FROM payment WHERE order_id=$1', [saved.id]), [], 'unpaid checkout creates no payment', 'state');
        proof.equal(await rows('SELECT on_hand,allocated FROM stock WHERE variant_id=$1', [s.variantId]),
          [{ on_hand: 20, allocated: 0 }], 'digital checkout reserves no physical inventory', 'state');
      } };
    } },
  ];
  async function merge(s: Seed): Promise<Prepared> {
    const donorId = randomUUID(), donorToken = randomUUID();
    await rows('INSERT INTO cart(id,store_id,token,customer_id,status,revision,expires_at) VALUES($1,$2,$3,$4,$5,0,now()+$6::interval)',
      [donorId, fixture.storeId, donorToken, s.customerId, 'active', '1 day']);
    await rows('INSERT INTO cart_line(store_id,cart_id,variant_id,sku,quantity) VALUES($1,$2,$3,$4,2)',
      [fixture.storeId, donorId, s.variantId, s.sku]);
    return { url: '/v1/shop/cart/' + s.token + '/merge?expectedRevision=0', async verify(response: Response, proof: MatrixProof) {
      const body = await json(response);
      proof.equal({ token: body.token, customerId: body.customerId, revision: body.revision },
        { token: s.token, customerId: s.customerId, revision: 1 }, 'genuine customer claims target guest cart');
      await priced(body, s, 3, proof);
      await persisted(s, s.token, 3, 1, null, s.customerId, proof);
      proof.equal(await rows('SELECT status,revision,customer_id FROM cart WHERE id=$1', [donorId]),
        [{ status: 'merged', revision: 1, customer_id: s.customerId }], 'owned donor retired exactly once', 'state');
      proof.equal(await rows('SELECT id FROM cart_line WHERE cart_id=$1', [donorId]), [], 'donor lines moved without duplication', 'state');
    } };
  }
  return { seed, rows, specs, merge };
}

export function createCartCases(fixture: Fixture): MatrixCase[] {
  const factory = source(fixture);
  const cases: MatrixCase[] = factory.specs.map(spec => {
    const method = spec.key.split(' ')[0]!;
    const cells = principalCells(principal => ({
      effect: 'allow', status: 200, async prepare() {
        const prepared = await spec.prepare(await factory.seed());
        return { url: prepared.url, init: { method,
          headers: { ...fixture.requestHeaders[principal], ...prepared.headers, 'content-type': 'application/json' },
          ...(prepared.body === undefined ? {} : { body: JSON.stringify(prepared.body) }) },
          env: peer(), verify: prepared.verify };
      },
    }));
    return { key: spec.key, contract: spec.contract, cells };
  });
  // Existing cart capability does not substitute for customer authentication on merge.
  cases.push({ key: 'POST /v1/shop/cart/{token}/merge', contract: 'customer',
    cells: principalCells(principal => ({
      effect: 'deny', status: 401, errorCode: 'AUTH_REQUIRED', async prepare() {
        const s = await factory.seed(), prepared = await factory.merge(s);
        return { url: prepared.url, init: { method: 'POST', headers: fixture.requestHeaders[principal] },
          env: peer(), snapshot: fixture.snapshot, async verify(response: Response, proof: MatrixProof) {
            const body = await json(response);
            proof.equal(Object.keys(body), ['error'], 'merge denial leaks no cart/customer data');
            proof.equal(body.error?.code, 'AUTH_REQUIRED', 'real cart capability alone grants no customer authentication');
            proof.equal(body.error?.message, 'authentication required to merge', 'explicit customer-credential requirement');
          } };
      },
    })) });
  return cases;
}

/** Supplement matrix: customer merge positive + identifier-without-capability controls for every principal. */
export function createCartControls(fixture: Fixture): CartControl[] {
  const factory = source(fixture);
  const controls: CartControl[] = [{ key: 'POST /v1/shop/cart/{token}/merge [genuine customer]', status: 200,
    async prepare() {
      const s = await factory.seed(), prepared = await factory.merge(s);
      return { url: prepared.url, init: { method: 'POST', headers: s.customerHeaders }, env: peer(), verify: prepared.verify };
    } }];
  for (const principal of PRINCIPALS) for (const kind of ['read', 'identity', 'lines', 'recovery'] as const) {
    controls.push({ key: kind + ' cart without opaque capability [' + principal + ']', status: 404, async prepare() {
      const s = await factory.seed();
      if (kind === 'recovery') await factory.specs.find(spec => spec.key === 'GET /v1/shop/cart/{token}/checkout')!.prepare(s);
      // Existing database identity is deliberately not the independent opaque cart token.
      const url = '/v1/shop/cart/' + s.cartId + (kind === 'lines' ? '/lines' : kind === 'recovery' ? '/checkout' : '');
      const method = kind === 'identity' || kind === 'lines' ? 'PATCH' : 'GET';
      const body = kind === 'identity' ? { email: s.email, expectedRevision: 0 }
        : kind === 'lines' ? { lines: [{ sku: s.sku, quantity: 2 }], expectedRevision: 0 } : undefined;
      const before = await fixture.snapshot();
      return { url, init: { method, headers: fixture.requestHeaders[principal], ...(body ? { body: JSON.stringify(body) } : {}) },
        env: peer(), async verify(response: Response, proof: MatrixProof) {
          const out = await json(response);
          proof.equal(Object.keys(out), ['error'], 'identifier without opaque capability exposes no cart/receipt');
          proof.equal(out.error?.code, kind === 'recovery' ? 'ORDER_NOT_FOUND' : 'CART_NOT_FOUND',
            'admin/service/cache credential cannot replace opaque capability');
          proof.equal(await fixture.snapshot(), before, 'missing cart capability changes no DB/files/provider state', 'state');
          proof.equal((await factory.rows('SELECT token FROM cart WHERE id=$1', [s.cartId]))[0]!.token, s.token,
            'genuine target still exists under distinct secret capability', 'state');
        } };
    } });
  }
  return controls;
}
