/** B2.8 shopper payment boundaries & failed edit-refund recovery. Synthetic source only. */
import { createHash, randomUUID } from 'node:crypto';
import { withStore } from '../db/client.js';
import { createSession } from '../auth/session.js';
import { invalidateStoreCache } from '../store-context.js';
import { encryptSecret } from '../security/secret-crypto.js';
import type { createAuthorizationFixtures } from './authorization-matrix.fixtures.testkit.js';
import { MATRIX_PROVIDER as P, type AuthorizationTransport, type MatrixTransportCall } from './authorization-matrix.transport.testkit.js';
import type { MatrixCase, MatrixCell, MatrixPrincipal, MatrixProof, PreparedMatrixCell } from './authorization-matrix.testkit.js';

type Fixture = Awaited<ReturnType<typeof createAuthorizationFixtures>>;
type Json = Record<string, any>;
type Seed = { orderId: string; code: string; variantId: string; sku: string; lineId: string; customerId: string; email: string;
  customerHeaders: Record<string, string>; receipt: string; intentId: string; attemptId: string; paymentId: string; idempotencyKey: string };
type Spec = { key: string; suffix: string; method: 'GET' | 'POST'; message: string; kind: 'summary' | 'pay' | 'mint' | 'refresh' | 'gateway' | 'verify' };
export interface PaymentControl { key: string; status: number; prepare(): Promise<PreparedMatrixCell> }
let peerSequence = 0;
const peer = () => ({ remoteAddr: '198.19.' + Math.floor(++peerSequence / 250) + '.' + ((peerSequence % 250) + 1) });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const json = (response: Response) => response.json() as Promise<Json>;
const shopPath = (s: Seed) => '/v1/shop/orders/' + s.code;

