/** Synthetic order authorization contracts for B2.8; source-only, never packed. */
import { randomUUID } from 'node:crypto';
import { calculatePromotionStack, type StackInput } from '../money/promotion-stack.js';
import { buildOrderPricingSnapshot } from '../money/pricing-snapshot.js';
import { calculateOrderTotals } from '../money/totals.js';
import { resolveTaxRate, type TaxZoneRule } from '../money/tax.js';
import { previewOrderEdit } from '../orders/order-edit-service.js';
import type { MatrixMutationFixture } from './authorization-matrix.mutation-cases.testkit.js';
import type { MatrixCase, MatrixCell, MatrixPrincipal, MatrixProof } from './authorization-matrix.testkit.js';

type Fixture = Omit<MatrixMutationFixture, 'snapshotFor'> & {
  snapshotFor(principal: MatrixPrincipal, method: string, path: string, status?: number, hardAgentGroup?: string): () => Promise<unknown>;
};
type Access = 'read' | 'write' | 'cancel' | 'purge' | 'refund';
type Seed = { orderId: string; code: string; lineId: string; variantId: string; sku: string; productName: string; paymentId: string | null };
type Prepared = { url: string; body?: unknown; verify(response: Response, proof: MatrixProof): Promise<void> };
// Expected policy is explicit; no production authorization helper computes it.
const STATUS: Record<Access, Record<MatrixPrincipal, number>> = {
  read: { owner: 200, manager: 200, staff: 200, read_only: 200, agent: 200, foreign_store: 403, release_service: 401, cache_token: 401 },
  write: { owner: 200, manager: 200, staff: 200, read_only: 403, agent: 200, foreign_store: 403, release_service: 401, cache_token: 401 },
  cancel: { owner: 200, manager: 200, staff: 403, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 },
  purge: { owner: 200, manager: 200, staff: 403, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 },
  refund: { owner: 200, manager: 200, staff: 403, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 },
};
const address = { fullName: 'Matrix Recipient', line1: '1 Matrix St', line2: null, city: 'Austin', province: 'TX', postalCode: '78701', country: 'US', phone: null };
const updatedAddress = { ...address, line1: '2 Matrix St' };
const billingAddress = { ...address, line1: '9 Billing St' };
const path = (seed: Seed) => `/v1/admin/orders/${seed.code}`;
const json = async (response: Response) => await response.json() as Record<string, any>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createOrderCases(fixture: Fixture): MatrixCase[] {
  const cases: MatrixCase[] = [];
  const query = async (sql: string, values: unknown[] = []) => (await fixture.queryStore(fixture.storeId, sql, values)).rows;
  const one = async (sql: string, values: unknown[] = []) => {
    const rows = await query(sql, values);
    if (rows.length !== 1) throw new Error(`matrix order fixture expected one row: ${sql}`);
    return rows[0]!;
  };
  async function seedOrder(paid = false): Promise<Seed> {
    const { variantId } = await fixture.seedProduct();
    const variant = await one('select v.sku,p.name as product_name from product_variant v join product p on p.id=v.product_id where v.id=$1', [variantId]);
    const orderId = randomUUID(), lineId = randomUUID(), code = `MATRIX-${randomUUID()}`;
    // A placed native order retains its captured zero-tax basis even after
    // other matrix fixtures change US tax zones or store pricing settings.
    // Use the production pricing producer, not unproven legacy money columns.
    const pricingInput: StackInput = {
      lines: [{ key: lineId, quantity: 2, placedQuantity: 2, unitListPrice: 2500, priceIncludesTax: false, taxRateBps: 0 }],
      promotions: [], couponCodes: [], phase: 'PaymentSettled', currency: 'USD',
      pricesIncludeTax: false, shipping: 0, shippingTaxRateBps: 0, shippingIncludesTax: false,
      couponContext: { activeVerifications: [] }, pointsDiscount: 0,
    };
    const pricing = calculatePromotionStack(pricingInput);
    const pricingSnapshot = buildOrderPricingSnapshot(pricingInput, pricing, new Map([[lineId, lineId]]));
    await query('update stock set on_hand=20,allocated=2 where variant_id=$1', [variantId]);
    await query(`insert into "order"(id,store_id,code,state,currency,subtotal,discount_total,shipping_total,tax_total,grand_total,shipping_address,billing_address,pricing_snapshot)
      values ($1,$2,$3,$4,'USD',$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb)`, [orderId, fixture.storeId, code, paid ? 'Paid' : 'PendingPayment',
      pricing.subtotal, pricing.discountTotal, pricing.shippingTotal, pricing.taxTotal, pricing.grandTotal,
      JSON.stringify(address), JSON.stringify(billingAddress), JSON.stringify(pricingSnapshot)]);
    await query(`insert into order_line(id,store_id,order_id,variant_id,variant_sku,variant_name,quantity,unit_price,line_subtotal,line_total)
      values ($1,$2,$3,$4,$5,'Matrix variant',2,2500,5000,5000)`, [lineId, fixture.storeId, orderId, variantId, variant.sku]);
    const paymentId = paid ? randomUUID() : null;
    if (paymentId) await query(`insert into payment(id,store_id,order_id,amount,method,state,currency,provider_ref)
      values ($1,$2,$3,5000,'manual','Settled','USD',$4)`, [paymentId, fixture.storeId, orderId, `matrix-${code}`]);
    return { orderId, code, lineId, variantId, sku: variant.sku, productName: variant.product_name, paymentId };
  }
  const hardGroup = (access: Access) => access === 'cancel' || access === 'purge' ? 'irreversible_order' : access === 'refund' ? 'money_out' : undefined;
  const add = (key: string, access: Access, paid: boolean, prepare: (seed: Seed, principal: MatrixPrincipal) => Promise<Prepared>) => {
    const method = key.split(' ')[0]!;
    const cell = (principal: MatrixPrincipal): MatrixCell => {
      const status = STATUS[access][principal], allow = status === 200;
      const hard = principal === 'agent' ? hardGroup(access) : undefined;
      return { effect: allow ? 'allow' : 'deny', status, ...(hard ? { errorCode: 'AGENT_NOT_ALLOWED' } : {}), async prepare() {
        // Fresh store-A target per cell; foreign-store owner B receives the same valid target.
        const seed = await seedOrder(paid), prepared = await prepare(seed, principal);
        return { url: prepared.url, init: { method, headers: { ...fixture.requestHeaders[principal], 'content-type': 'application/json' },
          ...(prepared.body === undefined ? {} : { body: JSON.stringify(prepared.body) }) },
          ...(allow ? {} : { snapshot: fixture.snapshotFor(principal, method, new URL(prepared.url, 'http://matrix.invalid').pathname, status, hard) }),
          async verify(response: Response, proof: MatrixProof) {
            if (allow) return prepared.verify(response, proof);
            const body = await json(response);
            if (principal === 'release_service' || principal === 'cache_token') {
              proof.equal(body.error?.code, 'NOT_AUTHENTICATED', 'non-admin credential refused');
              proof.equal(body.error?.message, principal === 'cache_token' ? 'not authenticated' : 'invalid or expired session', 'exact authentication reason');
            } else if (hard) {
              proof.equal(body.error?.code, 'AGENT_NOT_ALLOWED', 'agent hard authorization denial');
              proof.equal(body.error?.message, hard === 'money_out' ? 'agents cannot move money out of the store' : 'agents cannot cancel or purge orders — trash is reversible, this is not', 'exact agent denial reason');
            } else if (principal === 'foreign_store') {
              proof.equal(body.error?.message, `no access to store: ${fixture.storeSlug}`, 'foreign owner cannot select store A');
              proof.equal(body.error?.code, `NO_ACCESS_TO_STORE_${fixture.storeSlug.replace(/[^a-zA-Z0-9_]/g, '').toUpperCase()}`.slice(0, 64), 'foreign-store error code');
            } else {
              const manage = access === 'purge';
              const message = manage ? `role '${principal}' cannot manage settings/staff` : principal === 'read_only' ? "role 'read_only' is read-only" : `role 'staff' lacks the '${access === 'cancel' ? 'cancel_orders' : 'refunds'}' permission`;
              const code = manage ? `ROLE_${principal.toUpperCase()}_CANNOT_MANAGE_SETTINGSSTAFF` : principal === 'read_only' ? 'ROLE_READ_ONLY_IS_READONLY' : access === 'cancel' ? 'ROLE_STAFF_LACKS_THE_CANCEL_ORDERS_PERMISSION' : 'ROLE_STAFF_LACKS_THE_REFUNDS_PERMISSION';
              proof.equal(body.error?.message, message, 'exact role/permission denial');
              proof.equal(body.error?.code, code, 'exact role/permission code');
            }
          },
        };
      } };
    };
    cases.push({ key, contract: 'admin', cells: { owner: cell('owner'), manager: cell('manager'), staff: cell('staff'), read_only: cell('read_only'),
      agent: cell('agent'), foreign_store: cell('foreign_store'), release_service: cell('release_service'), cache_token: cell('cache_token') } });
  };
  const audit = async (seed: Seed, action: string, proof: MatrixProof) => proof.equal(await one('select count(*)::int as n from audit_log where entity=$1 and entity_id=$2 and action=$3', ['order', seed.orderId, action]), { n: 1 }, `${action} audit committed once`, 'state');
  const stock = async (seed: Seed, onHand: number, allocated: number, proof: MatrixProof) => {
    const actual = await one('select on_hand,allocated from stock where variant_id=$1', [seed.variantId]);
    const expected = { on_hand: onHand, allocated };
    // Stock counts are nonsecret. Include exact values because the gate's
    // fail-closed state assertion otherwise reports only its fixture label.
    proof.equal(actual, expected, 'stock effect committed: expected ' + JSON.stringify(expected) + ', actual ' + JSON.stringify(actual), 'state');
  };
  const totals = { subtotal: 5000, discountTotal: 0, shippingTotal: 0, taxTotal: 0, grandTotal: 5000, adjustmentTotal: 0 };

  add('GET /v1/admin/orders/{code}', 'read', false, async (seed, principal) => ({ url: path(seed), async verify(response: Response, proof: MatrixProof) {
    const body = await json(response);
    proof.equal({ code: body.code, state: body.state, grandTotal: body.grandTotal, amountDue: body.amountDue }, { code: seed.code, state: 'PendingPayment', grandTotal: 5000, amountDue: 5000 }, 'existing order economics');
    proof.equal(body.shippingAddress, address, 'shipping address visible');
    proof.equal(body.billingAddress, principal === 'agent' ? null : billingAddress, 'agent billing redaction');
    proof.equal(body.lines.map((line: any) => ({ id: line.id, sku: line.sku, quantity: line.quantity, unitPrice: line.unitPrice, lineTotal: line.lineTotal })), [{ id: seed.lineId, sku: seed.sku, quantity: 2, unitPrice: 2500, lineTotal: 5000 }], 'exact order-owned lines');
    proof.equal([body.payments, body.fulfillments, body.refunds], [[], [], []], 'fresh order has no money/shipment children');
  } }));
  add('GET /v1/admin/orders/{code}/edit/context', 'read', false, async seed => ({ url: `${path(seed)}/edit/context`, async verify(response: Response, proof: MatrixProof) {
    const body = await json(response);
    proof.equal({ code: body.code, state: body.state, amountDue: body.amountDue, pendingEdit: body.pendingEdit, history: body.history }, { code: seed.code, state: 'PendingPayment', amountDue: 5000, pendingEdit: null, history: [] }, 'fresh order edit context');
    proof.equal(body.lines.map((line: any) => ({ id: line.id, sku: line.sku, quantity: line.quantity, minQuantity: line.minQuantity })), [{ id: seed.lineId, sku: seed.sku, quantity: 2, minQuantity: 0 }], 'edit targets bound to existing line');
    proof.equal(body.editable, { items: true, addressOnly: false, address: true, blockedReason: null }, 'unpaid physical order editable');
  } }));
  add('GET /v1/admin/orders/{code}/edit/variants', 'read', false, async seed => ({ url: `${path(seed)}/edit/variants?q=${encodeURIComponent(seed.sku)}`, async verify(response: Response, proof: MatrixProof) {
    proof.equal(await json(response), { items: [{ sku: seed.sku, name: 'Matrix variant', productName: seed.productName, unitPrice: 2500, available: 18 }] }, 'unique existing variant with live inventory');
  } }));
  for (const document of ['invoice', 'packing-slip'] as const) add(`GET /v1/admin/orders/{code}/${document}`, 'read', false, async seed => ({ url: `${path(seed)}/${document}`, async verify(response: Response, proof: MatrixProof) {
    const body = await json(response);
    proof.equal({ type: body.type, number: body.number, shipTo: body.shipTo }, { type: document === 'invoice' ? 'invoice' : 'packing_slip', number: `${document === 'invoice' ? 'INV' : 'PS'}-${seed.code}`, shipTo: ['Matrix Recipient', '1 Matrix St', 'Austin, TX, 78701', 'US'] }, 'document identity and recipient');
    proof.equal(body.store.slug, fixture.storeSlug, 'document belongs to selected store');
    proof.equal(body.lines, document === 'invoice' ? [{ sku: seed.sku, name: 'Matrix variant', quantity: 2, unitPrice: '$25.00', lineTotal: '$50.00' }] : [{ sku: seed.sku, name: 'Matrix variant', quantity: 2 }], 'document line snapshot');
    if (document === 'invoice') proof.equal(body.totals, { subtotal: '$50.00', discount: '$0.00', shipping: '$0.00', tax: '$0.00', grand: '$50.00' }, 'invoice monetary totals');
  } }));
  add('POST /v1/admin/orders/{code}/notes', 'write', false, async seed => ({ url: `${path(seed)}/notes`, body: { note: `Matrix note ${seed.code}` }, async verify(response: Response, proof: MatrixProof) {
    const saved = await one("select id,data from audit_log where entity='order' and entity_id=$1 and action='note'", [seed.orderId]);
    proof.equal(await json(response), { id: saved.id }, 'note response binds saved timeline row');
    proof.equal(saved.data, { note: `Matrix note ${seed.code}` }, 'note committed', 'state');
  } }));
  add('PUT /v1/admin/orders/{code}/address', 'write', false, async seed => ({ url: `${path(seed)}/address`, body: { kind: 'shipping', address: updatedAddress, saveToAddressBook: false, reason: 'Matrix correction' }, async verify(response: Response, proof: MatrixProof) {
    proof.equal(await json(response), { code: seed.code, kind: 'shipping', address: updatedAddress, changed: true, savedToAddressBook: false }, 'address result');
    proof.equal(await one('select shipping_address,billing_address,grand_total from "order" where id=$1', [seed.orderId]), { shipping_address: updatedAddress, billing_address: billingAddress, grand_total: 5000 }, 'shipping changed; billing and money preserved', 'state');
    await audit(seed, 'edit_address', proof);
  } }));
  add('PATCH /v1/admin/orders/{code}/lines', 'write', false, async seed => {
    // admin-orders.ts legacy line editing explicitly refuses saved pricing
    // snapshots. Seed its supported simple native order, priced from the live
    // tax basis; modern preview/commit cases retain their captured snapshots.
    const store = await one('select tax_rate,tax_inclusive,shipping_taxable from store where id=$1', [fixture.storeId]);
    const zones = await query('select countries,rate,priority from tax_zone where enabled=true') as TaxZoneRule[];
    const taxRate = resolveTaxRate(zones, address.country, store.tax_rate);
    const price = (quantity: number) => calculateOrderTotals({
      lines: [{ unitPrice: 2500, quantity }], shipping: 0, taxRate,
      taxInclusive: store.tax_inclusive, shippingTaxable: store.shipping_taxable,
    });
    const before = price(2), after = price(3), line = before.lines[0]!;
    await query('update "order" set subtotal=$2,discount_total=$3,shipping_total=$4,tax_total=$5,grand_total=$6,pricing_snapshot=null where id=$1',
      [seed.orderId, before.subtotal, before.discountTotal, before.shippingTotal, before.taxTotal, before.grandTotal]);
    await query('update order_line set line_subtotal=$2,line_discount=$3,line_tax=0,line_total=$4 where id=$1',
      [seed.lineId, line.lineSubtotal, line.lineDiscount, line.lineTotal]);
    return { url: `${path(seed)}/lines`, body: { lines: [{ sku: seed.sku, quantity: 3 }] }, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await json(response), { code: seed.code, grandTotal: after.grandTotal }, 'line edit exact priced response');
      proof.equal(await one('select state,currency,subtotal,discount_total,shipping_total,tax_total,grand_total,pricing_snapshot,shipping_address,billing_address from "order" where id=$1', [seed.orderId]),
        { state: 'PendingPayment', currency: 'USD', subtotal: 7500, discount_total: 0, shipping_total: 0, tax_total: after.taxTotal, grand_total: after.grandTotal,
          pricing_snapshot: null, shipping_address: address, billing_address: billingAddress }, 'line edit exact economics and address preservation', 'state');
      proof.equal(await query('select variant_id,quantity,unit_price,line_subtotal,line_discount,line_tax,line_total from order_line where order_id=$1', [seed.orderId]),
        [{ variant_id: seed.variantId, quantity: 3, unit_price: 2500, line_subtotal: 7500, line_discount: 0, line_tax: 0, line_total: 7500 }], 'replacement legacy line committed', 'state');
      proof.equal(await query('select id from payment where order_id=$1', [seed.orderId]), [], 'unpaid line edit moves no money', 'state');
      await stock(seed, 20, 3, proof); await audit(seed, 'edit_lines', proof);
    } };
  });
  add('POST /v1/admin/draft-orders', 'write', false, async seed => ({ url: '/v1/admin/draft-orders', body: { items: [{ sku: seed.sku, quantity: 1 }], markPaid: false, shipping: 0, shippingAddress: address }, async verify(response: Response, proof: MatrixProof) {
    const body = await json(response), saved = await one('select id,code,state,subtotal,grand_total,shipping_address from "order" where code=$1', [body.code]);
    proof.ok(uuid.test(saved.id) && saved.id !== seed.orderId, 'new draft distinct from seed', 'state');
    proof.equal(body, { code: saved.code, state: 'PendingPayment', grandTotal: saved.grand_total }, 'draft exact response');
    proof.equal({ state: saved.state, subtotal: saved.subtotal, address: saved.shipping_address }, { state: 'PendingPayment', subtotal: 2500, address }, 'unpaid draft committed', 'state');
    proof.equal(await query('select variant_id,quantity,unit_price from order_line where order_id=$1', [saved.id]), [{ variant_id: seed.variantId, quantity: 1, unit_price: 2500 }], 'draft line committed', 'state');
    proof.equal(await query('select id from payment where order_id=$1', [saved.id]), [], 'draft creates no payment', 'state'); await stock(seed, 20, 3, proof);
  } }));
  add('POST /v1/admin/orders/{code}/edit/preview', 'write', false, async seed => {
    const before = await one('select shipping_address,grand_total from "order" where id=$1', [seed.orderId]);
    return { url: `${path(seed)}/edit/preview`, body: { ops: [{ op: 'set_address', kind: 'shipping', address: updatedAddress }] }, async verify(response: Response, proof: MatrixProof) {
      const body = await json(response);
      proof.equal({ code: body.code, before: body.before, after: body.after, stockOk: body.stockOk }, { code: seed.code, before: totals, after: totals, stockOk: true }, 'address-only preview preserves economics');
      proof.ok(/^[0-9a-f]{64}$/.test(body.previewAcceptanceHash), 'preview returns binding acceptance hash');
      proof.equal(await one('select shipping_address,grand_total from "order" where id=$1', [seed.orderId]), before, 'preview leaves committed order unchanged', 'state');
      proof.equal(await query('select id from order_edit where order_id=$1', [seed.orderId]), [], 'preview creates no edit history', 'state'); await stock(seed, 20, 2, proof);
    } };
  });
  add('POST /v1/admin/orders/{code}/edit/commit', 'write', false, async seed => {
    const ops = [{ op: 'set_address' as const, kind: 'shipping' as const, address: updatedAddress }];
    // A genuine acceptance hash belongs to this fresh order; never submit a placeholder.
    const preview = await previewOrderEdit(fixture.storeId, seed.code, ops);
    const idempotencyKey = `matrix-edit-${seed.code}`;
    return { url: `${path(seed)}/edit/commit`, body: { ops, expectedGrandTotal: 5000, expectedBalance: 5000, previewAcceptanceHash: preview.previewAcceptanceHash, idempotencyKey, notifyCustomer: false, settlement: { type: 'leave_due' } }, async verify(response: Response, proof: MatrixProof) {
      const body = await json(response);
      proof.equal({ code: body.code, grandTotal: body.grandTotal, previousGrandTotal: body.previousGrandTotal, amountDue: body.amountDue, replay: body.replay }, { code: seed.code, grandTotal: 5000, previousGrandTotal: 5000, amountDue: 5000, replay: false }, 'committed edit response');
      proof.equal(await one('select shipping_address,grand_total from "order" where id=$1', [seed.orderId]), { shipping_address: updatedAddress, grand_total: 5000 }, 'edit address committed', 'state');
      proof.equal(await one('select id,idempotency_key from order_edit where order_id=$1', [seed.orderId]), { id: body.editId, idempotency_key: idempotencyKey }, 'one idempotent edit history row committed', 'state'); await audit(seed, 'edit', proof);
    } };
  });
  const shipped = async (seed: Seed, quantity: number, proof: MatrixProof) => {
    proof.equal(await one('select fulfilled_qty from order_line where id=$1', [seed.lineId]), { fulfilled_qty: quantity }, 'shipped units committed', 'state');
    await stock(seed, 20 - quantity, 2 - quantity, proof);
    proof.equal(await query('select delta,reason from stock_movement where ref_order_id=$1', [seed.orderId]), [{ delta: -quantity, reason: 'fulfillment' }], 'shipment movement committed once', 'state'); await audit(seed, 'fulfill', proof);
  };
  add('POST /v1/admin/orders/{code}/fulfill', 'write', true, async seed => ({ url: `${path(seed)}/fulfill`, body: { state: 'Shipped', trackingCode: seed.code, carrier: 'Matrix' }, async verify(response: Response, proof: MatrixProof) {
    proof.equal(await json(response), { code: seed.code, fulfillment: 'Shipped' }, 'whole fulfillment response');
    proof.equal(await query('select state,tracking_code,carrier from fulfillment where order_id=$1', [seed.orderId]), [{ state: 'Shipped', tracking_code: seed.code, carrier: 'Matrix' }], 'whole fulfillment committed', 'state'); await shipped(seed, 2, proof);
  } }));
  add('POST /v1/admin/orders/{code}/fulfillments', 'write', true, async seed => ({ url: `${path(seed)}/fulfillments`, body: { lines: [{ orderLineId: seed.lineId, quantity: 1 }], trackingCode: seed.code, carrier: 'Matrix', notifyCustomer: false }, async verify(response: Response, proof: MatrixProof) {
    const body = await json(response);
    proof.ok(uuid.test(body.fulfillmentId), 'partial fulfillment UUID');
    proof.equal(body, { code: seed.code, fulfillmentId: body.fulfillmentId, state: 'Shipped' }, 'partial fulfillment response');
    proof.equal(await one('select order_id,state,notify_customer from fulfillment where id=$1', [body.fulfillmentId]), { order_id: seed.orderId, state: 'Shipped', notify_customer: false }, 'partial shipment committed', 'state');
    proof.equal(await query('select order_line_id,quantity from fulfillment_line where fulfillment_id=$1', [body.fulfillmentId]), [{ order_line_id: seed.lineId, quantity: 1 }], 'partial line binding committed', 'state'); await shipped(seed, 1, proof);
  } }));
  add('POST /v1/admin/orders/bulk-fulfill', 'write', true, async seed => ({ url: '/v1/admin/orders/bulk-fulfill', body: { orders: [{ code: seed.code, state: 'Shipped', trackingCode: seed.code, carrier: 'Matrix' }] }, async verify(response: Response, proof: MatrixProof) {
    proof.equal(await json(response), { results: [{ code: seed.code, ok: true, fulfillment: 'Shipped' }], succeeded: 1, skipped: 0 }, 'bulk shipment succeeds for eligible order'); await shipped(seed, 2, proof);
    proof.equal(await query('select state,tracking_code from fulfillment where order_id=$1', [seed.orderId]), [{ state: 'Shipped', tracking_code: seed.code }], 'bulk shipment committed', 'state');
  } }));
  const cancelled = async (seed: Seed, proof: MatrixProof) => {
    proof.equal(await one('select state from "order" where id=$1', [seed.orderId]), { state: 'Cancelled' }, 'cancelled state committed', 'state');
    proof.equal(await one('select cancelled_qty from order_line where id=$1', [seed.lineId]), { cancelled_qty: 2 }, 'remaining units cancelled', 'state'); await stock(seed, 20, 0, proof); await audit(seed, 'cancel', proof);
  };
  add('POST /v1/admin/orders/{code}/cancel', 'cancel', false, async seed => ({ url: `${path(seed)}/cancel`, body: { reason: 'Matrix unpaid cancellation' }, async verify(response: Response, proof: MatrixProof) {
    proof.equal(await json(response), { code: seed.code, state: 'Cancelled' }, 'single cancellation response'); await cancelled(seed, proof);
  } }));
  add('POST /v1/admin/orders/bulk-cancel', 'cancel', false, async seed => ({ url: '/v1/admin/orders/bulk-cancel', body: { codes: [seed.code] }, async verify(response: Response, proof: MatrixProof) {
    proof.equal(await json(response), { results: [{ code: seed.code, ok: true }], succeeded: 1, skipped: 0 }, 'bulk cancellation succeeds'); await cancelled(seed, proof);
  } }));
  for (const operation of ['soft-delete', 'restore', 'purge'] as const) add(`POST /v1/admin/orders/bulk-${operation}`, operation === 'purge' ? 'purge' : 'write', false, async seed => {
    if (operation !== 'soft-delete') await query('update "order" set deleted_at=now() where id=$1', [seed.orderId]);
    return { url: `/v1/admin/orders/bulk-${operation}`, body: { codes: [seed.code] }, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await json(response), { results: [{ code: seed.code, ok: true }], succeeded: 1, skipped: 0 }, `bulk ${operation} response`);
      if (operation === 'purge') {
        proof.equal(await query('select id from "order" where id=$1', [seed.orderId]), [], 'trashed order purged', 'state');
        proof.equal(await query('select id from order_line where order_id=$1', [seed.orderId]), [], 'purged child lines removed', 'state'); await stock(seed, 20, 0, proof);
      } else {
        proof.equal(await one('select deleted_at is not null as trashed,status from "order" where id=$1', [seed.orderId]), { trashed: operation === 'soft-delete', status: operation === 'soft-delete' ? 'archived' : 'open' }, `order ${operation} committed`, 'state'); await stock(seed, 20, 2, proof);
      }
      await audit(seed, operation === 'soft-delete' ? 'soft_delete' : operation, proof);
    } };
  });
  const seedReturn = async (seed: Seed) => {
    const id = randomUUID();
    await query("insert into return_request(id,store_id,order_id,status,reason) values ($1,$2,$3,'requested','Matrix return')", [id, fixture.storeId, seed.orderId]);
    await query('insert into return_line(store_id,return_id,order_line_id,quantity,restock) values ($1,$2,$3,1,false)', [fixture.storeId, id, seed.lineId]);
    return id;
  };
  add('POST /v1/admin/orders/{code}/returns', 'write', true, async seed => ({ url: `${path(seed)}/returns`, body: { lines: [{ orderLineId: seed.lineId, quantity: 1, restock: false }], reason: 'Matrix return' }, async verify(response: Response, proof: MatrixProof) {
    const saved = await one('select id,status,reason from return_request where order_id=$1', [seed.orderId]);
    proof.equal(await json(response), { id: saved.id }, 'return response identifies persisted request');
    proof.equal(saved, { id: saved.id, status: 'requested', reason: 'Matrix return' }, 'return request committed', 'state');
    proof.equal(await query('select order_line_id,quantity,restock from return_line where return_id=$1', [saved.id]), [{ order_line_id: seed.lineId, quantity: 1, restock: false }], 'return line committed', 'state');
  } }));
  add('POST /v1/admin/returns/{id}/reject', 'write', true, async seed => {
    const id = await seedReturn(seed);
    return { url: `/v1/admin/returns/${id}/reject`, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await json(response), { id }, 'rejection response');
      proof.equal(await one('select status,refund_id from return_request where id=$1', [id]), { status: 'rejected', refund_id: null }, 'return rejected without refund', 'state');
      proof.equal(await query('select id from refund where order_id=$1', [seed.orderId]), [], 'no money moved', 'state');
    } };
  });
  const refunded = async (seed: Seed, response: Response, proof: MatrixProof, returnId?: string) => {
    const body = await json(response);
    proof.equal({ identity: returnId ? body.id : body.code, refundState: body.refundState, state: body.state, refunded: body.refunded, pending: body.pending }, { identity: returnId ?? seed.code, refundState: 'Settled', state: 'PartiallyRefunded', refunded: 2500, pending: 0 }, 'real manual partial refund response');
    proof.ok(uuid.test(body.refundId), 'refund UUID');
    proof.equal(await one('select payment_id,order_id,amount,items_amount,state from refund where id=$1', [body.refundId]), { payment_id: seed.paymentId, order_id: seed.orderId, amount: 2500, items_amount: 2500, state: 'Settled' }, 'refund committed against chosen settled manual tender', 'state');
    proof.equal(await query('select order_line_id,quantity,amount,restock from refund_line where refund_id=$1', [body.refundId]), [{ order_line_id: seed.lineId, quantity: 1, amount: 2500, restock: false }], 'refund quantity committed', 'state');
    proof.equal(await one('select refunded_qty from order_line where id=$1', [seed.lineId]), { refunded_qty: 1 }, 'refunded line unit committed', 'state');
    proof.equal(await one('select state from "order" where id=$1', [seed.orderId]), { state: 'PartiallyRefunded' }, 'partial refund lifecycle committed', 'state');
    if (returnId) proof.equal(await one('select status,refund_id from return_request where id=$1', [returnId]), { status: 'refunded', refund_id: body.refundId }, 'return linked to settled refund', 'state');
  };
  add('POST /v1/admin/orders/{code}/refund', 'refund', true, async seed => ({ url: `${path(seed)}/refund`, body: { idempotencyKey: `matrix-refund-${seed.code}`, paymentId: seed.paymentId, lines: [{ orderLineId: seed.lineId, quantity: 1, restock: false }], restock: false, reason: 'Matrix partial refund' }, async verify(response: Response, proof: MatrixProof) { await refunded(seed, response, proof); } }));
  add('POST /v1/admin/returns/{id}/approve', 'refund', true, async seed => {
    const id = await seedReturn(seed);
    return { url: `/v1/admin/returns/${id}/approve`, body: { paymentId: seed.paymentId, restock: false }, async verify(response: Response, proof: MatrixProof) { await refunded(seed, response, proof, id); } };
  });
  return cases;
}
