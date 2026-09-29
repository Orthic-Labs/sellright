import type { PaymentProvider, PaymentResult, RefundInput } from './provider.js';
import { err as logErr } from '../lib/logger.js';
import {
  boundedGatewayResponse, gatewayIdentity, validGatewayInput, nmiEnvironment,
  type GatewayAccount, type GatewayFetch,
} from './gateway-account.js';

const AVS_REJECT = new Set(['N', 'C']);
const CVV_REJECT = new Set(['N']);
const SETTLED_ERROR = /settled|batch|too late|original transaction not found/i;
const CONFIG_FAULT = /authentication failed|security_key|merchant inactive/i;
const DUPLICATE = /duplicate/i;
/** Shopper-facing copy. Gateway response text stays in metadata only (it can
 *  leak processor/fraud-rule detail); parity with the storefront's generic
 *  "try a different card" message. */
export const NMI_DECLINE_MESSAGE = 'Payment declined. Please try a different card or payment method.';
export const NMI_DUPLICATE_MESSAGE = 'Duplicate transaction detected. Please try again.';
export const NMI_VERIFICATION_MESSAGE = 'Payment rejected: the card address or security code did not match. Please check your details or use a different card.';
function configFault(text: string | null, where: string) {
  if (text && CONFIG_FAULT.test(text)) logErr.error('NMI CONFIG FAULT', undefined, { where, responseText: text.slice(0, 200) });
}

function unknownPayment(providerRef: string | null, reason: string): PaymentResult {
  return {
    state: 'Pending', providerRef, errorMessage: 'Payment requires reconciliation',
    metadata: { needsReconciliation: true, reason },
  };
}

