/** Real provider-signature contracts; synthetic encrypted credentials, no provider I/O. */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { encryptSecret } from '../security/secret-crypto.js';
import type { MatrixIdentityFixture } from './authorization-matrix.identity-cases.testkit.js';
import type { MatrixCase, MatrixCell, MatrixPrincipal, MatrixProof, PreparedMatrixCell } from './authorization-matrix.testkit.js';

type Provider = 'nmi' | 'sezzle' | 'stripe';
type SignedCase = MatrixCase & { signatureControl?: () => Promise<PreparedMatrixCell> };
type SignatureCell = MatrixCell & { signatureFailure?: 'stripe' };
type Target = {
  provider: Provider; key: string; url: string; raw: string; eventId: string; eventType: string;
  orderId: string; orderCode: string; paymentId: string; attemptId: string; providerRef: string;
  disputeRef: string; recipient: string; ledgerBefore: unknown;
};
interface WebhookFixture extends MatrixIdentityFixture {}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const hmac = (key: string, value: string) => createHmac('sha256', key).update(value).digest('hex');
const body = (response: Response) => response.json() as Promise<Record<string, any>>;
const cells = (make: (principal: MatrixPrincipal) => SignatureCell): Record<MatrixPrincipal, SignatureCell> => ({
  owner: make('owner'), manager: make('manager'), staff: make('staff'), read_only: make('read_only'),
  agent: make('agent'), foreign_store: make('foreign_store'), release_service: make('release_service'), cache_token: make('cache_token'),
});