function paymentSource(fixture: Fixture, transport: AuthorizationTransport) {
  const rows = async (sql: string, values: unknown[] = []) => (await fixture.queryStore(fixture.storeId, sql, values)).rows;
  const one = async (sql: string, values: unknown[] = []) => {
    const result = await rows(sql, values);
    if (result.length !== 1) throw new Error('payment matrix expected exactly one fixture row: ' + sql);
    return result[0]!;
  };
  async function secret(provider: string, field: string, plaintext: string) {
    const sealed = encryptSecret(plaintext, { purpose: `store:${fixture.storeId}:${provider}:test:${field}` });
    await rows(`INSERT INTO store_secret(store_id,provider,mode,field,key_version,iv,ciphertext,auth_tag,last4,updated_by)
      VALUES($1,$2,'test',$3,$4,$5,$6,$7,$8,'matrix-payment-fixture') ON CONFLICT(store_id,provider,mode,field)
      DO UPDATE SET key_version=excluded.key_version,iv=excluded.iv,ciphertext=excluded.ciphertext,auth_tag=excluded.auth_tag,last4=excluded.last4,updated_by=excluded.updated_by`,
      [fixture.storeId, provider, field, sealed.v, sealed.iv, sealed.ct, sealed.tag, plaintext.slice(-4)]);
  }
  async function configure() {
    const current = (await one('SELECT config FROM store WHERE id=$1', [fixture.storeId])).config as Json;
    await rows('UPDATE store SET config=$2::jsonb WHERE id=$1', [fixture.storeId, JSON.stringify({ ...current,
      stripe: { ...(current.stripe ?? {}), mode: 'test' }, payments: { ...(current.payments ?? {}), stripe: { enabled: true, mode: 'test' }, nmi: { enabled: true, mode: 'test' } } })]);
    await secret('stripe', 'secretKey', P.stripeSecret);
    await secret('stripe', 'publishableKey', P.stripePublishable);
    await secret('nmi', 'securityKey', 'matrix-nmi-synthetic-security-key');
    invalidateStoreCache(fixture.storeSlug);
  }
  async function customer() {
    const customerId = randomUUID(), email = 'payment-' + customerId + '@matrix.invalid';
    await rows("INSERT INTO customer(id,store_id,email,first_name,last_name,email_verified) VALUES($1,$2,$3,'Payment','Customer',true)", [customerId, fixture.storeId, email]);
    const token = await withStore(fixture.storeId, tx => createSession(tx, fixture.storeId, customerId));
    return { customerId, email, customerHeaders: { authorization: 'Bearer ' + token, 'x-store-slug': fixture.storeSlug, 'content-type': 'application/json' } };
  }
  async function order(kind: Spec['kind'] | 'refund'): Promise<Seed> {
    await configure();
    const c = await customer(), { variantId } = await fixture.seedProduct();
    const sku = String((await one('SELECT sku FROM product_variant WHERE id=$1', [variantId])).sku);
    const orderId = randomUUID(), code = 'PAYMENT-' + randomUUID(), lineId = randomUUID(), receipt = randomUUID();
    const attemptId = randomUUID(), paymentId = randomUUID(), idempotencyKey = 'matrix-payment-' + randomUUID();
    const intentId = 'pi_matrix_' + randomUUID().replaceAll('-', '');
    const paid = kind === 'gateway' || kind === 'verify' || kind === 'refund';
    await rows('UPDATE stock SET on_hand=10,allocated=1 WHERE variant_id=$1', [variantId]);
    await rows(`INSERT INTO "order"(id,store_id,code,customer_id,receipt_token,state,currency,subtotal,grand_total)
      VALUES($1,$2,$3,$4,$5,$6,'USD',2500,2500)`, [orderId, fixture.storeId, code, c.customerId, receipt, paid ? 'Paid' : 'PendingPayment']);
    await rows(`INSERT INTO order_line(id,store_id,order_id,variant_id,variant_sku,variant_name,quantity,unit_price,line_subtotal,line_total)
      VALUES($1,$2,$3,$4,$5,'Matrix variant',1,2500,2500,2500)`, [lineId, fixture.storeId, orderId, variantId, sku]);
    if (paid) await rows(`INSERT INTO payment(id,store_id,order_id,amount,method,state,currency,provider_ref,gateway_account,gateway_mode)
      VALUES($1,$2,$3,$4,$5,'Settled','USD',$6,$7,$8)`, [paymentId, fixture.storeId, orderId, kind === 'refund' ? 5000 : 2500,
      kind === 'refund' ? 'manual' : 'nmi', 'matrix-payment-' + paymentId, kind === 'refund' ? null : 'db', kind === 'refund' ? null : 'test']);
    if (kind === 'gateway' || kind === 'verify') await rows(`INSERT INTO payment_attempt(id,store_id,order_id,payment_id,operation,method,account_id,mode,amount,currency,idempotency_key,fingerprint,status,provider_ref,context,result)
      VALUES($1,$2,$3,$4,'charge','nmi','db','test',2500,'USD',$5,$6,'settled',$7,$8::jsonb,$9::jsonb)`,
      [attemptId, fixture.storeId, orderId, paymentId, idempotencyKey, digest(idempotencyKey), 'matrix-payment-' + paymentId,
        JSON.stringify({ accountId: 'db', storeId: fixture.storeId, method: 'nmi', mode: 'test', nmiEnvironment: 'sandbox' }), JSON.stringify({ state: 'Paid', payment: 'Settled' })]);
    if (kind === 'refresh') await rows(`INSERT INTO payment_attempt(id,store_id,order_id,operation,method,account_id,mode,amount,currency,idempotency_key,fingerprint,status,provider_ref,context)
      VALUES($1,$2,$3,'intent','stripe','stripe','test',2500,'USD',$4,$5,'open',$6,'{}')`,
      [attemptId, fixture.storeId, orderId, idempotencyKey, digest(idempotencyKey), intentId]);
    if (kind === 'pay' || kind === 'refresh') transport.registerPaymentIntent({ id: intentId, amount: 2500, currency: 'usd',
      metadata: { orderCode: code, storeId: fixture.storeId }, status: kind === 'pay' ? 'succeeded' : 'requires_payment_method', client_secret: intentId + '_secret_synthetic' });
    return { ...c, orderId, code, variantId, sku, lineId, receipt, intentId, attemptId, paymentId, idempotencyKey };
  }
  const ledger = async (s: Seed) => ({ order: await one('SELECT code,customer_id,state,grand_total FROM "order" WHERE id=$1', [s.orderId]),
    lines: await rows('SELECT id,variant_id,quantity,unit_price,line_total FROM order_line WHERE order_id=$1 ORDER BY id', [s.orderId]),
    payments: await rows('SELECT id,amount,method,state,provider_ref FROM payment WHERE order_id=$1 ORDER BY id', [s.orderId]),
    attempts: await rows('SELECT id,payment_id,operation,method,status,provider_ref,result FROM payment_attempt WHERE order_id=$1 ORDER BY id', [s.orderId]) });
  const calls = (start: number) => transport.calls.slice(start) as MatrixTransportCall[];
  function stripeCall(call: MatrixTransportCall | undefined, method: string, path: string, proof: MatrixProof) {
    proof.equal(call && { kind: call.kind, method: call.method, path: new URL(call.url).pathname }, { kind: 'stripe', method, path }, 'exact synthetic Stripe operation', 'state');
    proof.equal(call?.headers?.authorization, 'Bearer ' + P.stripeSecret, 'synthetic store Stripe credential used', 'state');
  }
  return { rows, one, configure, customer, order, ledger, calls, stripeCall };
}

