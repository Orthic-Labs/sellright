import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CreatePaymentInput, PaymentProvider, PaymentResult } from './provider.js';
import {
  boundedGatewayResponse, gatewayIdentity, validGatewayInput,
  type GatewayAccount, type GatewayFetch,
} from './gateway-account.js';

type Money = { amount_in_cents: number; currency: string };
type Event = { uuid: string; amount: Money };
interface SezzleOrder {
  uuid: string;
  reference_id: string;
  order_amount: Money;
  checkout_status?: string;
  authorization?: { approved?: boolean; captures?: Event[]; refunds?: Event[] };
}

export interface SezzleSessionInput extends CreatePaymentInput {
  customer: Record<string, unknown>;
  items: Array<{ name: string; sku: string; quantity: number; price: Money }>;
  shipping: number;
  tax: number;
  discount: number;
  completeUrl: string;
  cancelUrl: string;
}

export function verifySezzleSignature(raw: string, signature: string | undefined, key: string): boolean {
  if (!signature || !/^[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', key).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

function pending(ref: string | null, reason: string): PaymentResult {
  return { state: 'Pending', providerRef: ref, errorMessage: 'Sezzle payment requires reconciliation',
    metadata: { needsReconciliation: true, reason } };
}

export function createSezzleProvider(transport: GatewayFetch = fetch): PaymentProvider & {
  createSession(input: SezzleSessionInput): Promise<{ providerRef: string; checkoutUrl: string }>;
  getOrder(account: GatewayAccount, ref: string): Promise<SezzleOrder>;
} {
  const base = (account: GatewayAccount) =>
    account.mode === 'test' ? 'https://sandbox.gateway.sezzle.com' : 'https://gateway.sezzle.com';

  async function request<T>(account: GatewayAccount, method: string, path: string, body?: unknown): Promise<T> {
    if (account.method !== 'sezzle' || !account.publicKey || !account.privateKey) {
      throw new Error('Sezzle account is not configured');
    }
    const auth = await transport(base(account) + '/v2/authentication', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ public_key: account.publicKey, private_key: account.privateKey }),
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    const credentials = JSON.parse(await boundedGatewayResponse(auth)) as { token?: string };
    if (!credentials.token) throw new Error('Sezzle authentication failed');
    const response = await transport(base(account) + '/v2' + path, {
      method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + credentials.token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000), redirect: 'error',
    });
    return JSON.parse(await boundedGatewayResponse(response)) as T;
  }
  const getOrder = (account: GatewayAccount, ref: string) =>
    request<SezzleOrder>(account, 'GET', '/order/' + encodeURIComponent(ref));

  return {
    method: 'sezzle', requiresRedirect: true, getOrder,
    async createSession(input) {
      if (!validGatewayInput(input, 'sezzle') || !input.attemptId || !input.items.length) {
        throw new Error('Invalid Sezzle session context');
      }
      for (const target of [input.completeUrl, input.cancelUrl]) {
        const url = new URL(target);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
          throw new Error('Invalid Sezzle return URL');
        }
      }
      const money = (n: number): Money => ({ amount_in_cents: n, currency: input.currency });
      const total = input.items.reduce((n, i) => n + i.price.amount_in_cents * i.quantity, 0)
        + input.shipping + input.tax - input.discount;
      if (total !== input.amount) throw new Error('Sezzle session totals do not reconcile');
      const result = await request<{ order?: { uuid?: string; checkout_url?: string } }>(
        input.gateway!, 'POST', '/session', {
          complete_url: { href: input.completeUrl, method: 'GET' },
          cancel_url: { href: input.cancelUrl, method: 'GET' },
          customer: input.customer,
          order: {
            intent: 'CAPTURE', reference_id: input.attemptId,
            items: input.items, order_amount: money(input.amount),
            shipping_amount: money(input.shipping), tax_amount: money(input.tax),
            ...(input.discount ? { discounts: [{ name: 'Order discount', amount: money(input.discount) }] } : {}),
          },
        });
      if (!result.order?.uuid || !result.order.checkout_url) throw new Error('Sezzle session response is incomplete');
      const url = new URL(result.order.checkout_url);
      const host = input.gateway!.mode === 'test' ? 'sandbox.checkout.sezzle.com' : 'checkout.sezzle.com';
      if (url.protocol !== 'https:' || url.hostname !== host || url.username || url.password) {
        throw new Error('Untrusted Sezzle checkout URL');
      }
      return { providerRef: result.order.uuid, checkoutUrl: url.href };
    },
    async createPayment(input) {
      if (!validGatewayInput(input, 'sezzle') || !input.attemptId ||
          typeof input.token !== 'string' || !input.token) {
        return { state: 'Failed', providerRef: null, errorMessage: 'Invalid Sezzle verification context' };
      }
      try {
        const order = await getOrder(input.gateway!, input.token);
        if (order.uuid !== input.token || order.reference_id !== input.attemptId ||
            order.order_amount?.amount_in_cents !== input.amount || order.order_amount.currency !== input.currency) {
          return pending(input.token, 'order_identity_or_amount_mismatch');
        }
        const captures = order.authorization?.captures ?? [];
        const refs = new Set<string>();
        let captured = 0;
        for (const capture of captures) {
          if (!capture.uuid || refs.has(capture.uuid) ||
              !Number.isSafeInteger(capture.amount?.amount_in_cents) || capture.amount.amount_in_cents < 0 ||
              capture.amount.currency !== input.currency) return pending(input.token, 'invalid_capture');
          refs.add(capture.uuid);
          captured += capture.amount.amount_in_cents;
        }
        if (captured !== 0 && captured !== input.amount) return pending(input.token, 'partial_or_excess_capture');
        return {
          state: captured === input.amount ? 'Settled' : order.authorization?.approved ? 'Authorized' : 'Pending',
          providerRef: input.token, metadata: { gateway: gatewayIdentity(input.gateway!), captureRefs: [...refs] },
        };
      } catch { return pending(input.token, 'verification_unavailable'); }
    },
    async refundPayment(input) {
      if (!validGatewayInput(input, 'sezzle') || !input.providerRef || !input.idempotencyKey) {
        return { state: 'Failed', providerRef: null, errorMessage: 'Invalid Sezzle refund context' };
      }
      try {
        const result = await request<{ uuid?: string }>(input.gateway!, 'POST',
          '/order/' + encodeURIComponent(input.providerRef) + '/refund',
          { amount_in_cents: input.amount, currency: input.currency });
        if (!result.uuid) return { state: 'Pending', providerRef: null, errorMessage: 'Sezzle refund requires reconciliation' };
        return { state: 'Settled', providerRef: result.uuid };
      } catch {
        return { state: 'Pending', providerRef: null, errorMessage: 'Sezzle refund outcome is unknown' };
      }
    },
  };
}

export const sezzleProvider = createSezzleProvider();