/** One target is shared by all eight denied credentials & its genuine-signature control. */
export function createWebhookCases(fixture: WebhookFixture): SignedCase[] {
  const targets = new Map<Provider, Promise<Target>>();
  const rows = async (sql: string, values: unknown[] = []) => (await fixture.queryStore(fixture.storeId, sql, values)).rows;
  const ledger = async (target: Pick<Target, 'orderId' | 'paymentId' | 'attemptId'>) => ({
    orders: await rows('SELECT * FROM "order" WHERE id=$1', [target.orderId]),
    payments: await rows('SELECT * FROM payment WHERE id=$1', [target.paymentId]),
    attempts: await rows('SELECT * FROM payment_attempt WHERE id=$1', [target.attemptId]),
    refunds: await rows('SELECT * FROM refund WHERE order_id=$1 ORDER BY id', [target.orderId]),
  });
  const secret = async (provider: Provider, mode: string, field: string, plaintext: string) => {
    const sealed = encryptSecret(plaintext, { purpose: `store:${fixture.storeId}:${provider}:${mode}:${field}` });
    await rows(`INSERT INTO store_secret (store_id,provider,mode,field,key_version,iv,ciphertext,auth_tag,last4,updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'authorization-matrix')
      ON CONFLICT (store_id,provider,mode,field) DO UPDATE SET key_version=EXCLUDED.key_version,iv=EXCLUDED.iv,
      ciphertext=EXCLUDED.ciphertext,auth_tag=EXCLUDED.auth_tag,last4=EXCLUDED.last4,updated_at=now()`,
      [fixture.storeId, provider, mode, field, sealed.v, sealed.iv, sealed.ct, sealed.tag, plaintext.slice(-4)]);
  };
  const target = (provider: Provider): Promise<Target> => {
    let pending = targets.get(provider);
    if (!pending) {
      pending = (async () => {
        const id = randomUUID(), orderId = randomUUID(), paymentId = randomUUID(), attemptId = randomUUID();
        const key = randomBytes(32).toString('hex'), eventId = 'matrix_event_' + id;
        const providerRef = (provider === 'stripe' ? 'pi_' : 'matrix_payment_') + id.replace(/-/g, '');
        const disputeId = 'matrix_dispute_' + id, orderCode = 'MXWH' + id.replace(/-/g, '').slice(0, 16);
        const recipient = 'webhook-' + id + '@example.invalid';
        await rows(`UPDATE store SET config=COALESCE(config,'{}'::jsonb) || jsonb_build_object(
          'stripe',COALESCE(config->'stripe','{}'::jsonb) || '{"mode":"test"}'::jsonb,
          'notifications',COALESCE(config->'notifications','{}'::jsonb) || jsonb_build_object('disputeEmail',$2::text)) WHERE id=$1`, [fixture.storeId, recipient]);
        if (provider === 'stripe') await secret(provider, 'test', 'webhookSecret', key);
        else {
          await secret(provider, 'test', provider === 'nmi' ? 'securityKey' : 'publicKey', randomBytes(24).toString('hex'));
          await secret(provider, 'test', 'privateKey', key);
        }
        await rows(`INSERT INTO "order" (id,store_id,code,state,currency,subtotal,grand_total,metadata)
          VALUES ($1,$2,$3,'Paid','USD',4200,4200,'{}'::jsonb)`, [orderId, fixture.storeId, orderCode]);
        await rows(`INSERT INTO payment (id,store_id,order_id,amount,currency,method,provider_ref,state,gateway_account,gateway_mode,metadata)
          VALUES ($1,$2,$3,4200,'USD',$4,$5,'Settled',$6,'test','{}'::jsonb)`,
          [paymentId, fixture.storeId, orderId, provider, providerRef, provider === 'stripe' ? null : 'db']);
        await rows(`INSERT INTO payment_attempt (id,store_id,order_id,payment_id,operation,method,account_id,mode,amount,currency,
          idempotency_key,fingerprint,status,provider_ref,context,result)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'test',4200,'USD',$8,$9,'settled',$10,'{}'::jsonb,'{}'::jsonb)`,
          [attemptId, fixture.storeId, orderId, paymentId, provider === 'stripe' ? 'intent' : 'capture', provider,
            provider === 'stripe' ? 'stripe' : 'db', 'matrix_webhook:' + id, digest(id), providerRef]);
        const eventType = provider === 'nmi' ? 'chargeback.batch.complete' : provider === 'sezzle' ? 'dispute.merchant_input_requested' : 'charge.dispute.created';
        const payload = provider === 'nmi'
          ? { event_id: eventId, event_type: eventType, event_body: { chargebacks: [{ id: providerRef, amount: '42.00', reason: 'fraudulent' }] } }
          : provider === 'sezzle'
            ? { uuid: eventId, event: eventType, data_type: 'dispute', data: { dispute_id: disputeId, order_uuid: providerRef,
              order_reference_id: attemptId, dispute_type: 'fraud', dispute_status: 'merchant_input_requested',
              dispute_amount_in_cents: 4200, dispute_currency: 'USD', dispute_due_date: '2026-11-01' } }
            : { id: eventId, object: 'event', type: eventType, created: Math.floor(Date.now() / 1000), livemode: false,
              data: { object: { id: disputeId, object: 'dispute', payment_intent: providerRef, amount: 4200, currency: 'usd',
                reason: 'fraudulent', status: 'needs_response', metadata: { storeId: fixture.storeId } } } };
        const result: Target = { provider, key, url: provider === 'stripe' ? '/v1/webhooks/stripe' : `/v1/webhooks/${provider}/${fixture.storeId}/db`,
          raw: JSON.stringify(payload), eventId, eventType, orderId, orderCode, paymentId, attemptId, providerRef,
          disputeRef: provider === 'nmi' ? providerRef : provider === 'sezzle' ? `sezzle:${providerRef}:${disputeId}` : disputeId,
          recipient, ledgerBefore: undefined };
        result.ledgerBefore = await ledger(result);
        return result;
      })();
      targets.set(provider, pending);
    }
    return pending;
  };
  const init = (t: Target, key: string, supplied: Record<string, string> = {}): RequestInit => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = t.provider === 'sezzle' ? hmac(key, t.raw) : hmac(key, timestamp + '.' + t.raw);
    const header = t.provider === 'nmi' ? 'webhook-signature' : t.provider === 'sezzle' ? 'sezzle-signature' : 'stripe-signature';
    return { method: 'POST', headers: { ...supplied, 'content-type': 'application/json',
      [header]: t.provider === 'nmi' ? `t=${timestamp},s=${signature}` : t.provider === 'stripe' ? `t=${timestamp},v1=${signature}` : signature }, body: t.raw };
  };
  const verifySigned = async (t: Target, response: Response, proof: MatrixProof) => {
    proof.equal(await body(response), t.provider === 'nmi' ? { received: true, recorded: 1, skipped: 0 } : { received: true }, 'exact signed event acknowledgement');
    const disputes = await rows(`SELECT id,provider,provider_ref,gateway_account,gateway_mode,payment_id,order_id,amount,currency,reason,status,details,
      notified_at IS NOT NULL AS notified FROM dispute WHERE provider=$1 AND provider_ref=$2`, [t.provider, t.disputeRef]);
    proof.equal(disputes.length, 1, 'one canonical dispute', 'state');
    const dispute = disputes[0]!;
    const processedId = t.provider === 'nmi' ? 'nmi:v2:' + digest(JSON.stringify(['nmi-event-v2', fixture.storeId, 'db', 'test', t.eventId])) : t.eventId;
    proof.equal({ ...dispute, id: undefined }, { id: undefined, provider: t.provider, provider_ref: t.disputeRef,
      gateway_account: t.provider === 'nmi' ? 'db' : null, gateway_mode: t.provider === 'nmi' ? 'test' : null,
      payment_id: t.paymentId, order_id: t.orderId, amount: 4200, currency: t.provider === 'sezzle' ? 'USD' : null,
      reason: t.provider === 'sezzle' ? 'fraud' : 'fraudulent', status: t.provider === 'sezzle' ? 'merchant_input_requested' : t.provider === 'stripe' ? 'needs_response' : 'open',
      details: t.provider === 'nmi' ? { eventId: t.eventId } : t.provider === 'sezzle'
        ? { eventId: t.eventId, eventType: t.eventType, dueDate: '2026-11-01' } : null, notified: true }, 'exact authenticated dispute identity & existing payment linkage', 'state');
    const audit = await rows(`SELECT actor,entity,entity_id,action,data FROM audit_log WHERE entity_id=$1 AND action='dispute_opened'`, [t.orderId]);
    proof.equal(audit, [{ actor: t.provider + ':webhook', entity: 'order', entity_id: t.orderId, action: 'dispute_opened',
      data: { provider: t.provider, providerRef: t.disputeRef, ...(t.provider === 'nmi' ? { gatewayAccount: 'db', gatewayMode: 'test', disputeRecordId: dispute.id } : {}),
        amount: 4200, reason: t.provider === 'sezzle' ? 'fraud' : 'fraudulent', orderCode: t.orderCode } }], 'provider provenance in canonical audit', 'state');
    const dedupeKey = t.provider === 'nmi' ? `dispute_alert:nmi:v2:${dispute.id}:${t.recipient}` : `dispute_alert:${t.provider}:${t.disputeRef}:${t.recipient}`;
    const outbox = await rows('SELECT kind,recipient,status,attempts,payload,dedupe_key FROM email_outbox WHERE dedupe_key=$1', [dedupeKey]);
    proof.equal(outbox.length, 1, 'one transactional operator notification', 'state');
    proof.equal({ kind: outbox[0]!.kind, recipient: outbox[0]!.recipient, status: outbox[0]!.status, attempts: outbox[0]!.attempts, dedupe_key: outbox[0]!.dedupe_key },
      { kind: 'dispute_alert', recipient: t.recipient, status: 'pending', attempts: 0, dedupe_key: dedupeKey }, 'notification remains queued locally', 'state');
    proof.equal(outbox[0]!.payload.to, t.recipient, 'exact notification recipient', 'state');
    proof.ok(outbox[0]!.payload.text.includes(t.disputeRef) && outbox[0]!.payload.text.includes(t.orderCode), 'notification identifies authentic provider dispute & order', 'state');
    if (t.provider === 'sezzle') {
      const events = await rows(`SELECT method,account_id,mode,event_id,event_type,provider_ref,status,attempts,details FROM gateway_event WHERE event_id=$1`, [t.eventId]);
      proof.equal(events.length, 1, 'one authenticated durable gateway event', 'state');
      const event = events[0]!, receivedAt = event.details.receivedAt;
      proof.ok(typeof receivedAt === 'string' && Number.isFinite(Date.parse(receivedAt)), 'durable gateway receipt timestamp', 'state');
      proof.equal({ ...event, details: { ...event.details, receivedAt: undefined } }, { method: 'sezzle', account_id: 'db', mode: 'test', event_id: t.eventId,
        event_type: t.eventType, provider_ref: t.providerRef, status: 'pending', attempts: 0, details: { receivedAt: undefined, dataType: 'dispute',
          orderUuid: t.providerRef, referenceId: t.attemptId, dispute: { disputeId: t.disputeRef.split(':').at(-1), orderUuid: t.providerRef,
            orderReferenceId: t.attemptId, disputeType: 'fraud', disputeStatus: 'merchant_input_requested', amountInCents: 4200, currency: 'USD', dueDate: '2026-11-01' } } }, 'signed account/mode & normalized dispute journal', 'state');
    } else proof.equal(await rows('SELECT id,type FROM processed_event WHERE id=$1', [processedId]), [{ id: processedId, type: t.eventType }], 'exact processed provider event receipt', 'state');
    proof.equal(await ledger(t), t.ledgerBefore, 'disputes preserve settled money, order & provider attempt', 'state');
    if (t.provider === 'stripe') {
      const operationId = 'stripe_dispute:' + t.disputeRef;
      proof.equal(await rows('SELECT operation_kind,operation_id,order_id FROM settlement_operation WHERE operation_id=$1', [operationId]),
        [{ operation_kind: 'dispute_opened', operation_id: operationId, order_id: t.orderId }], 'one authenticated dispute settlement operation', 'state');
      proof.equal(await rows('SELECT operation_kind,operation_id,effect_kind,payload,status,attempts FROM order_pending_effect WHERE operation_id=$1', [operationId]),
        [{ operation_kind: 'dispute_opened', operation_id: operationId, effect_kind: 'entitlement_reversal', payload: { orderId: t.orderId, reason: 'chargeback' }, status: 'pending', attempts: 0 }], 'exact authorized entitlement reversal queued without execution', 'state');
    } else proof.equal(await rows('SELECT id FROM settlement_operation WHERE order_id=$1', [t.orderId]), [], 'gateway dispute records authorize no automatic money operation', 'state');
    const beforeReplay = structuredClone(await fixture.snapshot());
    const replay = await fixture.request(t.url, init(t, t.key));
    proof.equal(replay.status, 200, 'authenticated replay accepted');
    proof.equal(await body(replay), { received: true }, 'replay acknowledgement');
    proof.equal(await fixture.snapshot(), beforeReplay, 'authenticated replay changes no domain, journal, outbox, file or provider state', 'state');
  };
  const configure = async (t: Target) => {
    // Other route fixtures share this store; re-establish configured credentials before every request snapshot.
    await rows(`UPDATE store SET config=COALESCE(config,'{}'::jsonb) || jsonb_build_object(
      'stripe',COALESCE(config->'stripe','{}'::jsonb) || '{"mode":"test"}'::jsonb,
      'notifications',COALESCE(config->'notifications','{}'::jsonb) || jsonb_build_object('disputeEmail',$2::text)) WHERE id=$1`, [fixture.storeId, t.recipient]);
    if (t.provider === 'stripe') await secret(t.provider, 'test', 'webhookSecret', t.key);
    else {
      await secret(t.provider, 'test', t.provider === 'nmi' ? 'securityKey' : 'publicKey', 'matrix-public-' + t.providerRef);
      await secret(t.provider, 'test', 'privateKey', t.key);
    }
  };
  const control = async (provider: Provider): Promise<PreparedMatrixCell> => {
    const t = await target(provider);
    await configure(t);
    return { url: t.url, init: init(t, t.key), verify: (response, proof) => verifySigned(t, response, proof) };
  };
  return (['nmi', 'sezzle', 'stripe'] as const).map((provider): SignedCase => ({
    key: provider === 'stripe' ? 'POST /v1/webhooks/stripe' : `POST /v1/webhooks/${provider}/{storeId}/{accountId}`,
    contract: 'webhook',
    signatureControl: () => control(provider),
    cells: cells(principal => ({ effect: 'deny', status: provider === 'stripe' ? 400 : 401,
      ...(provider === 'stripe' ? { signatureFailure: 'stripe' as const } : {}),
      async prepare() {
        const t = await target(provider);
        await configure(t);
        return { url: t.url, init: init(t, 'wrong-key-' + t.key, fixture.requestHeaders[principal]), snapshot: fixture.snapshot,
          async verify(response, proof) {
            proof.equal(await body(response), { error: provider === 'stripe' ? 'bad signature' : provider === 'sezzle' ? 'Invalid signature' : 'invalid signature' },
              'supplied admin credential cannot authenticate provider HMAC');
          } };
      },
    })),
  }));
}

/** For runners predating signatureControl: execute genuine signatures after all denial cells. */
export async function runWebhookControls(fixture: WebhookFixture, cases: readonly SignedCase[]): Promise<void> {
  for (const route of cases) {
    if (!route.signatureControl) throw new Error('webhook case lacks genuine signature control');
    const prepared = await route.signatureControl(), response = await fixture.request(prepared.url, prepared.init, prepared.env);
    assert.equal(response.status, 200, route.key + ': genuine signature status');
    await prepared.verify(response, {
      equal(actual, expected, label) { assert.deepEqual(actual, expected, route.key + ': ' + label); },
      ok(condition, label): asserts condition { assert.ok(condition, route.key + ': ' + label); },
    });
  }
}
