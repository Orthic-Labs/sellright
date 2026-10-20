/** B2.8 storefront public/customer/capability contracts. Test source only. */
import { randomBytes, randomUUID } from 'node:crypto';
import { withStore } from '../db/client.js';
import { createSession } from '../auth/session.js';
import { invalidateStoreCache } from '../store-context.js';
import type { createAuthorizationFixtures } from './authorization-matrix.fixtures.testkit.js';
import { PRINCIPALS, type MatrixCase, type MatrixCell, type MatrixPrincipal, type MatrixProof, type PreparedMatrixCell } from './authorization-matrix.testkit.js';

type Fixture = Awaited<ReturnType<typeof createAuthorizationFixtures>>;
type Json = Record<string, any>;
export interface StorefrontControl { key: string; status: number; prepare(): Promise<PreparedMatrixCell> }
type Seed = { productId: string; variantId: string; slug: string; sku: string; customerId: string; email: string;
  headers: Record<string, string>; orderId: string; orderCode: string; lineId: string };
type Prepared = { url: string; body?: unknown; verify(response: Response, proof: MatrixProof): Promise<void> };
type Spec = { key: string; contract: MatrixCase['contract']; status: number; prepare(seed: Seed): Promise<Prepared> };
const json = async (response: Response) => await response.json() as Json;
let peerSequence = 0;
// Actual in-process peer binding, never a forged proxy header.
const peer = () => ({ remoteAddr: '198.19.' + Math.floor(++peerSequence / 250) + '.' + ((peerSequence % 250) + 1) });
const reviewsConfig = { enabled: true, allowGuests: true, requirePurchase: true, autoApprove: false };
const sheeridConfig = { programId: 'matrix-local-program', theme: 'matrix', verifyBaseUrl: 'https://verify.matrix.invalid/verify' };

/** Read CSV independently of feed generation; quoted catalog text may contain commas & escaped quotes. */
function csv(text: string): string[][] {
  const rows: string[][] = [], row: string[] = [];
  let value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && (ch === ',' || ch === '\n')) {
      row.push(value.replace(/\r$/, '')); value = '';
      if (ch === '\n') { rows.push([...row]); row.length = 0; }
    } else value += ch;
  }
  if (value || row.length) { row.push(value.replace(/\r$/, '')); rows.push([...row]); }
  return rows;
}