const specs: Spec[] = [
  { key: 'GET /v1/shop/orders/{code}', method: 'GET', suffix: '', message: 'order not found', kind: 'summary' },
  { key: 'POST /v1/shop/orders/{code}/pay', method: 'POST', suffix: '/pay', message: 'order not found', kind: 'pay' },
  { key: 'POST /v1/shop/orders/{code}/payment-intent', method: 'POST', suffix: '/payment-intent', message: 'order not found', kind: 'mint' },
  { key: 'POST /v1/shop/orders/{code}/payment/refresh', method: 'POST', suffix: '/payment/refresh', message: 'order not found', kind: 'refresh' },
  { key: 'POST /v1/shop/orders/{code}/gateway-payment', method: 'POST', suffix: '/gateway-payment', message: 'Order not found', kind: 'gateway' },
  { key: 'POST /v1/shop/orders/{code}/gateway-payment/{attempt}/verify', method: 'POST', suffix: '/gateway-payment/{attempt}/verify', message: 'Order not found', kind: 'verify' },
];

/** Every admin credential lacks shopper ownership; each named concealment has its receipt control. */
export function createPaymentCases(fixture: Fixture, transport: AuthorizationTransport): MatrixCase[] {
  const source = paymentSource(fixture, transport), { rows, one, ledger, calls, stripeCall } = source;
  const cases: MatrixCase[] = specs.map(spec => {
    // One real existing target is deliberately shared across denial rows & control to prove concealment.
    let target: Promise<Seed> | undefined;
    const seed = () => target ??= source.order(spec.kind);
    const urlFor = (s: Seed) => shopPath(s) + spec.suffix.replace('{attempt}', s.attemptId);
    const bodyFor = (s: Seed) => spec.kind === 'pay' ? { method: 'stripe', token: { paymentIntentId: s.intentId } }
      : spec.kind === 'gateway' ? { method: 'nmi', token: 'synthetic-single-use-payment-token' } : undefined;
    const headersFor = (s: Seed, headers: Record<string, string>) => ({ ...headers, 'content-type': 'application/json', 'idempotency-key': s.idempotencyKey });
    const cell = (principal: MatrixPrincipal): MatrixCell => ({ effect: 'deny', status: 404, errorCode: 'ORDER_NOT_FOUND', concealment: true,
      async prepare() {
        const s = await seed(), url = urlFor(s), body = bodyFor(s);
        return { url, init: { method: spec.method, headers: headersFor(s, fixture.requestHeaders[principal]), ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
          env: peer(), snapshot: fixture.snapshotFor(principal, spec.method, url, 404), async verify(response: Response, proof: MatrixProof) {
            const body = await json(response);
            proof.equal(body.error?.code, 'ORDER_NOT_FOUND', 'existing order concealed without customer capability');
            proof.equal(body.error?.message, spec.message, 'exact shopper ownership denial');
          } };
      } });
    return { key: spec.key, contract: 'capability', ...(spec.kind === 'summary' ? { concealmentQueryCredential: 'rt' as const } : {}),
      cells: { owner: cell('owner'), manager: cell('manager'), staff: cell('staff'), read_only: cell('read_only'), agent: cell('agent'),
        foreign_store: cell('foreign_store'), release_service: cell('release_service'), cache_token: cell('cache_token') },
      async concealmentControl() {
        const s = await seed(), body = bodyFor(s), before = await ledger(s), start = transport.calls.length;
        const url = urlFor(s) + (spec.kind === 'summary' ? '?rt=' + encodeURIComponent(s.receipt) : '');
        return { url, init: { method: spec.method, headers: headersFor(s, { 'x-store-slug': fixture.storeSlug,
          ...(spec.kind === 'summary' ? {} : { 'x-receipt-token': s.receipt }) }), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env: peer(),
          async verify(response: Response, proof: MatrixProof) {
            const body = await json(response);
            if (spec.kind === 'summary') {
              proof.equal({ code: body.code, state: body.state, currency: body.currency, subtotal: body.subtotal, grandTotal: body.grandTotal,
                amountDue: body.amountDue, payments: body.payments, fulfillments: body.fulfillments },
              { code: s.code, state: 'PendingPayment', currency: 'USD', subtotal: 2500, grandTotal: 2500, amountDue: 0, payments: [], fulfillments: [] }, 'receipt reveals only existing order summary');
              proof.equal(body.lines.map((line: Json) => ({ sku: line.sku, quantity: line.quantity, unitPrice: line.unitPrice, lineTotal: line.lineTotal })),
                [{ sku: s.sku, quantity: 1, unitPrice: 2500, lineTotal: 2500 }], 'receipt order line snapshot');
              proof.equal(await ledger(s), before, 'receipt read preserves order ledger', 'state');
              proof.equal(calls(start), [], 'untracked summary performs no provider I/O', 'state');
            } else if (spec.kind === 'pay') {
              proof.equal(body, { code: s.code, state: 'Paid', payment: 'Settled' }, 'receipt-backed payment settles');
              proof.equal(await one('SELECT customer_id,state,grand_total FROM "order" WHERE id=$1', [s.orderId]),
                { customer_id: s.customerId, state: 'Paid', grand_total: 2500 }, 'payment commits to receipt order', 'state');
              proof.equal(await rows('SELECT amount,method,state,currency,provider_ref,gateway_mode FROM payment WHERE order_id=$1', [s.orderId]),
                [{ amount: 2500, method: 'stripe', state: 'Settled', currency: 'USD', provider_ref: s.intentId, gateway_mode: 'test' }], 'exact provider tender committed once', 'state');
              proof.equal(await rows('SELECT id,type FROM processed_event WHERE id=$1', [`pay:${fixture.storeId}:${s.code}:stripe:${s.idempotencyKey}`]),
                [{ id: `pay:${fixture.storeId}:${s.code}:stripe:${s.idempotencyKey}`, type: 'payment' }], 'payment claim committed', 'state');
              proof.equal(calls(start).length, 1, 'one Stripe verification', 'state'); stripeCall(calls(start)[0], 'GET', '/v1/payment_intents/' + s.intentId, proof);
            } else if (spec.kind === 'mint') {
              const captured = calls(start); proof.equal(captured.length, 1, 'one provider intent mint', 'state');
              stripeCall(captured[0], 'POST', '/v1/payment_intents', proof);
              const provider = captured[0]!.response as Json, form = new URLSearchParams(captured[0]!.body);
              proof.equal(body, { intentId: provider.id, clientSecret: provider.client_secret }, 'client secret belongs to exact minted provider intent');
              proof.equal({ amount: form.get('amount'), currency: form.get('currency'), order: form.get('metadata[orderCode]'), store: form.get('metadata[storeId]'), automatic: form.get('automatic_payment_methods[enabled]') },
                { amount: '2500', currency: 'usd', order: s.code, store: fixture.storeId, automatic: 'true' }, 'mint derives price & identity from receipt order', 'state');
              proof.ok(Boolean(form.get('metadata[mintKey]')), 'provider mint carries durable idempotency binding', 'state');
              proof.equal(await rows('SELECT operation,method,account_id,mode,amount,currency,status,provider_ref FROM payment_attempt WHERE order_id=$1', [s.orderId]),
                [{ operation: 'intent', method: 'stripe', account_id: 'stripe', mode: 'test', amount: 2500, currency: 'USD', status: 'open', provider_ref: provider.id }], 'durable pre-mint attempt bound to returned intent', 'state');
              proof.equal(await rows('SELECT id FROM payment WHERE order_id=$1', [s.orderId]), [], 'mint records no unconfirmed payment', 'state');
              proof.equal(await one('SELECT state,grand_total FROM "order" WHERE id=$1', [s.orderId]), { state: 'PendingPayment', grand_total: 2500 }, 'mint preserves unpaid order economics', 'state');
            } else if (spec.kind === 'refresh') {
              proof.equal(body, { code: s.code, state: 'PendingPayment', intents: [{ intentId: s.intentId, outcome: 'open' }] }, 'receipt reconciles actual owned provider intent');
              proof.equal(calls(start).length, 1, 'refresh reads one tracked intent', 'state'); stripeCall(calls(start)[0], 'GET', '/v1/payment_intents/' + s.intentId, proof);
              proof.equal(await one('SELECT order_id,status,provider_ref,provider_status,result FROM payment_attempt WHERE id=$1', [s.attemptId]),
                { order_id: s.orderId, status: 'open', provider_ref: s.intentId, provider_status: 'requires_payment_method', result: { status: 'requires_payment_method' } }, 'provider observation committed only on owned attempt', 'state');
              proof.equal(await rows('SELECT id FROM payment WHERE order_id=$1', [s.orderId]), [], 'unconfirmed refresh creates no ledger tender', 'state');
              proof.equal(await one('SELECT state,grand_total FROM "order" WHERE id=$1', [s.orderId]), { state: 'PendingPayment', grand_total: 2500 }, 'refresh preserves unconfirmed order', 'state');
            } else {
              proof.equal(body, { attemptId: s.attemptId, status: 'settled', state: 'Paid', payment: 'Settled' }, 'receipt replays exact settled gateway attempt');
              proof.equal(await ledger(s), before, 'settled replay preserves existing attempt & tender without duplicates', 'state');
              proof.equal(calls(start), [], 'settled replay performs no additional provider charge', 'state');
            }
          } };
      } } satisfies MatrixCase;
  });
  // Configure real recurring variant first so auth, rather than provider/variant validation, decides each denial.
  const subscribeCell = (principal: MatrixPrincipal): MatrixCell => ({ effect: 'deny', status: 401, errorCode: 'NOT_AUTHENTICATED', async prepare() {
    await source.configure(); const { variantId } = await fixture.seedProduct();
    await rows('UPDATE product_variant SET stripe_price_id=$2 WHERE id=$1', [variantId, 'price_matrix_' + variantId.replaceAll('-', '')]);
    return { url: '/v1/shop/subscribe', init: { method: 'POST', headers: fixture.requestHeaders[principal], body: JSON.stringify({ variantId }) },
      env: peer(), snapshot: fixture.snapshotFor(principal, 'POST', '/v1/shop/subscribe', 401), async verify(response: Response, proof: MatrixProof) {
        const body = await json(response); proof.equal(body.error?.code, 'NOT_AUTHENTICATED', 'admin credentials cannot subscribe as customer');
        proof.equal(body.error?.message, 'not authenticated', 'exact subscription customer authentication denial');
      } };
  } });
  cases.push({ key: 'POST /v1/shop/subscribe', contract: 'customer', cells: { owner: subscribeCell('owner'), manager: subscribeCell('manager'), staff: subscribeCell('staff'),
    read_only: subscribeCell('read_only'), agent: subscribeCell('agent'), foreign_store: subscribeCell('foreign_store'), release_service: subscribeCell('release_service'), cache_token: subscribeCell('cache_token') } });

  const recoveryStatus: Record<MatrixPrincipal, number> = { owner: 200, manager: 200, staff: 403, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 };
  const recoveryCell = (principal: MatrixPrincipal): MatrixCell => {
    const status = recoveryStatus[principal], allow = status === 200;
    return { effect: allow ? 'allow' : 'deny', status, ...(principal === 'agent' ? { errorCode: 'AGENT_NOT_ALLOWED' } : {}), async prepare() {
      const s = await source.order('refund'), editId = randomUUID(), refundId = randomUUID();
      await rows(`INSERT INTO refund(id,store_id,payment_id,order_id,amount,state,reason) VALUES($1,$2,$3,$4,2500,'Failed','Matrix prior edit refund failed')`, [refundId, fixture.storeId, s.paymentId, s.orderId]);
      const failed = { type: 'refund_now', status: 'failed', amount: 2500, paymentId: s.paymentId, refundId, refundState: 'Failed' };
      await rows(`INSERT INTO order_edit(id,store_id,order_id,idempotency_key,before,after,balance,settlement,reason)
        VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,-2500,$7::jsonb,'Matrix legacy edit refund recovery')`,
        [editId, fixture.storeId, s.orderId, 'matrix-edit-' + editId, JSON.stringify({ totals: { grandTotal: 5000 } }), JSON.stringify({ totals: { grandTotal: 2500 } }), JSON.stringify(failed)]);
      const url = '/v1/admin/orders/' + s.code + '/edit/' + editId + '/refund', before = await ledger(s), start = transport.calls.length;
      return { url, init: { method: 'POST', headers: fixture.requestHeaders[principal], body: JSON.stringify({ action: 'credit', paymentId: s.paymentId }) },
        ...(allow ? {} : { snapshot: fixture.snapshotFor(principal, 'POST', url, status, principal === 'agent' ? 'money_out' : undefined) }),
        async verify(response: Response, proof: MatrixProof) {
          const body = await json(response);
          if (allow) {
            const settlement = { type: 'leave_credit', status: 'credit', amount: 2500, message: 'refund abandoned; left as credit on the order' };
            proof.equal(body, { editId, state: 'Paid', amountDue: -2500, settlement }, 'failed refund explicitly converted to existing order credit');
            proof.equal(await one('SELECT settlement,balance FROM order_edit WHERE id=$1', [editId]), { settlement, balance: -2500 }, 'recovered edit settlement committed', 'state');
            proof.equal(await one('SELECT state,amount,payment_id FROM refund WHERE id=$1', [refundId]), { state: 'Failed', amount: 2500, payment_id: s.paymentId }, 'historical failed refund retained', 'state');
            proof.equal(await ledger(s), before, 'credit recovery preserves original payment & order economics', 'state');
            proof.equal(await rows("SELECT actor,data FROM audit_log WHERE entity='order' AND entity_id=$1 AND action='edit_refund_credit'", [s.orderId]),
              [{ actor: fixture.identityFor(principal).email, data: { editId, ...settlement } }], 'exact recovery audit committed once', 'state');
            proof.equal(calls(start), [], 'leave-credit recovery performs no external refund', 'state');
          } else if (principal === 'agent') {
            proof.equal(body.error?.code, 'AGENT_NOT_ALLOWED', 'explicit agent money-out hard denial');
            proof.equal(body.error?.message, 'agents cannot move money out of the store', 'exact money-out hard denial reason');
          } else if (principal === 'release_service' || principal === 'cache_token') {
            proof.equal(body.error?.code, 'NOT_AUTHENTICATED', 'non-admin credential refused for recovery');
            proof.equal(body.error?.message, principal === 'cache_token' ? 'not authenticated' : 'invalid or expired session', 'exact authentication refusal');
          } else if (principal === 'foreign_store') {
            proof.equal(body.error?.message, 'no access to store: ' + fixture.storeSlug, 'owner B cannot target existing store A edit');
            proof.equal(body.error?.code, `NO_ACCESS_TO_STORE_${fixture.storeSlug.replace(/[^a-zA-Z0-9_]/g, '').toUpperCase()}`.slice(0, 64), 'exact foreign-store error');
          } else {
            proof.equal(body.error?.message, principal === 'read_only' ? "role 'read_only' is read-only" : "role 'staff' lacks the 'refunds' permission", 'exact recovery role refusal');
            proof.equal(body.error?.code, principal === 'read_only' ? 'ROLE_READ_ONLY_IS_READONLY' : 'ROLE_STAFF_LACKS_THE_REFUNDS_PERMISSION', 'exact recovery permission code');
          }
        } };
    } };
  };
  cases.push({ key: 'POST /v1/admin/orders/{code}/edit/{editId}/refund', contract: 'admin', cells: { owner: recoveryCell('owner'), manager: recoveryCell('manager'), staff: recoveryCell('staff'),
    read_only: recoveryCell('read_only'), agent: recoveryCell('agent'), foreign_store: recoveryCell('foreign_store'), release_service: recoveryCell('release_service'), cache_token: recoveryCell('cache_token') } });
  return cases;
}

/** Real authenticated customer control paired with eight admin-only subscription denials. */
export function createPaymentControls(fixture: Fixture, transport: AuthorizationTransport): PaymentControl[] {
  const source = paymentSource(fixture, transport);
  return [{ key: 'POST /v1/shop/subscribe', status: 200, async prepare() {
    await source.configure(); const s = await source.customer(), { variantId } = await fixture.seedProduct();
    const price = 'price_matrix_' + variantId.replaceAll('-', '');
    await source.rows('UPDATE product_variant SET stripe_price_id=$2 WHERE id=$1', [variantId, price]);
    const start = transport.calls.length;
    return { url: '/v1/shop/subscribe', init: { method: 'POST', headers: s.customerHeaders, body: JSON.stringify({ variantId }) }, env: peer(), async verify(response: Response, proof: MatrixProof) {
      proof.equal(await json(response), { url: 'https://checkout.matrix.synthetic.invalid/session' }, 'authenticated customer receives synthetic subscription checkout');
      const orders = await source.rows('SELECT id,code,state,currency,subtotal,grand_total,metadata FROM "order" WHERE customer_id=$1', [s.customerId]);
      proof.equal(orders.length, 1, 'one subscription backing order committed for authenticated customer', 'state');
      const order = orders[0]!;
      proof.equal({ state: order.state, currency: order.currency, subtotal: order.subtotal, total: order.grand_total, metadata: order.metadata },
        { state: 'PendingPayment', currency: 'USD', subtotal: 2500, total: 2500, metadata: { subscription: true } }, 'unpaid recurring order economics committed', 'state');
      proof.equal(await source.rows('SELECT variant_id,quantity,unit_price,line_total FROM order_line WHERE order_id=$1', [order.id]),
        [{ variant_id: variantId, quantity: 1, unit_price: 2500, line_total: 2500 }], 'backing order uses requested existing recurring variant', 'state');
      proof.equal(await source.rows('SELECT id FROM payment WHERE order_id=$1', [order.id]), [], 'checkout session creates no unconfirmed settled payment', 'state');
      const calls = source.calls(start); proof.equal(calls.length, 1, 'one subscription provider session created', 'state');
      source.stripeCall(calls[0], 'POST', '/v1/checkout/sessions', proof);
      const form = new URLSearchParams(calls[0]!.body);
      proof.equal({ mode: form.get('mode'), price: form.get('line_items[0][price]'), quantity: form.get('line_items[0][quantity]'), email: form.get('customer_email') },
        { mode: 'subscription', price, quantity: '1', email: s.email }, 'provider checkout belongs to real customer & recurring price', 'state');
      for (const prefix of ['metadata', 'subscription_data[metadata]']) {
        proof.equal({ storeId: form.get(prefix + '[storeId]'), orderCode: form.get(prefix + '[orderCode]'), customerId: form.get(prefix + '[customerId]') },
          { storeId: fixture.storeId, orderCode: order.code, customerId: s.customerId }, 'session & subscription bind same committed customer order', 'state');
      }
    } };
  } }];
}