export function createNmiProvider(transport: GatewayFetch = fetch): PaymentProvider {
  async function transact(account: GatewayAccount, values: Record<string, string>): Promise<URLSearchParams> {
    if (!account.securityKey) throw new Error('NMI security key is not configured');
    const environment = nmiEnvironment(account);
    if (account.mode === 'live' && environment !== 'production') throw new Error('Invalid NMI live environment');
    const base = environment === 'sandbox' ? 'https://sandbox.nmi.com' : 'https://secure.nmi.com';
    const body = new URLSearchParams({ ...values, security_key: account.securityKey });
    // Existing merchant accounts support per-transaction testing on the production host.
    if (account.mode === 'test' && environment === 'production') body.set('test_mode', 'enabled');
    const response = await transport(base + '/api/transact.php', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(), signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    const result = new URLSearchParams(await boundedGatewayResponse(response));
    if (!['1', '2', '3'].includes(result.get('response') ?? '')) throw new Error('Invalid NMI response');
    return result;
  }

  async function refund(input: RefundInput) {
    if (!validGatewayInput(input, 'nmi') || !input.providerRef || !input.idempotencyKey) {
      return { state: 'Failed' as const, providerRef: null, errorMessage: 'Invalid NMI refund context' };
    }
    try {
      const result = await transact(input.gateway!, {
        type: 'refund', transactionid: input.providerRef,
        amount: (input.amount / 100).toFixed(2), currency: input.currency,
        orderid: input.idempotencyKey,
      });
      if (result.get('response') === '1' && result.get('transactionid')) {
        return { state: 'Settled' as const, providerRef: result.get('transactionid') };
      }
      if (result.get('response') === '2') {
        return { state: 'Failed' as const, providerRef: null, errorMessage: 'NMI declined the refund' };
      }
      configFault(result.get('responsetext'), 'refund');
      // A processor error/duplicate or approval with no reference is not proof
      // that no money moved. The durable refund attempt must remain reserved.
      return { state: 'Pending' as const, providerRef: null, errorMessage: 'NMI refund requires reconciliation' };
    } catch {
      return { state: 'Pending' as const, providerRef: null, errorMessage: 'NMI refund outcome is unknown' };
    }
  }

  return {
    method: 'nmi', requiresRedirect: false,
    async createPayment(input) {
      if (!validGatewayInput(input, 'nmi') || !input.attemptId ||
          typeof input.token !== 'string' || !input.token.trim() || input.token.length > 4096) {
        return { state: 'Failed', providerRef: null, errorMessage: 'NMI requires a payment token and trusted attempt' };
      }
      const account = input.gateway!;
      const source = input.billingAddress ?? {};
      const billing: Record<string, unknown> = { ...source, streetLine1: source.streetLine1 ?? source.line1,
        streetLine2: source.streetLine2 ?? source.line2, countryCode: source.countryCode ?? source.country };
      const fields: Record<string, string> = {
        type: 'sale', payment_token: input.token, orderid: input.attemptId,
        amount: (input.amount / 100).toFixed(2), currency: input.currency,
      };
      for (const [target, source] of [
        ['address1', 'streetLine1'], ['address2', 'streetLine2'],
        ['city', 'city'], ['state', 'province'], ['zip', 'postalCode'], ['country', 'countryCode'],
      ]) {
        if (typeof billing[source!] === 'string') fields[target!] = String(billing[source!]).slice(0, 255);
      }
      let result: URLSearchParams;
      try { result = await transact(account, fields); }
      catch { return unknownPayment(null, 'sale_outcome_unknown'); }
      const ref = result.get('transactionid');
      const responseText = result.get('responsetext');
      if (result.get('response') === '2') {
        return { state: 'Declined', providerRef: ref, errorMessage: NMI_DECLINE_MESSAGE,
          metadata: { responseText, responseCode: result.get('response_code') } };
      }
      if (result.get('response') === '3') {
        configFault(responseText, 'sale');
        // A duplicate-check rejection means an EARLIER identical sale may have
        // gone through — keep the attempt reserved for reconciliation (never
        // a free retry that could double-charge). Any other response=3 is a
        // gateway/data error: no transaction was processed.
        if (DUPLICATE.test(responseText ?? '')) {
          return { ...unknownPayment(ref, 'duplicate_transaction'), errorMessage: NMI_DUPLICATE_MESSAGE,
            metadata: { needsReconciliation: true, reason: 'duplicate_transaction', responseText } };
        }
        if (!ref) {
          return { state: 'Failed', providerRef: null, errorMessage: NMI_DECLINE_MESSAGE,
            metadata: { responseText, responseCode: result.get('response_code') } };
        }
      }
      if (result.get('response') !== '1' || !ref) {
        return unknownPayment(ref, 'sale_response_requires_reconciliation');
      }
      const avs = result.get('avsresponse'), cvv = result.get('cvvresponse');
      const rejected = account.mode === 'live' && (AVS_REJECT.has(avs ?? '') || CVV_REJECT.has(cvv ?? ''));
      if (rejected) {
        // Never retry a monetary request or follow an ambiguous void with a
        // refund. A missing response can mean the reversal already succeeded.
        try {
          const reversed = await transact(account, { type: 'void', transactionid: ref });
          if (reversed.get('response') === '1') {
            return { state: 'Declined', providerRef: ref, errorMessage: NMI_VERIFICATION_MESSAGE,
              metadata: { reversed: true, reversal: 'void', avs, cvv, gateway: gatewayIdentity(account) } };
          }
          configFault(reversed.get('responsetext'), 'void');
          if (SETTLED_ERROR.test(reversed.get('responsetext') ?? '')) {
            const refunded = await refund({
              providerRef: ref, amount: input.amount, currency: input.currency,
              gateway: account, idempotencyKey: input.attemptId + ':avs-reversal',
            });
            if (refunded.state === 'Settled') {
              return { state: 'Declined', providerRef: ref, errorMessage: NMI_VERIFICATION_MESSAGE,
                metadata: { reversed: true, reversal: 'refund', refundRef: refunded.providerRef, avs, cvv, gateway: gatewayIdentity(account) } };
            }
          }
        } catch { /* The original approved transaction still needs reconciliation. */ }
        // Both reversals failed/ambiguous: CRITICAL — an approved charge the
        // policy rejected is still live. Keep it reserved (reconciliation list
        // + recovery job) rather than guessing.
        logErr.error('NMI AVS/CVV reversal unconfirmed — manual review', undefined, { attemptId: input.attemptId, ref, avs, cvv });
        return { ...unknownPayment(ref, 'verification_reversal_unconfirmed'),
          metadata: { needsReconciliation: true, reason: 'verification_reversal_unconfirmed', manualReview: true, avs, cvv } };
      }
      return { state: 'Settled', providerRef: ref,
        metadata: { gateway: gatewayIdentity(account), avs: result.get('avsresponse'), cvv: result.get('cvvresponse') } };
    },
    refundPayment: refund,
  };
}

export const nmiProvider = createNmiProvider();
