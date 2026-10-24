/** B2.8 local reconciliation recovery & operator workflow contracts. Test source only. */
import { randomUUID } from 'node:crypto';
import { withStore } from '../db/client.js';
import { executeEffectsNow } from '../payments/settlement/effects.js';
import { registerBuiltinEffectHandlers } from '../payments/settlement/handlers.js';
import type { createAuthorizationFixtures } from './authorization-matrix.fixtures.testkit.js';
import type { MatrixCase, MatrixCell, MatrixPrincipal, MatrixProof, PreparedMatrixCell } from './authorization-matrix.testkit.js';

export type MatrixReconciliationFixture = Pick<Awaited<ReturnType<typeof createAuthorizationFixtures>>,
  'storeId' | 'storeSlug' | 'queryStore' | 'seedProduct' | 'requestHeaders' | 'snapshotFor' | 'snapshot' | 'positiveControls'>;
type Json = Record<string, any>;
type Spec = { key: string; permission: 'refunds' | 'write'; group?: 'settlement' | 'entitlement'; prepare(): Promise<PreparedMatrixCell> };
const STATUS = {
  refunds: { owner: 200, manager: 200, staff: 403, read_only: 403, agent: 403, foreign_store: 403, release_service: 401, cache_token: 401 },
  write: { owner: 200, manager: 200, staff: 200, read_only: 403, agent: 200, foreign_store: 403, release_service: 401, cache_token: 401 },
} satisfies Record<string, Record<MatrixPrincipal, number>>;
const code = (message: string) => message.normalize('NFKD').replace(/[^a-zA-Z0-9\s_]/g, '').trim().toUpperCase().replace(/\s+/g, '_').slice(0, 64) || 'ERROR';
const reason = 'Matrix human reviewed provider uncertainty';
const body = (value: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(value) });

