/** Closed synthetic I/O boundary for authorization DB fixtures. Never production-exported. */
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import nodemailer from 'nodemailer';
import { STRIPE_API_VERSION } from '../payments/stripe-client.js';

export const MATRIX_PROVIDER = {
  listmonkUrl: 'https://listmonk.matrix.synthetic.invalid',
  listId: 731,
  listName: 'Synthetic authorization list',
  apiUser: 'matrix-api-user',
  apiToken: 'matrix-api-token',
  smtpHost: 'smtp.matrix.synthetic.invalid',
  smtpUser: 'matrix-user',
  smtpPassword: 'synthetic-matrix-password',
  smtpFrom: 'sender@matrix.invalid',
  stripeSecret: 'sk_test_matrix_isolated',
  stripePublishable: 'pk_test_matrix_isolated',
  stripeWebhookSecret: 'whsec_matrix_isolated',
  portalUrl: 'https://billing.matrix.synthetic.invalid/session',
} as const;
export interface MatrixTransportCall {
  kind: 'listmonk' | 'stripe' | 'indexnow' | 'smtp' | 'sheerid' | 'federated' | 'forbidden';
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  response?: unknown;
  smtp?: { settings: unknown; message: Record<string, unknown> };
}
export interface MatrixPaymentIntent {
  id: string; amount: number; currency: string; metadata: Record<string, string>;
  status: 'succeeded' | 'requires_payment_method'; client_secret: string;
}
export interface MatrixSheerIdVerification {
  verificationId: string; customerId: string; clientId: string; clientSecret: string;
  accessToken: string; details: Record<string, unknown>;
}
export interface AuthorizationTransport {
  registerPaymentIntent(input: MatrixPaymentIntent): void;
  registerSheerIdVerification(input: MatrixSheerIdVerification): void;
  calls: unknown[];
  /** Per-cell isolated remote fixture. Captures remain append-only for denial snapshots. */
  freshStripeWebhooks(): void;
  /** Per-cell isolated PaymentMethodDomain registry (express checkout wallet domains). */
  freshStripeDomains(): void;
  restore(): void;
}

