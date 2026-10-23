import { describe, expect, it } from 'vitest';
import { ensurePaymentMethodDomains, MAX_STORE_PAYMENT_DOMAINS, storePaymentDomains, type PaymentMethodDomainLike, type StripePaymentMethodDomainClient } from './stripe-payment-method-domains.js';

/** In-memory PaymentMethodDomain API: no network, records every call. */
function fakeStripe(seed: PaymentMethodDomainLike[] = [], failOn: string[] = []) {
  const domains = seed.map((d) => ({ ...d }));
  const calls: string[] = [];
  let n = 0;
  const client: StripePaymentMethodDomainClient = { paymentMethodDomains: {
    async list({ domain_name }) {
      calls.push(`list ${domain_name}`);
      if (failOn.includes(domain_name)) throw new Error('Stripe rejected the domain');
      return { data: domains.filter((d) => d.domain_name === domain_name) };
    },
    async create({ domain_name, enabled }) {
      calls.push(`create ${domain_name}`);
      const d = { id: `pmd_${++n}`, domain_name, enabled, apple_pay: { status: 'active' }, google_pay: { status: 'active' } };
      domains.push(d);
      return d;
    },
    async update(id, { enabled }) {
      calls.push(`update ${id}`);
      const d = domains.find((x) => x.id === id)!; d.enabled = enabled; return d;
    },
    async validate(id) {
      calls.push(`validate ${id}`);
      const d = domains.find((x) => x.id === id)!; d.apple_pay = { status: 'active' }; return d;
    },
  } };
  return { client, calls, domains };
}

describe('storePaymentDomains', () => {
  it('uses only the store\'s own storefront URL and hostnames, adding www. for bare entries', () => {
    expect(storePaymentDomains({ storefrontUrl: 'https://Shop.Example.com/store', hostnames: ['example.com', 'www.example.com', 'buy.example.org'] }))
      .toEqual(['shop.example.com', 'example.com', 'www.example.com', 'buy.example.org', 'www.buy.example.org']);
  });

  it('skips loopback, IP, single-label and malformed hosts; no config means no domains', () => {
    expect(storePaymentDomains({ storefrontUrl: 'http://localhost:4000', hostnames: ['127.0.0.1', 'intranet', 'bad host.com', 42, 'a.localhost'] })).toEqual([]);
    expect(storePaymentDomains(null)).toEqual([]);
    expect(storePaymentDomains({ hostnames: 'example.com' })).toEqual([]);
  });

  it('caps the domain list', () => {
    const hostnames = Array.from({ length: 30 }, (_, i) => `www.s${i}.example.com`);
    expect(storePaymentDomains({ hostnames })).toHaveLength(MAX_STORE_PAYMENT_DOMAINS);
  });
});

describe('ensurePaymentMethodDomains', () => {
  it('creates missing domains once and is idempotent on re-run', async () => {
    const stripe = fakeStripe();
    const first = await ensurePaymentMethodDomains(stripe.client, ['example.com', 'www.example.com']);
    expect(first.map((r) => [r.domain, r.outcome, r.applePay])).toEqual([['example.com', 'created', 'active'], ['www.example.com', 'created', 'active']]);
    const second = await ensurePaymentMethodDomains(stripe.client, ['example.com', 'www.example.com']);
    expect(second.map((r) => r.outcome)).toEqual(['unchanged', 'unchanged']);
    expect(stripe.domains).toHaveLength(2);
    expect(stripe.calls.filter((c) => c.startsWith('create'))).toEqual(['create example.com', 'create www.example.com']);
  });

  it('re-enables a disabled registration and re-validates an inactive Apple Pay one instead of duplicating', async () => {
    const stripe = fakeStripe([
      { id: 'pmd_off', domain_name: 'off.example.com', enabled: false, apple_pay: { status: 'active' }, google_pay: { status: 'active' } },
      { id: 'pmd_inactive', domain_name: 'new.example.com', enabled: true, apple_pay: { status: 'inactive' }, google_pay: { status: 'active' } },
    ]);
    const out = await ensurePaymentMethodDomains(stripe.client, ['off.example.com', 'new.example.com']);
    expect(out.map((r) => [r.id, r.outcome, r.enabled, r.applePay])).toEqual([['pmd_off', 'updated', true, 'active'], ['pmd_inactive', 'updated', true, 'active']]);
    expect(stripe.calls).toEqual(['list off.example.com', 'update pmd_off', 'list new.example.com', 'validate pmd_inactive']);
  });

  it('reports a failing domain without stopping the others', async () => {
    const stripe = fakeStripe([], ['bad.example.com']);
    const out = await ensurePaymentMethodDomains(stripe.client, ['bad.example.com', 'good.example.com']);
    expect(out[0]).toMatchObject({ domain: 'bad.example.com', id: null, outcome: 'failed', error: 'Stripe rejected the domain' });
    expect(out[1]).toMatchObject({ domain: 'good.example.com', outcome: 'created' });
  });
});