function specs(f: MatrixReconciliationFixture): Spec[] {
  const query = async (sql: string, values: unknown[] = []) => (await f.queryStore(f.storeId, sql, values)).rows;
  const one = async (sql: string, values: unknown[] = []) => {
    const rows = await query(sql, values);
    if (rows.length !== 1) throw new Error('matrix reconciliation fixture expected exactly one row');
    return rows[0]!;
  };
  async function order(state: 'Paid' | 'Cancelled' = 'Paid', license = false) {
    const p = await f.seedProduct(), orderId = randomUUID(), lineId = randomUUID(), paymentId = randomUUID();
    const orderCode = 'MATRIX-' + randomUUID().toUpperCase(), providerRef = 'matrix-settled-' + randomUUID();
    const sku = (await one('SELECT sku FROM product_variant WHERE id=$1', [p.variantId])).sku;
    const productName = (await one('SELECT name FROM product WHERE id=$1', [p.productId])).name;
    if (license) await query("UPDATE product_variant SET fulfillment_type='license',app_key='matrix-recovery' WHERE id=$1", [p.variantId]);
    await query('UPDATE stock SET on_hand=20,allocated=2 WHERE variant_id=$1', [p.variantId]);
    await query(`INSERT INTO "order"(id,store_id,code,state,currency,subtotal,grand_total,placed_at,metadata)
      VALUES($1,$2,$3,$4,'USD',5000,5000,now(),'{}'::jsonb)`, [orderId, f.storeId, orderCode, state]);
    await query(`INSERT INTO order_line(id,store_id,order_id,variant_id,variant_sku,variant_name,quantity,unit_price,line_subtotal,line_total)
      VALUES($1,$2,$3,$4,$5,'Matrix recovery line',2,2500,5000,5000)`, [lineId, f.storeId, orderId, p.variantId, sku]);
    if (state === 'Paid') await query(`INSERT INTO payment(id,store_id,order_id,amount,method,state,currency,provider_ref,gateway_account,gateway_mode)
      VALUES($1,$2,$3,5000,'nmi','Settled','USD',$4,'matrix-account','test')`, [paymentId, f.storeId, orderId, providerRef]);
    return { ...p, orderId, code: orderCode, lineId, paymentId, providerRef, sku, productName };
  }
  async function heldEffect() {
    const o = await order('Paid', true), effectId = randomUUID(), editId = randomUUID();
    // One licence grant, backed by the existing settled cash ledger.
    await query('UPDATE order_line SET quantity=1,unit_price=5000 WHERE id=$1', [o.lineId]);
    await query(`INSERT INTO order_edit(id,store_id,order_id,"before","after",actor) VALUES($1,$2,$3,'{}'::jsonb,'{}'::jsonb,'matrix-agent@matrix.invalid')`, [editId, f.storeId, o.orderId]);
    await query(`INSERT INTO settlement_operation(store_id,operation_kind,operation_id,order_id,authorized_effects)
      VALUES($1,'order_edit_balance_settled',$2,$3,ARRAY['edit_reconcile'])`, [f.storeId, editId, o.orderId]);
    await query(`INSERT INTO order_pending_effect(id,store_id,operation_kind,operation_id,effect_kind,payload)
      VALUES($1,$2,'order_edit_balance_settled',$3,'edit_reconcile',$4::jsonb)`,
      [effectId, f.storeId, editId, JSON.stringify({ orderId: o.orderId, customerId: null, paidAt: new Date().toISOString(), actorKind: 'agent' })]);
    // Execute the real local handler to generate its terminal hold & admin_review task.
    registerBuiltinEffectHandlers();
    await withStore(f.storeId, tx => executeEffectsNow(tx, [effectId]));
    const held = await one('SELECT status,last_error FROM order_pending_effect WHERE id=$1', [effectId]);
    if (held.status !== 'terminal' || held.last_error !== 'AGENT_ISSUANCE_REFUSED') throw new Error('matrix reconciliation fixture did not reach genuine issuance hold');
    const review = await one("SELECT id FROM order_pending_effect WHERE operation_id=$1 AND effect_kind='admin_review'", [editId]);
    return { ...o, effectId, editId, reviewId: review.id };
  }
  const specs: Spec[] = [
    { key: 'POST /v1/admin/payment-reconciliation/{id}/verify', permission: 'refunds', group: 'settlement', async prepare() {
      const o = await order(), attemptId = randomUUID();
      // Durable settled NMI charge replay: verifyGatewayAttempt/finishAttempt explicitly skip provider retrieval.
      await query(`INSERT INTO payment_attempt(id,store_id,order_id,payment_id,operation,method,account_id,mode,amount,currency,idempotency_key,fingerprint,status,provider_ref,result)
        VALUES($1,$2,$3,$4,'charge','nmi','matrix-account','test',5000,'USD',$5,$5,'settled',$6,'{"state":"Paid","payment":"Settled"}'::jsonb)`,
        [attemptId, f.storeId, o.orderId, o.paymentId, randomUUID(), o.providerRef]);
      const calls = (await f.snapshot()).providerCalls;
      return { url: '/v1/admin/payment-reconciliation/' + attemptId + '/verify', init: body({}), async verify(response: Response, proof: MatrixProof) {
        const b = await response.json() as Json;
        proof.equal(b.attemptId, attemptId, 'verified existing durable attempt');
        proof.equal(b.status, 'settled', 'settled replay status');
        proof.equal(b.state, 'Paid', 'settled order response');
        const persisted = await one('SELECT status,payment_id,provider_ref FROM payment_attempt WHERE id=$1', [attemptId]);
        proof.equal(persisted, { status: 'settled', payment_id: o.paymentId, provider_ref: o.providerRef }, 'settled attempt linkage retained', 'state');
        const audit = await one("SELECT data FROM audit_log WHERE entity='payment_attempt' AND entity_id=$1 AND action='verify_gateway'", [attemptId]);
        proof.equal(audit.data.status, 'settled', 'operator verification audit committed', 'state');
        proof.equal((await f.snapshot()).providerCalls, calls, 'settled replay makes no provider request', 'state');
      } };
    } },
    { key: 'POST /v1/admin/payment-reconciliation/effects/{id}/approve-issuance', permission: 'refunds', group: 'entitlement', async prepare() {
      const o = await heldEffect();
      return { url: '/v1/admin/payment-reconciliation/effects/' + o.effectId + '/approve-issuance', init: body({}), async verify(response: Response, proof: MatrixProof) {
        const b = await response.json() as Json;
        proof.equal(b, { effectId: o.effectId, orderId: o.orderId, approved: true, alreadyApproved: false, status: 'done' }, 'held issuance approved');
        const effect = await one('SELECT status,payload,result FROM order_pending_effect WHERE id=$1', [o.effectId]);
        proof.equal(effect.status, 'done', 'approved effect committed done', 'state');
        proof.equal(effect.payload.actorKind, 'agent', 'original agent provenance preserved', 'state');
        proof.equal(effect.payload.issuanceApprovedBy.effectId, o.effectId, 'approval bound to effect', 'state');
        proof.equal(effect.payload.issuanceApprovedBy.orderId, o.orderId, 'approval bound to order', 'state');
        proof.equal(effect.result.issued, 1, 'exactly one entitlement issued', 'state');
        const licenses = await query('SELECT order_line_id,app_key,status FROM license WHERE order_id=$1', [o.orderId]);
        proof.equal(licenses.length, 1, 'one committed licence', 'state');
        proof.equal(licenses[0]!.order_line_id, o.lineId, 'licence linked to paid line', 'state');
        proof.equal(licenses[0]!.app_key, 'matrix-recovery', 'licence app identity', 'state');
        const review = await one('SELECT resolution FROM order_pending_effect WHERE id=$1', [o.reviewId]);
        proof.equal(review.resolution.action, 'approved_issuance', 'review task resolved atomically', 'state');
        const audit = await one("SELECT data FROM audit_log WHERE entity_id=$1 AND action='edit_issuance_approved'", [o.effectId]);
        proof.equal(audit.data.heldReason, 'AGENT_ISSUANCE_REFUSED', 'fresh approval retains original hold reason', 'state');
      } };
    } },
    { key: 'POST /v1/admin/payment-reconciliation/effects/{id}/retry', permission: 'refunds', group: 'settlement', async prepare() {
      const o = await heldEffect();
      return { url: '/v1/admin/payment-reconciliation/effects/' + o.effectId + '/retry', init: body({}), async verify(response: Response, proof: MatrixProof) {
        proof.equal(await response.json(), { queued: true }, 'terminal effect requeued');
        const effect = await one('SELECT status,attempts,claim_token,claimed_at,last_error,first_failed_at FROM order_pending_effect WHERE id=$1', [o.effectId]);
        proof.equal(effect, { status: 'pending', attempts: 0, claim_token: null, claimed_at: null, last_error: null, first_failed_at: null }, 'retry reset committed', 'state');
        proof.equal((await query('SELECT id FROM license WHERE order_id=$1', [o.orderId])).length, 0, 'retry alone grants no entitlement', 'state');
        const audit = await one("SELECT entity_id FROM audit_log WHERE entity_id=$1 AND action='effect_requeued'", [o.effectId]);
        proof.equal(audit.entity_id, o.effectId, 'retry audit committed', 'state');
      } };
    } },
    { key: 'POST /v1/admin/payment-reconciliation/events/{id}/retry', permission: 'refunds', group: 'settlement', async prepare() {
      const id = randomUUID(), providerRef = 'matrix-event-' + randomUUID();
      await query(`INSERT INTO gateway_event(id,store_id,method,account_id,mode,event_id,event_type,provider_ref,status,attempts,last_error,details)
        VALUES($1,$2,'nmi','matrix-account','test',$3,'payment.settled',$4,'manual',5,'matrix retry exhausted','{"source":"authenticated-fixture"}'::jsonb)`,
        [id, f.storeId, randomUUID(), providerRef]);
      return { url: '/v1/admin/payment-reconciliation/events/' + id + '/retry', init: body({}), async verify(response: Response, proof: MatrixProof) {
        proof.equal(await response.json(), { queued: true }, 'manual event requeued');
        const event = await one('SELECT status,attempts,last_error,provider_ref FROM gateway_event WHERE id=$1', [id]);
        proof.equal(event, { status: 'pending', attempts: 0, last_error: null, provider_ref: providerRef }, 'event retry committed with immutable provider identity', 'state');
      } };
    } },
    { key: 'POST /v1/admin/payment-reconciliation/orders/{code}/stripe-reconcile', permission: 'refunds', group: 'settlement', async prepare() {
      const o = await order(), id = randomUUID(), ref = 'pi_matrix_' + randomUUID();
      await query("UPDATE payment SET method='stripe',provider_ref=$2,gateway_account='stripe' WHERE id=$1", [o.paymentId, ref]);
      await query(`INSERT INTO payment_attempt(id,store_id,order_id,payment_id,operation,method,account_id,mode,amount,currency,idempotency_key,fingerprint,status,provider_ref)
        VALUES($1,$2,$3,$4,'intent','stripe','stripe','test',5000,'USD',$5,$5,'settled',$6)`,
        [id, f.storeId, o.orderId, o.paymentId, randomUUID(), ref]);
      // A tracked & fully settled intent needs neither discovery nor retrieval. The operator action is still audited.
      const calls = (await f.snapshot()).providerCalls;
      return { url: '/v1/admin/payment-reconciliation/orders/' + o.code + '/stripe-reconcile', init: body({}), async verify(response: Response, proof: MatrixProof) {
        proof.equal(await response.json(), { found: true, code: o.code, state: 'Paid', intents: [] }, 'durable settled Stripe order reconciled');
        const paid = await one('SELECT amount,state,provider_ref FROM payment WHERE id=$1', [o.paymentId]);
        proof.equal(paid, { amount: 5000, state: 'Settled', provider_ref: ref }, 'settled Stripe ledger preserved', 'state');
        const audit = await one("SELECT data FROM audit_log WHERE entity_id=$1 AND action='stripe_reconcile'", [o.code]);
        proof.equal(audit.data, { state: 'Paid', intents: [] }, 'operator reconciliation audit committed', 'state');
        proof.equal((await f.snapshot()).providerCalls, calls, 'fully reconciled order makes no provider request', 'state');
      } };
    } },
    { key: 'POST /v1/admin/payment-reconciliation/reservations/{id}/override-release', permission: 'refunds', group: 'entitlement', async prepare() {
      const o = await order('Cancelled'), id = randomUUID();
      await query(`INSERT INTO order_reservation(id,store_id,order_id,kind,owner_key,holder,state) VALUES($1,$2,$3,'matrix-resource',$4,$5::jsonb,'held')`,
        [id, f.storeId, o.orderId, randomUUID(), JSON.stringify({ variantId: o.variantId })]);
      return { url: '/v1/admin/payment-reconciliation/reservations/' + id + '/override-release', init: body({ reason }), async verify(response: Response, proof: MatrixProof) {
        proof.equal(await response.json(), { released: 1, orderId: o.orderId, reservationIds: [id] }, 'cancelled order reservation released');
        const row = await one('SELECT state,released_unverified,release_reason,released_at,provider_terminal_at FROM order_reservation WHERE id=$1', [id]);
        proof.equal(row.state, 'released', 'release committed', 'state');
        proof.equal(row.released_unverified, true, 'operator uncertainty recorded', 'state');
        proof.equal(row.release_reason, 'operator_override: ' + reason, 'operator reason retained', 'state');
        proof.ok(row.released_at instanceof Date && row.provider_terminal_at instanceof Date, 'terminal release timestamps committed', 'state');
        const audit = await one("SELECT data FROM audit_log WHERE entity_id=$1 AND action='reservation_override_release'", [o.orderId]);
        proof.equal(audit.data, { reservationIds: [id], reason }, 'release audit committed', 'state');
      } };
    } },
    { key: 'POST /v1/admin/import-tracking/preview', permission: 'write', async prepare() {
      const o = await order(), tracking = 'MATRIX-' + randomUUID().toUpperCase();
      return { url: '/v1/admin/import-tracking/preview', init: body({ rows: [{ code: o.code, tracking, carrier: 'UPS' }] }), async verify(response: Response, proof: MatrixProof) {
        const b = await response.json() as Json;
        proof.equal(b.summary, { total: 1, importable: 1, byStatus: { ready: 1 } }, 'real paid order is importable');
        proof.equal(b.rows[0].code, o.code, 'preview references store A order');
        proof.equal(b.rows[0].tracking, tracking, 'preview tracking');
        proof.equal(b.rows[0].items, [{ sku: o.sku, name: `${o.productName} · Matrix recovery line`, quantity: 2 }], 'preview shippable units');
        proof.equal((await query('SELECT id FROM fulfillment WHERE order_id=$1', [o.orderId])).length, 0, 'preview creates no fulfillment', 'state');
        proof.equal((await one('SELECT fulfilled_qty FROM order_line WHERE id=$1', [o.lineId])).fulfilled_qty, 0, 'preview preserves line quantity', 'state');
        proof.equal(await one('SELECT on_hand,allocated FROM stock WHERE variant_id=$1', [o.variantId]), { on_hand: 20, allocated: 2 }, 'preview preserves stock', 'state');
      } };
    } },
    { key: 'POST /v1/admin/import-tracking', permission: 'write', async prepare() {
      const o = await order(), tracking = 'MATRIX-' + randomUUID().toUpperCase();
      return { url: '/v1/admin/import-tracking', init: body({ rows: [{ code: o.code, tracking, carrier: 'UPS' }], notify: false, source: 'grid' }), async verify(response: Response, proof: MatrixProof) {
        const b = await response.json() as Json;
        proof.equal(b.updated, 1, 'one existing order shipped');
        proof.equal(b.errors, [], 'valid tracking import succeeds');
        proof.equal(b.skipped, 0, 'no import skipped');
        proof.equal(b.emailsQueued, 0, 'notify false queues no email');
        proof.equal(b.rows[0].code, o.code, 'imported store A order');
        proof.equal(b.rows[0].imported, true, 'row committed');
        const shipped = await one('SELECT id,state,tracking_code,carrier FROM fulfillment WHERE order_id=$1', [o.orderId]);
        proof.equal(shipped.state, 'Shipped', 'fulfillment committed shipped', 'state');
        proof.equal(shipped.tracking_code, tracking, 'tracking persisted', 'state');
        proof.equal(shipped.carrier, 'UPS', 'carrier persisted', 'state');
        const line = await one('SELECT fulfilled_qty FROM order_line WHERE id=$1', [o.lineId]);
        proof.equal(line.fulfilled_qty, 2, 'line shipment committed', 'state');
        proof.equal(await one('SELECT on_hand,allocated FROM stock WHERE variant_id=$1', [o.variantId]), { on_hand: 18, allocated: 0 }, 'physical stock consumed once', 'state');
        const movement = await one("SELECT delta,ref_order_id FROM stock_movement WHERE variant_id=$1 AND reason='fulfillment'", [o.variantId]);
        proof.equal(movement, { delta: -2, ref_order_id: o.orderId }, 'shipment stock movement committed', 'state');
        const audit = await one("SELECT data FROM audit_log WHERE entity='tracking_import' AND entity_id=$1 AND action='batch'", [b.batchId]);
        proof.equal(audit.data.shipped, 1, 'batch audit committed', 'state');
      } };
    } },
    { key: 'POST /v1/admin/jobs/auto-deliver', permission: 'write', async prepare() {
      const o = await order(), fulfillmentId = randomUUID(), tracking = 'MATRIX-DELIVER-' + randomUUID();
      await query(`INSERT INTO fulfillment(id,store_id,order_id,state,tracking_code,carrier,created_at,updated_at)
        VALUES($1,$2,$3,'Shipped',$4,'UPS','2000-01-01T00:00:00Z','2000-01-01T00:00:00Z')`, [fulfillmentId, f.storeId, o.orderId, tracking]);
      await query(`INSERT INTO fulfillment_line(store_id,fulfillment_id,order_line_id,quantity) VALUES($1,$2,$3,2)`, [f.storeId, fulfillmentId, o.lineId]);
      await query('UPDATE order_line SET fulfilled_qty=2 WHERE id=$1', [o.lineId]);
      return { url: '/v1/admin/jobs/auto-deliver', init: body({ dryRun: false, days: 10 }), async verify(response: Response, proof: MatrixProof) {
        const b = await response.json() as Json;
        proof.equal(b.dryRun, false, 'operator requested committed delivery');
        proof.equal(b.days, 10, 'delivery threshold');
        proof.ok(Number.isInteger(b.count) && b.count >= 1, 'old shipment processed');
        const row = await one('SELECT state,tracking_code FROM fulfillment WHERE id=$1', [fulfillmentId]);
        proof.equal(row, { state: 'Delivered', tracking_code: tracking }, 'existing shipment committed delivered', 'state');
        const audit = await one("SELECT to_state FROM audit_log WHERE entity_id=$1 AND action='auto_delivered'", [o.orderId]);
        proof.equal(audit.to_state, 'Delivered', 'delivery transition audited', 'state');
      } };
    } },
  ];
  return specs;
}

