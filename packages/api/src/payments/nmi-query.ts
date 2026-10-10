import { DOMParser, type Element } from '@xmldom/xmldom';
import { boundedGatewayResponse, gatewayIdentity, nmiEnvironment, type GatewayAccount, type GatewayFetch } from './gateway-account.js';
import type { PaymentResult } from './provider.js';

type Query = { account: GatewayAccount; orderReference: string; providerRef?: string | null; amount: number; currency: string; operation?: 'charge' | 'refund' };
const unresolved = (ref: string | null, reason: string): PaymentResult => ({
  state: 'Pending', providerRef: ref, metadata: { needsReconciliation: true, reason },
  errorMessage: 'NMI transaction requires reconciliation',
});
function children(parent: Element, name: string): Element[] {
  return Array.from(parent.childNodes).filter((n): n is Element => n.nodeType === 1 && n.nodeName === name);
}
function value(parent: Element, name: string): string {
  const nodes = children(parent, name);
  if (nodes.length > 1) throw new Error('Duplicate NMI field');
  return nodes[0]?.textContent?.trim() ?? '';
}
function cents(raw: string): number {
  if (!/^\d+\.\d{2}$/.test(raw)) throw new Error('Invalid NMI amount');
  const result = Number(raw.replace('.', ''));
  if (!Number.isSafeInteger(result)) throw new Error('Invalid NMI amount');
  return result;
}
/** Strictly read-only. Missing results are not proof that the sale failed. */
export function verifyNmiQuery(xml: string, input: Query): PaymentResult {
  const fallback = input.providerRef ?? null;
  try {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || Buffer.byteLength(xml) > 1048576) throw new Error('Invalid XML');
    const doc = new DOMParser({ onError: () => { throw new Error('Invalid NMI XML'); } })
      .parseFromString(xml, 'text/xml');
    const root = doc.documentElement;
    if (!root || root.tagName !== 'nm_response') throw new Error('Invalid NMI response');
    const transactions = children(root, 'transaction');
    if (transactions.length !== 1) return unresolved(fallback, 'missing_or_duplicate_transaction');
    const transaction = transactions[0]!;
    const ref = value(transaction, 'transaction_id');
    if (!ref || value(transaction, 'order_id') !== input.orderReference ||
        (input.providerRef && ref !== input.providerRef) || value(transaction, 'currency') !== input.currency) {
      return unresolved(fallback, 'identity_mismatch');
    }
    const actions = children(transaction, 'action').map(action => ({
      type: value(action, 'action_type'), success: value(action, 'success') === '1',
      amount: cents(value(action, 'amount')),
    }));
    const charged = actions.filter(a => a.success && ['sale', 'capture'].includes(a.type));
    const reversals = actions.filter(a => a.success && ['refund', 'void', 'return', 'credit'].includes(a.type));
    if (input.operation === 'refund') {
      const refunds = actions.filter(a => a.success && ['refund', 'return', 'credit'].includes(a.type));
      if (refunds.length !== 1 || refunds[0]!.amount !== input.amount || charged.length ||
          !['complete', 'pendingsettlement'].includes(value(transaction, 'condition'))) {
        return unresolved(ref, 'refund_not_confirmed');
      }
      return { state: 'Settled', providerRef: ref, metadata: { gateway: gatewayIdentity(input.account) } };
    }
    if (reversals.length) return unresolved(ref, 'reversal_requires_ledger_reconciliation');
    const condition = value(transaction, 'condition');
    if (charged.length === 0 && ['failed', 'abandoned', 'canceled'].includes(condition)) {
      return { state: 'Failed', providerRef: ref, metadata: { gateway: gatewayIdentity(input.account), condition } };
    }
    if (charged.length !== 1 || charged[0]!.amount !== input.amount) return unresolved(ref, 'amount_or_action_mismatch');
    if (input.account.mode === 'live' && (['N', 'C'].includes(value(transaction, 'avs_response')) ||
        value(transaction, 'csc_response') === 'N')) return unresolved(ref, 'card_verification_reversal_required');
    if (!['complete', 'pendingsettlement'].includes(condition)) return unresolved(ref, 'transaction_not_captured');
    return { state: 'Settled', providerRef: ref, metadata: { gateway: gatewayIdentity(input.account), condition } };
  } catch { return unresolved(fallback, 'invalid_query_response'); }
}

/** NMI charge label from the verified query result: only an identity-matched
 *  transaction reaches here. */
export function nmiObservedLabel(result: { state: string; metadata?: unknown }): string {
  if (result.state === 'Settled') return 'settled';
  if (result.state === 'Failed') return 'failed';
  const reason = (result.metadata as { reason?: string } | null | undefined)?.reason;
  return `unresolved:${reason ?? 'pending'}`;
}

/**
 * De-fork 2.9: the provider-side `condition` of THE transaction this query
 * identifies, or null when the response does not identify exactly this
 * attempt's transaction (zero/duplicate transactions, identity mismatch,
 * malformed XML). Pure; used only to advance payment_attempt.provider_status
 * after a successful retrieval.
 */
export function readNmiObservation(xml: string, input: Query): string | null {
  try {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || Buffer.byteLength(xml) > 1048576) return null;
    const doc = new DOMParser({ onError: () => { throw new Error('Invalid NMI XML'); } })
      .parseFromString(xml, 'text/xml');
    const root = doc.documentElement;
    if (!root || root.tagName !== 'nm_response') return null;
    const transactions = children(root, 'transaction');
    if (transactions.length !== 1) return null;
    const transaction = transactions[0]!;
    const ref = value(transaction, 'transaction_id');
    if (!ref || value(transaction, 'order_id') !== input.orderReference ||
        (input.providerRef && ref !== input.providerRef) || value(transaction, 'currency') !== input.currency) return null;
    return value(transaction, 'condition') || 'unknown';
  } catch { return null; }
}

/** queryNmiPayment plus the observed provider status (null = no successful, attempt-bound retrieval). */
export async function queryNmiPaymentObserved(
  input: Query, transport: GatewayFetch = fetch,
): Promise<{ result: PaymentResult; observedStatus: string | null }> {
  try {
    if (input.account.method !== 'nmi' || !input.account.securityKey || !input.orderReference) throw new Error('Missing query context');
    const body = new URLSearchParams({ security_key: input.account.securityKey,
      order_id: input.orderReference, result_limit: '2',
      ...(input.providerRef ? { transaction_id: input.providerRef } : {}) });
    const environment = nmiEnvironment(input.account);
    if (input.account.mode === 'live' && environment !== 'production') throw new Error('Invalid NMI live environment');
    const host = environment === 'sandbox' ? 'https://sandbox.nmi.com' : 'https://secure.nmi.com';
    const response = await transport(host + '/api/query.php', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(), signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    const xml = await boundedGatewayResponse(response);
    const result = verifyNmiQuery(xml, input);
    // Identity gate first (null = response is not this attempt's transaction),
    // then the normalised 4.6 label from the verified result.
    return { result, observedStatus: readNmiObservation(xml, input) === null ? null : nmiObservedLabel(result) };
  } catch { return { result: unresolved(input.providerRef ?? null, 'query_unavailable'), observedStatus: null }; }
}

export async function queryNmiPayment(input: Query, transport: GatewayFetch = fetch): Promise<PaymentResult> {
  return (await queryNmiPaymentObserved(input, transport)).result;
}