/** Only fixed OAuth discovery endpoints can reach this cryptographic fixture adapter. */
export interface AuthorizationTransportOptions {
  federatedFetch?: (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => Promise<Response | undefined>;
}
/** Keep SSRF validation, Stripe SDK serialization & SMTP configuration resolution real. Replace only I/O. */
export function installAuthorizationTransport(calls: unknown[], options: AuthorizationTransportOptions = {}): AuthorizationTransport {
  const restorers: Array<() => void> = [];
  let campaignId = 9000, webhookId = 0, paymentIntentId = 0, checkoutId = 0;
  const paymentIntents = new Map<string, MatrixPaymentIntent>();
  const sheerId = new Map<string, MatrixSheerIdVerification>();
  const endpoints: Array<{ id: string; url: string; metadata: Record<string, string> }> = [];
  let domainId = 0;
  const paymentDomains: Array<{ id: string; domain_name: string; enabled: boolean }> = [];
  const domainObject = (d: { id: string; domain_name: string; enabled: boolean }) => ({ object: 'payment_method_domain', livemode: false, created: 1, ...d,
    apple_pay: { status: 'active' }, google_pay: { status: 'active' }, link: { status: 'active' }, paypal: { status: 'inactive' }, amazon_pay: { status: 'inactive' }, klarna: { status: 'inactive' } });
  const forbidden = (method: string, url: string): never => {
    calls.push({ kind: 'forbidden', method, url } satisfies MatrixTransportCall);
    throw new Error('authorization transport forbids ' + method + ' ' + url);
  };
  const normalized = (input: unknown): Record<string, string> => Object.fromEntries(
    Object.entries((input ?? {}) as Record<string, unknown>).map(([key, value]) => [key.toLowerCase(), String(value)]));
  // Descriptor restoration keeps this fixture usable by both Vitest & standalone packed qualifiers.
  const spy = <T extends object, K extends keyof T>(target: T, key: K, replacement: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    assert.ok(descriptor && 'value' in descriptor && descriptor.writable, 'synthetic I/O property must be reversible');
    Object.defineProperty(target, key, { ...descriptor, value: replacement });
    restorers.push(() => Object.defineProperty(target, key, descriptor));
  };
  // No DNS fallback: only synthetic Listmonk & registered SheerID fixtures may resolve.
  spy(dns, 'lookup', async (hostname: string, options: { all?: boolean } = {}) => {
    const configuredSheerId = sheerId.size > 0 && ['auth.sheerid.com', 'services.sheerid.com'].includes(hostname);
    if (hostname !== new URL(MATRIX_PROVIDER.listmonkUrl).hostname && !configuredSheerId) return forbidden('DNS', hostname);
    const record = { address: '93.184.216.34', family: 4 };
    return options.all ? [record] : record;
  });

  const record = (kind: MatrixTransportCall['kind'], url: URL, method: string, headers: Record<string, string>, body: string, response: unknown): unknown => {
    calls.push({ kind, method, url: url.toString(), headers, body, response: structuredClone(response) } satisfies MatrixTransportCall);
    return response;
  };
  const dispatch = (url: URL, method: string, headers: Record<string, string>, body: string): unknown => {
    if (url.toString() === 'https://auth.sheerid.com/oauth/token' && method === 'POST') {
      const form = new URLSearchParams(body);
      const fixture = [...sheerId.values()].find(value => value.clientId === form.get('client_id') && value.clientSecret === form.get('client_secret'));
      assert.ok(fixture, 'SheerID OAuth must use registered synthetic credentials');
      assert.deepEqual(Object.fromEntries(form), { grant_type: 'client_credentials', client_id: fixture.clientId,
        client_secret: fixture.clientSecret, audience: 'https://services.sheerid.com/rest/' });
      return record('sheerid', url, method, headers, body, { access_token: fixture.accessToken, expires_in: 3600 });
    }
    const sheerIdDetails = /^\/rest\/v2\/verification\/([^/]+)\/details$/.exec(url.pathname);
    if (url.origin === 'https://services.sheerid.com' && method === 'GET' && sheerIdDetails) {
      const fixture = sheerId.get(decodeURIComponent(sheerIdDetails[1]!));
      assert.ok(fixture, 'SheerID details must use registered verification identity');
      assert.equal(headers.authorization, 'Bearer ' + fixture.accessToken);
      return record('sheerid', url, method, headers, body, fixture.details);
    }
    if (url.origin === MATRIX_PROVIDER.listmonkUrl) {
      assert.equal(headers.authorization, 'Basic ' + Buffer.from(MATRIX_PROVIDER.apiUser + ':' + MATRIX_PROVIDER.apiToken).toString('base64'));
      calls.push({ kind: 'listmonk', method, url: url.toString(), headers, body } satisfies MatrixTransportCall);
      if (method === 'GET' && url.pathname === '/api/lists' && !url.search) return { data: { total: 1 } };
      if (method === 'GET' && url.pathname === '/api/lists' && url.search === '?per_page=100') return { data: { results: [{ id: MATRIX_PROVIDER.listId, name: MATRIX_PROVIDER.listName, subscriber_count: 7, type: 'public' }] } };
      if (method === 'GET' && url.pathname === '/api/lists/' + MATRIX_PROVIDER.listId) return { data: { id: MATRIX_PROVIDER.listId } };
      if (method === 'POST' && url.pathname === '/api/subscribers') return { data: { id: 8500 } };
      if (method === 'POST' && url.pathname === '/api/campaigns') {
        const response = { data: { id: ++campaignId } };
        (calls.at(-1) as MatrixTransportCall).response = structuredClone(response);
        return response;
      }
      return forbidden(method, url.toString());
    }
    if (url.hostname === 'api.stripe.com' && url.protocol === 'https:' && url.port === '') {
      assert.equal(headers.authorization, 'Bearer ' + MATRIX_PROVIDER.stripeSecret);
      assert.equal(headers['stripe-version'], STRIPE_API_VERSION);
      calls.push({ kind: 'stripe', method, url: url.toString(), headers, body } satisfies MatrixTransportCall);
      if (method === 'POST' && url.pathname === '/v1/payment_intents') {
        const form = new URLSearchParams(body), metadata: Record<string, string> = {};
        for (const [key, value] of form) if (/^metadata\[.+\]$/.test(key)) metadata[key.slice(9, -1)] = value;
        const id = 'pi_matrix_' + ++paymentIntentId;
        const intent: MatrixPaymentIntent = { id, amount: Number(form.get('amount')), currency: form.get('currency')!,
          metadata, status: 'requires_payment_method', client_secret: id + '_secret_synthetic' };
        assert.ok(Number.isSafeInteger(intent.amount) && intent.amount > 0);
        assert.ok(/^[a-z]{3}$/.test(intent.currency));
        paymentIntents.set(id, intent);
        const response = { object: 'payment_intent', livemode: false, ...intent };
        (calls.at(-1) as MatrixTransportCall).response = structuredClone(response);
        return response;
      }
      if (method === 'GET' && url.pathname === '/v1/payment_intents/search' && url.searchParams.has('query')) {
        return { object: 'search_result', data: [], has_more: false };
      }
      const intentId = /^\/v1\/payment_intents\/([^/]+)$/.exec(url.pathname)?.[1];
      if (method === 'GET' && intentId) {
        const intent = paymentIntents.get(decodeURIComponent(intentId));
        assert.ok(intent, 'Stripe payment intent must be registered or created in synthetic fixture');
        const response = { object: 'payment_intent', livemode: false, ...structuredClone(intent) };
        (calls.at(-1) as MatrixTransportCall).response = structuredClone(response);
        return response;
      }
      if (method === 'POST' && url.pathname === '/v1/checkout/sessions') {
        assert.equal(new URLSearchParams(body).get('mode'), 'subscription');
        const response = { id: 'cs_matrix_' + ++checkoutId, object: 'checkout.session', url: 'https://checkout.matrix.synthetic.invalid/session' };
        (calls.at(-1) as MatrixTransportCall).response = structuredClone(response);
        return response;
      }
      if (method === 'GET' && url.pathname === '/v1/balance') return { object: 'balance', available: [], pending: [], livemode: false };
      if (method === 'GET' && url.pathname === '/v1/webhook_endpoints') return { object: 'list', data: structuredClone(endpoints), has_more: false, url: '/v1/webhook_endpoints' };
      if (method === 'POST' && url.pathname === '/v1/webhook_endpoints') {
        const form = new URLSearchParams(body), metadata: Record<string, string> = {};
        for (const [key, value] of form) if (/^metadata\[.+\]$/.test(key)) metadata[key.slice(9, -1)] = value;
        const endpoint = { id: 'we_matrix_' + ++webhookId, url: form.get('url')!, metadata };
        endpoints.push(endpoint);
        return { object: 'webhook_endpoint', ...endpoint, secret: MATRIX_PROVIDER.stripeWebhookSecret };
      }
      if (method === 'DELETE' && /^\/v1\/webhook_endpoints\/we_matrix_\d+$/.test(url.pathname)) {
        const id = url.pathname.split('/').at(-1)!;
        const index = endpoints.findIndex(endpoint => endpoint.id === id);
        if (index >= 0) endpoints.splice(index, 1);
        return { id, object: 'webhook_endpoint', deleted: true };
      }
      if (method === 'GET' && url.pathname === '/v1/payment_method_domains') {
        const name = url.searchParams.get('domain_name');
        return { object: 'list', data: paymentDomains.filter(d => d.domain_name === name).map(domainObject), has_more: false, url: '/v1/payment_method_domains' };
      }
      if (method === 'POST' && url.pathname === '/v1/payment_method_domains') {
        const form = new URLSearchParams(body);
        const domain = { id: 'pmd_matrix_' + ++domainId, domain_name: form.get('domain_name')!, enabled: form.get('enabled') !== 'false' };
        paymentDomains.push(domain);
        const response = domainObject(domain);
        (calls.at(-1) as MatrixTransportCall).response = structuredClone(response);
        return response;
      }
      if (method === 'POST' && url.pathname === '/v1/billing_portal/sessions') return { id: 'bps_matrix', object: 'billing_portal.session', url: MATRIX_PROVIDER.portalUrl };
      return forbidden(method, url.toString());
    }
    return forbidden(method, url.toString());
  };

  // Both safeOutboundFetch(URL, options, callback) & Stripe SDK(options) use Node HTTPS.
  spy(https, 'request', (input: URL | Record<string, unknown>, optionsOrCallback?: Record<string, unknown> | ((response: unknown) => void), optionalCallback?: (response: unknown) => void) => {
    const options = input instanceof URL ? (typeof optionsOrCallback === 'object' ? optionsOrCallback : {}) : input;
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : optionalCallback;
    const url = input instanceof URL ? input : new URL('https://' + String(options.hostname ?? options.host) + String(options.path ?? '/'));
    if (url.origin !== MATRIX_PROVIDER.listmonkUrl && !['api.stripe.com', 'auth.sheerid.com', 'services.sheerid.com'].includes(url.hostname)) return forbidden('HTTPS', url.toString());
    const request = new EventEmitter() as EventEmitter & {
      write(chunk: unknown): boolean; end(chunk?: unknown): void; setTimeout(): unknown; destroy(error?: Error): unknown;
    };
    const chunks: Buffer[] = [];
    request.write = chunk => { if (chunk !== undefined && chunk !== null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; };
    request.setTimeout = () => request;
    request.destroy = error => { if (error) queueMicrotask(() => request.emit('error', error)); return request; };
    request.end = chunk => {
      if (chunk !== undefined) request.write(chunk);
      queueMicrotask(() => {
        try {
          const method = String(options.method ?? 'GET').toUpperCase(), headers = normalized(options.headers);
          const data = dispatch(url, method, headers, Buffer.concat(chunks).toString());
          const stream = Readable.from([Buffer.from(JSON.stringify(data))]) as Readable & { statusCode: number; statusMessage: string; headers: Record<string, string>; complete: boolean };
          stream.statusCode = 200; stream.statusMessage = 'OK';
          stream.headers = { 'content-type': 'application/json', 'request-id': 'req_matrix' };
          stream.complete = true;
          callback?.(stream);
          request.emit('response', stream);
        } catch (error) { request.emit('error', error); }
      });
    };
    return request;
  });
  spy(globalThis, 'fetch', async (input: Parameters<typeof globalThis.fetch>[0], init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : input.toString();
    const target = new URL(url), method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const appleKeys = url === 'https://appleid.apple.com/auth/keys';
    const googleToken = target.origin === 'https://oauth2.googleapis.com' && target.pathname === '/tokeninfo'
      && [...target.searchParams.keys()].length === 1 && target.searchParams.has('id_token');
    if (options.federatedFetch && method === 'GET' && (appleKeys || googleToken)) {
      const result = await options.federatedFetch(input, init);
      if (!result) return forbidden('FETCH', appleKeys ? url : target.origin + target.pathname);
      calls.push({ kind: 'federated', method, url: appleKeys ? url : target.origin + target.pathname + '?id_token=[synthetic-redacted]',
        response: { status: result.status } } satisfies MatrixTransportCall);
      return result;
    }
    if (url !== 'https://api.indexnow.org/indexnow') return forbidden('FETCH', target.origin + target.pathname);
    assert.equal(init.method, 'POST');
    const body = String(init.body ?? '');
    const parsed = JSON.parse(body) as { host?: string; urlList?: string[] };
    assert.equal(parsed.host, 'shop.matrix.invalid');
    assert.ok(parsed.urlList?.every(value => new URL(value).origin === 'https://shop.matrix.invalid'));
    calls.push({ kind: 'indexnow', method: 'POST', url, headers: normalized(init.headers), body } satisfies MatrixTransportCall);
    return new Response(null, { status: 202 });
  });
  spy(nodemailer, 'createTransport', (settings: Record<string, unknown>) => {
    assert.equal(settings.host, MATRIX_PROVIDER.smtpHost, 'SMTP fixture refuses non-synthetic host');
    assert.equal(settings.port, 587);
    assert.equal(settings.secure, false);
    assert.deepEqual(settings.auth, { user: MATRIX_PROVIDER.smtpUser, pass: MATRIX_PROVIDER.smtpPassword });
    return { async sendMail(message: Record<string, unknown>) {
      assert.ok(typeof message.to === 'string' && message.to.endsWith('@matrix.invalid'));
      calls.push({ kind: 'smtp', method: 'SEND', url: 'smtp://' + MATRIX_PROVIDER.smtpHost + ':587',
        smtp: { settings: structuredClone(settings), message: structuredClone(message) } } satisfies MatrixTransportCall);
      return { messageId: 'smtp-matrix', accepted: [message.to], rejected: [] };
    }, close() {} };
  });
  spy(http, 'request', (..._args: unknown[]) => forbidden('HTTP', 'unconfigured'));
  spy(http, 'get', (..._args: unknown[]) => forbidden('HTTP GET', 'unconfigured'));
  spy(https, 'get', (..._args: unknown[]) => forbidden('HTTPS GET', 'unconfigured'));
  spy(tls, 'connect', (..._args: unknown[]) => forbidden('TLS', 'unconfigured'));
  syncBuiltinESMExports();
  return { calls,
    registerPaymentIntent(input) {
      assert.ok(/^pi_matrix_[A-Za-z0-9_]+$/.test(input.id), 'registered Stripe intent must use synthetic id');
      assert.ok(Number.isSafeInteger(input.amount) && input.amount > 0);
      assert.ok(/^[a-z]{3}$/.test(input.currency));
      paymentIntents.set(input.id, structuredClone(input));
    },
    registerSheerIdVerification(input) {
      assert.equal(input.details.verificationId, input.verificationId);
      const metadata = (input.details.personInfo as { metadata?: { customerId?: string } } | undefined)?.metadata;
      assert.equal(metadata?.customerId, input.customerId);
      assert.ok(input.clientId && input.clientSecret && input.accessToken);
      sheerId.set(input.verificationId, structuredClone(input));
    },
    freshStripeWebhooks() { endpoints.splice(0); }, freshStripeDomains() { paymentDomains.splice(0); }, restore() {
    for (const restore of restorers.reverse()) restore();
    syncBuiltinESMExports();
  } };
}