function deniedMessage(f: MatrixReconciliationFixture, spec: Spec, principal: MatrixPrincipal): string {
  if (principal === 'foreign_store') return 'no access to store: ' + f.storeSlug;
  if (principal === 'cache_token') return 'not authenticated';
  if (principal === 'release_service') return 'invalid or expired session';
  if (principal === 'agent') return spec.group === 'entitlement'
    ? 'agents cannot issue, revoke or release entitlements' : 'agents cannot re-drive settlement or reconciliation';
  if (principal === 'read_only') return "role 'read_only' is read-only";
  return "role 'staff' lacks the 'refunds' permission";
}

// admin-agent-guard.ts rejects unresolved machine bearers with the explicit
// NOT_AUTHENTICATED code, independently of its invalid-session message;
// requireAdmin's missing-session denial uses that same authentication code.
function expectedDenialCode(principal: MatrixPrincipal, message: string): string {
  if (principal === 'release_service' || principal === 'cache_token') return 'NOT_AUTHENTICATED';
  if (principal === 'agent') return 'AGENT_NOT_ALLOWED';
  return code(message);
}

export function createReconciliationCases(f: MatrixReconciliationFixture): MatrixCase[] {
  return specs(f).map((spec): MatrixCase => {
    const make = (principal: MatrixPrincipal): MatrixCell => {
      const status = STATUS[spec.permission][principal], allow = status === 200;
      const message = allow ? '' : deniedMessage(f, spec, principal);
      return { effect: allow ? 'allow' : 'deny', status,
        ...(!allow ? { errorCode: expectedDenialCode(principal, message) } : {}),
        async prepare() {
          const prepared = await spec.prepare();
          const init = { ...prepared.init, method: 'POST', headers: { ...f.requestHeaders[principal], 'content-type': 'application/json' } };
          if (allow) return { ...prepared, init };
          return { url: prepared.url, init, snapshot: f.snapshotFor(principal, 'POST', prepared.url, status, principal === 'agent' ? spec.group : undefined),
            async verify(response: Response, proof: MatrixProof) {
              const b = await response.json() as Json;
              proof.equal(b.error.code, expectedDenialCode(principal, message), 'exact authorization denial code');
              proof.equal(b.error.message, message, 'exact authorization denial reason');
            } };
        },
      };
    };
    return { key: spec.key, contract: 'admin', cells: {
      owner: make('owner'), manager: make('manager'), staff: make('staff'), read_only: make('read_only'),
      agent: make('agent'), foreign_store: make('foreign_store'), release_service: make('release_service'), cache_token: make('cache_token'),
    } };
  });
}

/** Explicit granted-staff positive controls distinguish refunds permission from owner/manager role. */
export async function prepareReconciliationGrantedControls(f: MatrixReconciliationFixture): Promise<PreparedMatrixCell[]> {
  const controls: PreparedMatrixCell[] = [];
  for (const spec of specs(f).filter(s => s.permission === 'refunds')) {
    const prepared = await spec.prepare();
    controls.push({ ...prepared, init: { ...prepared.init, method: 'POST', headers: { ...f.positiveControls.grantedStaff, 'content-type': 'application/json' } },
      async verify(response: Response, proof: MatrixProof) {
        proof.equal(response.status, 200, 'explicit refunds grant permits operator reconciliation');
        await prepared.verify(response, proof);
      } });
  }
  return controls;
}
