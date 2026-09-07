import type { PaymentProvider, PaymentResult, RefundInput } from './provider.js';
import {
  boundedGatewayResponse, gatewayIdentity, validGatewayInput,
  type GatewayAccount, type GatewayFetch,
} from './gateway-account.js';

const AVS_REJECT = new Set(['N', 'C']);
const CVV_REJECT = new Set(['N']);
const SETTLED_ERROR = /settled|batch|too late/i;

function unknownPayment(providerRef: string | null, reason: string): PaymentResult {
  return {
    state: 'Pending', providerRef, errorMessage: 'Payment requires reconciliation',
    metadata: { needsReconciliation: true, reason },
  };
}

export function createNmiProvider(transport: GatewayFetch = fetch): PaymentProvider {
  async function transact(account: GatewayAccount, values: Record<string, string>): Promise<URLSearchParams> {
    if (!account.securityKey) throw new Error('NMI security key is not configured');
    const base = account.mode === 'test' ? 'https://sandbox.nmi.com' : 'https://secure.nmi.com';
    const body = new URLSearchParams({ ...values, security_key: account.securityKey });
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
      if (result.get('response') === '2') {
        return { state: 'Declined', providerRef: ref, errorMessage: 'Payment declined by NMI' };
      }
      if (result.get('response') !== '1' || !ref) {
        return unknownPayment(ref, 'sale_response_requires_reconciliation');
      }
      const rejected = account.mode === 'live' &&
        (AVS_REJECT.has(result.get('avsresponse') ?? '') || CVV_REJECT.has(result.get('cvvresponse') ?? ''));
      if (rejected) {
        // Never retry a monetary request or follow an ambiguous void with a
        // refund. A missing response can mean the reversal already succeeded.
        try {
          const reversed = await transact(account, { type: 'void', transactionid: ref });
          if (reversed.get('response') === '1') {
            return { state: 'Declined', providerRef: ref, errorMessage: 'Card verification failed; payment voided',
              metadata: { reversed: true, reversal: 'void', gateway: gatewayIdentity(account) } };
          }
          if (SETTLED_ERROR.test(reversed.get('responsetext') ?? '')) {
            const refunded = await refund({
              providerRef: ref, amount: input.amount, currency: input.currency,
              gateway: account, idempotencyKey: input.attemptId + ':avs-reversal',
            });
            if (refunded.state === 'Settled') {
              return { state: 'Declined', providerRef: ref, errorMessage: 'Card verification failed; payment refunded',
                metadata: { reversed: true, reversal: 'refund', refundRef: refunded.providerRef, gateway: gatewayIdentity(account) } };
            }
          }
        } catch { /* The original approved transaction still needs reconciliation. */ }
        return unknownPayment(ref, 'verification_reversal_unconfirmed');
      }
      return { state: 'Settled', providerRef: ref,
        metadata: { gateway: gatewayIdentity(account), avs: result.get('avsresponse'), cvv: result.get('cvvresponse') } };
    },
    refundPayment: refund,
  };
}

export const nmiProvider = createNmiProvider();
