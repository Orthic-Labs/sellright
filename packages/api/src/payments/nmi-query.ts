import { DOMParser, type Element } from '@xmldom/xmldom';
import { boundedGatewayResponse, gatewayIdentity, type GatewayAccount, type GatewayFetch } from './gateway-account.js';
import type { PaymentResult } from './provider.js';

type Query = { account: GatewayAccount; orderReference: string; providerRef?: string | null; amount: number; currency: string };
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

export async function queryNmiPayment(input: Query, transport: GatewayFetch = fetch): Promise<PaymentResult> {
  try {
    if (input.account.method !== 'nmi' || !input.account.securityKey || !input.orderReference) throw new Error('Missing query context');
    const body = new URLSearchParams({ security_key: input.account.securityKey,
      order_id: input.orderReference, result_limit: '2',
      ...(input.providerRef ? { transaction_id: input.providerRef } : {}) });
    const host = input.account.mode === 'test' ? 'https://sandbox.nmi.com' : 'https://secure.nmi.com';
    const response = await transport(host + '/api/query.php', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(), signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    return verifyNmiQuery(await boundedGatewayResponse(response), input);
  } catch { return unresolved(input.providerRef ?? null, 'query_unavailable'); }
}