function source(fixture: Fixture) {
  const rows = async (sql: string, values: unknown[] = []) => (await fixture.queryStore(fixture.storeId, sql, values)).rows;
  async function config(key: string, value: unknown) {
    // Disposable store only. Preserve all unrelated keys & invalidate its actual resolver cache.
    await rows('UPDATE store SET config=jsonb_set(coalesce(config,$3::jsonb),ARRAY[$1]::text[],coalesce(config->$1,$3::jsonb) || $2::jsonb,true) WHERE id=$4',
      [key, JSON.stringify(value), '{}', fixture.storeId]);
    invalidateStoreCache(fixture.storeSlug);
  }
  async function seed(): Promise<Seed> {
    const product = await fixture.seedProduct(), customerId = randomUUID(), orderId = randomUUID(), lineId = randomUUID();
    const email = 'storefront-' + customerId + '@matrix.invalid', orderCode = 'PUBLIC-' + randomUUID();
    const productRow = (await rows('SELECT p.slug,pv.sku FROM product p JOIN product_variant pv ON pv.product_id=p.id WHERE pv.id=$1', [product.variantId]))[0]!;
    await rows('INSERT INTO customer(id,store_id,email,email_verified,first_name,last_name) VALUES($1,$2,$3,true,$4,$5)',
      [customerId, fixture.storeId, email, 'Matrix', 'Shopper']);
    const token = await withStore(fixture.storeId, tx => createSession(tx, fixture.storeId, customerId));
    await rows('INSERT INTO "order"(id,store_id,code,customer_id,state,currency,subtotal,grand_total,placed_at,metadata) VALUES($1,$2,$3,$4,$5,$6,2500,2500,now(),$7::jsonb)',
      [orderId, fixture.storeId, orderCode, customerId, 'Paid', 'USD', JSON.stringify({ linked_via: 'session', contact: { email } })]);
    await rows('INSERT INTO order_line(id,store_id,order_id,variant_id,variant_sku,variant_name,quantity,unit_price,line_subtotal,line_total) VALUES($1,$2,$3,$4,$5,$6,1,2500,2500,2500)',
      [lineId, fixture.storeId, orderId, product.variantId, productRow.sku, 'Storefront proof item']);
    return { ...product, customerId, email, orderId, orderCode, lineId, slug: String(productRow.slug), sku: String(productRow.sku),
      headers: { authorization: 'Bearer ' + token, 'x-store-slug': fixture.storeSlug, 'content-type': 'application/json' } };
  }
  async function gift() {
    const id = randomUUID(), code = 'MATRIX-' + randomBytes(24).toString('hex');
    await rows('INSERT INTO gift_card(id,store_id,code,initial_balance,balance,currency,enabled,expires_at) VALUES($1,$2,$3,9000,6500,$4,true,now()+$5::interval)',
      [id, fixture.storeId, code, 'USD', '30 days']);
    return { id, code };
  }
  async function affiliate(s: Seed) {
    const id = randomUUID(), promotionId = randomUUID(), token = randomBytes(32).toString('hex'), code = 'AFF-' + randomUUID();
    await rows('INSERT INTO promotion(id,store_id,code,type,value,enabled) VALUES($1,$2,$3,$4,10,false)',
      [promotionId, fixture.storeId, code, 'percentage']);
    await rows('INSERT INTO affiliate(id,store_id,promotion_id,email,access_token) VALUES($1,$2,$3,$4,$5)',
      [id, fixture.storeId, promotionId, s.email, token]);
    await rows('UPDATE "order" SET promotion_id=$2,discount_total=500,grand_total=2000 WHERE id=$1', [s.orderId, promotionId]);
    await rows('INSERT INTO affiliate_settle(store_id,promotion_id,amount_cents,period_end_at,tx_ref) VALUES($1,$2,50,now(),$3)',
      [fixture.storeId, promotionId, 'matrix-paid']);
    return { id, promotionId, token, code };
  }
  async function restock(s: Seed) {
    const id = randomUUID(), token = randomUUID();
    await rows('INSERT INTO restock_request(id,store_id,variant_id,email,product_name,variant_name,product_slug,token,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, fixture.storeId, s.variantId, s.email, 'Matrix product', 'Matrix variant', s.slug, token, 'storefront']);
    return { id, token };
  }
  const reviewBody = (s: Seed) => ({ rating: 4, title: 'Verified purchase', body: 'This is a real paid purchase review.',
    name: 'Matrix Buyer', email: s.email, orderCode: s.orderCode });
  const specs: Spec[] = [
    { key: 'POST /v1/shop/catalog/products/{slug}/reviews', contract: 'capability', status: 201, async prepare(s) {
      await config('reviews', reviewsConfig);
      const body = reviewBody(s);
      return { url: '/v1/shop/catalog/products/' + s.slug + '/reviews', body, async verify(response: Response, proof: MatrixProof) {
        const result = await json(response);
        proof.equal({ status: result.status, verifiedBuyer: result.verifiedBuyer }, { status: 'pending', verifiedBuyer: true }, 'guest proves paid purchase');
        proof.ok(typeof result.id === 'string' && result.id !== '00000000-0000-0000-0000-000000000000', 'real review identity, no honeypot success');
        proof.equal(await rows('SELECT product_id,customer_id,order_id,author_email,author_name,rating,title,body,status,verified_buyer,bonus_points FROM product_review WHERE id=$1', [result.id]),
          [{ product_id: s.productId, customer_id: null, order_id: s.orderId, author_email: s.email, author_name: body.name,
            rating: 4, title: body.title, body: body.body, status: 'pending', verified_buyer: true, bonus_points: 0 }],
          'real pending guest review commits purchase provenance without admin identity', 'state');
        proof.equal(await rows('SELECT id FROM loyalty_ledger WHERE customer_id=$1', [s.customerId]), [], 'submission awards no approval bonus', 'state');
      } };
    } },
    { key: 'GET /v1/shop/gift-card/{code}', contract: 'capability', status: 200, async prepare() {
      const g = await gift(), before = await fixture.snapshot();
      return { url: '/v1/shop/gift-card/' + g.code, async verify(response: Response, proof: MatrixProof) {
        proof.equal(await json(response), { code: g.code, balance: 6500, currency: 'USD', valid: true }, 'opaque gift code exposes exact live balance');
        proof.equal(await fixture.snapshot(), before, 'gift lookup leaves all state unchanged', 'state');
      } };
    } },
    { key: 'GET /v1/shop/affiliate', contract: 'capability', status: 200, async prepare(s) {
      const a = await affiliate(s), before = await fixture.snapshot();
      return { url: '/v1/shop/affiliate?t=' + a.token, async verify(response: Response, proof: MatrixProof) {
        const body = await json(response);
        proof.equal({ success: body.success, email: body.email, couponCode: body.couponCode, rate: body.rate, currency: body.currency,
          totals: body.totals, topProducts: body.topProducts },
          { success: true, email: s.email, couponCode: a.code, rate: 0.1, currency: 'USD',
            totals: { earnedUsd: 2, paidUsd: 0.5, owedUsd: 1.5, orderCount: 1, rangeStart: null, rangeEnd: null }, topProducts: [] },
          'opaque affiliate capability selects exact paid-order commission & settlement');
        proof.equal(body.orders.length, 1, 'one attributed order');
        proof.equal({ redactedCode: body.orders[0].redactedCode, itemCount: body.orders[0].itemCount, subtotalUsd: body.orders[0].subtotalUsd,
          commissionUsd: body.orders[0].commissionUsd, state: body.orders[0].state },
          { redactedCode: s.orderCode.slice(-4), itemCount: 1, subtotalUsd: 20, commissionUsd: 2, state: 'Paid' }, 'affiliate order code is redacted');
        proof.equal(body.settles.map((r: Json) => ({ amountUsd: r.amountUsd, txRef: r.txRef, periodStartAt: r.periodStartAt })),
          [{ amountUsd: 0.5, txRef: 'matrix-paid', periodStartAt: null }], 'actual settlement returned');
        proof.equal(await fixture.snapshot(), before, 'affiliate read changes no state', 'state');
      } };
    } },
    { key: 'POST /v1/shop/shipping-methods', contract: 'public', status: 200, async prepare(s) {
      const code = 'shipping-' + randomUUID(), name = 'Matrix live shipping', disabled = code + '-disabled';
      await rows('UPDATE stock SET on_hand=20,allocated=0 WHERE variant_id=$1', [s.variantId]);
      const calculator = JSON.stringify({ flat: 350, countries: ['US'], min: 2000, max: 3000, taxRate: 0, taxInclusive: false });
      await rows('INSERT INTO shipping_method(store_id,code,name,calculator,enabled) VALUES($1,$2,$3,$4::jsonb,true),($1,$5,$3,$4::jsonb,false)',
        [fixture.storeId, code, name, calculator, disabled]);
      const before = await fixture.snapshot();
      return { url: '/v1/shop/shipping-methods', body: { country: 'US', items: [{ sku: s.sku, quantity: 1 }] }, async verify(response: Response, proof: MatrixProof) {
        const body = await json(response);
        proof.equal(body.methods.filter((r: Json) => r.code === code), [{ code, name, rate: 350, price: 350 }], 'eligible real-stock quote uses seeded shipping rate');
        proof.equal(body.methods.filter((r: Json) => r.code === disabled), [], 'disabled shipping method is excluded');
        proof.equal(await fixture.snapshot(), before, 'shipping quote changes no domain/outbox/provider state', 'state');
      } };
    } },
    { key: 'GET /v1/shop/feeds/{channel}', contract: 'public', status: 200, async prepare(s) {
      await rows('UPDATE stock SET on_hand=12,allocated=2 WHERE variant_id=$1', [s.variantId]);
      const before = await fixture.snapshot();
      return { url: '/v1/shop/feeds/google.csv', async verify(response: Response, proof: MatrixProof) {
        proof.ok(response.headers.get('content-type')?.startsWith('text/csv'), 'merchant CSV content type');
        proof.equal(response.headers.get('cache-control'), 'private, no-store', 'live inventory is never cached');
        const data = csv(await response.text()), header = data.shift()!;
        const matches = data.filter(r => r[header.indexOf('id')] === s.sku);
        proof.equal(matches.length, 1, 'one live feed row for seeded variant');
        const row = matches[0]!, get = (key: string) => row[header.indexOf(key)];
        proof.equal({ id: get('id'), price: get('price'), availability: get('availability'), condition: get('condition'), item_group_id: get('item_group_id') },
          { id: s.sku, price: '25.00 USD', availability: 'in stock', condition: 'new', item_group_id: s.productId }, 'public feed prices real available product');
        proof.ok(get('link')?.includes('/products/' + s.slug), 'feed points at seeded public product');
        proof.equal(await fixture.snapshot(), before, 'merchant feed changes no state', 'state');
      } };
    } },
    { key: 'GET /v1/shop/track', contract: 'capability', status: 200, async prepare(s) {
      const before = await fixture.snapshot();
      return { url: '/v1/shop/track?' + new URLSearchParams({ code: s.orderCode, email: s.email }), async verify(response: Response, proof: MatrixProof) {
        const body = await json(response);
        proof.equal({ code: body.code, state: body.state, currency: body.currency, subtotal: body.subtotal, shippingTotal: body.shippingTotal,
          taxTotal: body.taxTotal, discountTotal: body.discountTotal, grandTotal: body.grandTotal },
          { code: s.orderCode, state: 'Paid', currency: 'USD', subtotal: 2500, shippingTotal: 0, taxTotal: 0, discountTotal: 0, grandTotal: 2500 },
          'order code plus mailbox proof selects existing paid order');
        proof.equal(body.lines.map((r: Json) => ({ sku: r.sku, name: r.name, quantity: r.quantity, unitPrice: r.unitPrice, lineTotal: r.lineTotal })),
          [{ sku: s.sku, name: 'Storefront proof item', quantity: 1, unitPrice: 2500, lineTotal: 2500 }], 'tracking exposes exact existing order line');
        proof.equal({ payments: body.payments, fulfillments: body.fulfillments }, { payments: [], fulfillments: [] }, 'tracking reflects actual provider-free order facts');
        proof.equal(await fixture.snapshot(), before, 'tracking changes no domain state', 'state');
      } };
    } },
    { key: 'POST /v1/shop/restock-request', contract: 'public', status: 200, async prepare(s) {
      // seedProduct has stock=0: a genuine signup must insert, never the in-stock/honeypot no-op.
      await rows('UPDATE stock SET on_hand=0,allocated=0 WHERE variant_id=$1', [s.variantId]);
      return { url: '/v1/shop/restock-request', body: { variantId: s.variantId, email: s.email }, async verify(response: Response, proof: MatrixProof) {
        proof.equal(await json(response), { ok: true }, 'real restock signup accepted');
        const committed = await rows('SELECT variant_id,email,product_slug,status,source,token,notified_at FROM restock_request WHERE variant_id=$1 AND email=$2', [s.variantId, s.email]);
        proof.equal(committed.length, 1, 'one actual restock request committed', 'state');
        const row = committed[0]!;
        proof.equal({ variant_id: row.variant_id, email: row.email, product_slug: row.product_slug, status: row.status, source: row.source, notified_at: row.notified_at },
          { variant_id: s.variantId, email: s.email, product_slug: s.slug, status: 'pending', source: 'storefront', notified_at: null }, 'restock consent commits exact product & mailbox', 'state');
        proof.ok(typeof row.token === 'string' && row.token !== s.variantId, 'independent opaque cancellation capability committed', 'state');
      } };
    } },
    { key: 'GET /v1/shop/restock-request/cancel/{token}', contract: 'public', status: 200, async prepare(s) {
      const r = await restock(s), before = await fixture.snapshot();
      return { url: '/v1/shop/restock-request/cancel/' + r.token, async verify(response: Response, proof: MatrixProof) {
        const body = await response.text();
        proof.ok(response.headers.get('content-type')?.startsWith('text/html'), 'cancel landing is HTML');
        proof.ok(body.includes('Cancel stock notification') && body.includes('<form method="post" action="">') && body.includes('Cancel notification'), 'landing offers explicit POST consent revocation');
        proof.equal(await fixture.snapshot(), before, 'mail scanner GET never cancels or changes state', 'state');
      } };
    } },
    { key: 'POST /v1/shop/restock-request/cancel/{token}', contract: 'capability', status: 200, async prepare(s) {
      const r = await restock(s), before = (await rows('SELECT * FROM restock_request WHERE id=$1', [r.id]))[0]!;
      return { url: '/v1/shop/restock-request/cancel/' + r.token, async verify(response: Response, proof: MatrixProof) {
        proof.ok((await response.text()).includes('Your notification request has been canceled.'), 'generic cancellation confirmation');
        const after = (await rows('SELECT * FROM restock_request WHERE id=$1', [r.id]))[0]!;
        proof.equal({ ...after, updated_at: before.updated_at }, { ...before, status: 'canceled' }, 'only targeted consent status & timestamp change', 'state');
        proof.ok(after.updated_at instanceof Date && after.updated_at.getTime() >= before.updated_at.getTime(), 'cancellation timestamp committed', 'state');
      } };
    } },
  ];
  return { rows, config, seed, gift, affiliate, restock, reviewBody, specs };
}

/** Requires harness's explicit TURNSTILE_DISABLED=true with no store secret; no verification stub or provider call. */
export function createStorefrontCases(fixture: Fixture): MatrixCase[] {
  const src = source(fixture);
  const cases = src.specs.map(spec => {
    const cells = {} as Record<MatrixPrincipal, MatrixCell>;
    for (const principal of PRINCIPALS) cells[principal] = { effect: 'allow', status: spec.status, async prepare() {
      const prepared = await spec.prepare(await src.seed());
      return { url: prepared.url, env: peer(), init: { method: spec.key.split(' ')[0], headers: fixture.requestHeaders[principal],
        ...(prepared.body === undefined ? {} : { body: JSON.stringify(prepared.body) }) }, verify: prepared.verify };
    } };
    return { key: spec.key, contract: spec.contract, cells };
  });
  const cells = {} as Record<MatrixPrincipal, MatrixCell>;
  for (const principal of PRINCIPALS) cells[principal] = { effect: 'deny', status: 401, errorCode: 'NOT_AUTHENTICATED', async prepare() {
    await src.config('sheerid', sheeridConfig);
    const s = await src.seed(), before = await fixture.snapshot();
    return { url: '/v1/shop/sheerid/start', env: peer(), init: { method: 'POST', headers: fixture.requestHeaders[principal], body: JSON.stringify({ programId: sheeridConfig.programId }) },
      snapshot: fixture.snapshot, async verify(response: Response, proof: MatrixProof) {
        const body = await json(response);
        proof.equal(Object.keys(body), ['error'], 'no customer verification URL or data');
        proof.equal(body.error.code, 'NOT_AUTHENTICATED', 'configured SheerID requires actual customer credential');
        proof.equal(body.error.message, 'not authenticated', 'customer authentication guard reached after valid config');
        proof.equal(await src.rows('SELECT id FROM sheerid_verification WHERE customer_id=$1', [s.customerId]), [], 'no verification created', 'state');
        proof.equal(await fixture.snapshot(), before, 'customer denial changes no complete state', 'state');
      } };
  } };
  cases.push({ key: 'POST /v1/shop/sheerid/start', contract: 'customer', cells });
  return cases;
}

/** Additional missing-capability proofs use existing resource IDs or known order codes, never missing-object fixtures. */
export function createStorefrontControls(fixture: Fixture): StorefrontControl[] {
  const src = source(fixture), controls: StorefrontControl[] = [];
  for (const principal of PRINCIPALS) for (const kind of ['gift', 'affiliate', 'track', 'review', 'cancel'] as const) {
    controls.push({ key: 'storefront-missing-' + kind + '-capability [' + principal + ']', status: kind === 'cancel' ? 200 : kind === 'review' ? 403 : 404, async prepare() {
      const s = await src.seed();
      let url: string, method = 'GET', body: unknown, errorCode: string | undefined;
      if (kind === 'gift') { const g = await src.gift(); url = '/v1/shop/gift-card/' + g.id; errorCode = 'GIFT_CARD_NOT_FOUND'; }
      else if (kind === 'affiliate') { const a = await src.affiliate(s); url = '/v1/shop/affiliate?t=' + a.id; errorCode = 'INVALID_AFFILIATE_LINK'; }
      else if (kind === 'track') { url = '/v1/shop/track?' + new URLSearchParams({ code: s.orderCode, email: 'different-' + randomUUID() + '@matrix.invalid' }); errorCode = 'ORDER_NOT_FOUND'; }
      else if (kind === 'review') {
        await src.config('reviews', reviewsConfig);
        url = '/v1/shop/catalog/products/' + s.slug + '/reviews'; method = 'POST';
        body = { ...src.reviewBody(s), email: 'different-' + randomUUID() + '@matrix.invalid' }; errorCode = 'PURCHASE_REQUIRED';
      } else { const r = await src.restock(s); url = '/v1/shop/restock-request/cancel/' + r.id; method = 'POST'; }
      const before = await fixture.snapshot();
      return { url, env: peer(), init: { method, headers: fixture.requestHeaders[principal], ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, async verify(response: Response, proof: MatrixProof) {
        if (kind === 'cancel') proof.ok((await response.text()).includes('Your notification request has been canceled.'), 'non-enumerating cancel response when capability absent');
        else {
          const result = await json(response);
          proof.equal(Object.keys(result), ['error'], 'no customer data without required public capability');
          proof.equal(result.error.code, errorCode, 'admin credential cannot substitute for opaque capability or mailbox proof');
        }
        proof.equal(await fixture.snapshot(), before, 'missing capability leaves complete existing-resource state unchanged', 'state');
      } };
    } });
  }
  controls.push({ key: 'genuine-customer-sheerid-start', status: 200, async prepare() {
    await src.config('sheerid', sheeridConfig);
    const s = await src.seed(), before = await src.rows('SELECT id FROM sheerid_verification WHERE customer_id=$1', [s.customerId]);
    return { url: '/v1/shop/sheerid/start', env: peer(), init: { method: 'POST', headers: s.headers, body: JSON.stringify({ programId: sheeridConfig.programId }) }, async verify(response: Response, proof: MatrixProof) {
      const result = await json(response), expected = new URL(sheeridConfig.verifyBaseUrl + '/' + sheeridConfig.programId + '/');
      expected.searchParams.set('metadata', JSON.stringify({ customerId: s.customerId })); expected.searchParams.set('theme', sheeridConfig.theme);
      proof.equal(result.verificationUrl, expected.toString(), 'local hosted URL binds genuine customer & configured program');
      proof.ok(typeof result.verificationId === 'string' && !before.some(r => r.id === result.verificationId), 'new verification identity');
      proof.equal(await src.rows('SELECT customer_id,program_id,status,verification_id,category,discount_percent,expires_at,details FROM sheerid_verification WHERE id=$1', [result.verificationId]),
        [{ customer_id: s.customerId, program_id: sheeridConfig.programId, status: 'pending', verification_id: null, category: null, discount_percent: null, expires_at: null, details: null }],
        'genuine customer creates only untrusted pending verification', 'state');
      proof.equal((await src.rows('SELECT active_verifications FROM customer WHERE id=$1', [s.customerId]))[0]!.active_verifications, null, 'starting verification grants no trusted category', 'state');
    } };
  } });
  return controls;
}
