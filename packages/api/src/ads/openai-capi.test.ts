// #375: OpenAI CAPI normalisation (the docs' own examples), event shape, no raw PII, send outcomes. No database.
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { adMatchFor } from '../orders/ad-match.js';
import { backoffMs, buildOrderCreatedEvent, normEmail, normExternalId, normName, normPhone, sendEvent, sha256, type CapiOrderFacts } from './openai-capi.js';

const hex = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');

const facts = (over: Partial<CapiOrderFacts> = {}): CapiOrderFacts => ({
  code: 'RH000100', paidAt: new Date('2026-10-26T12:00:00Z'), currency: 'USD', grandTotal: 7500,
  lines: [{ sku: 'SHIRT-M', name: 'Slow Shirt', quantity: 2, lineTotal: 7000 }, { sku: 'SOCK', name: 'Sock', quantity: 1, lineTotal: 500 }],
  customer: null, contactEmail: '  Buyer@Example.COM ',
  shippingAddress: { fullName: "Mary-Jane O'Neil", phone: '(503) 227-1234', country: 'us', city: 'Portland', province: 'OR', postalCode: '97201', line1: '1 Secret St' },
  billingAddress: null, oppref: 'opp-123',
  adMatch: { obref: 'ob.abc', visitorId: 'vid-0001-abcd', ip: '198.51.100.7', userAgent: 'Mozilla/5.0' },
  ...over,
});

describe('normalisation (developers.openai.com/ads/measurement-pixel, send user data)', () => {
  it('follows the documented rules', () => {
    expect(normEmail('  Ada@Example.COM ')).toBe('ada@example.com');
    expect(normEmail('not-an-email')).toBeNull();
    expect(normPhone('+1 (415) 555-2671')).toBe('14155552671'); // the docs' example
    expect(normPhone('(503) 227-1234', 'US')).toBe('15032271234'); // national number gains its country code
    expect(normPhone('020 7946 0958', 'GB')).toBe('442079460958');
    expect(normPhone('12')).toBeNull();
    expect(normName("Mary-Jane O'Neil")).toBe('maryjaneoneil');
    expect(normName(' Ada ')).toBe('ada');
    expect(normName('---')).toBeNull();
    expect(normExternalId('  AbC-1 ')).toBe('AbC-1');
    expect(sha256('ada@example.com')).toBe(hex('ada@example.com'));
    expect(sha256('ada@example.com')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('buildOrderCreatedEvent', () => {
  it('builds the order_created event with the pixel event id, hashed user fields and contents', () => {
    const e = buildOrderCreatedEvent(facts(), 'https://rottenhand.com/checkout/confirmation/RH000100');
    expect(e).toMatchObject({ id: 'purchase_RH000100', type: 'order_created', timestamp_ms: Date.parse('2026-10-26T12:00:00Z'), oppref: 'opp-123',
      source_url: 'https://rottenhand.com/checkout/confirmation/RH000100', action_source: 'web' });
    expect(e.user).toEqual({
      emails_sha256: [hex('buyer@example.com')],
      phone_numbers_sha256: [hex('15032271234')],
      external_ids_sha256: [hex('vid-0001-abcd')],
      first_names_sha256: [hex('maryjane')],
      last_names_sha256: [hex('oneil')],
      countries: ['US'], regions: ['OR'], cities: ['Portland'], postal_codes: ['97201'],
      obref: 'ob.abc', ip_address: '198.51.100.7', user_agent: 'Mozilla/5.0',
    });
    expect(e.data).toEqual({ type: 'contents', amount: 7500, currency: 'USD', contents: [
      { id: 'SHIRT-M', name: 'Slow Shirt', content_type: 'product', quantity: 2, amount: 3500, currency: 'USD' },
      { id: 'SOCK', name: 'Sock', content_type: 'product', quantity: 1, amount: 500, currency: 'USD' },
    ] });
  });

  it('sends no raw email, phone, name or street address', () => {
    const json = JSON.stringify(buildOrderCreatedEvent(facts({ customer: { id: 'cust-1', email: 'member@example.com', phone: '+44 20 7946 0958', firstName: 'Ada', lastName: 'Lovelace' } }), 'https://x.test/c'));
    for (const raw of ['buyer@example.com', 'Buyer@Example', 'member@example.com', '503', '227-1234', '7946', 'Mary', 'Neil', 'Ada', 'Lovelace', 'Secret St']) {
      expect(json).not.toContain(raw);
    }
  });

  it('prefers the customer: ids, names and both emails; at most three per list', () => {
    const e = buildOrderCreatedEvent(facts({ customer: { id: 'cust-1', email: 'member@example.com', phone: null, firstName: 'Ada', lastName: 'Lovelace' } }), 'https://x.test/c');
    expect(e.user.external_ids_sha256).toEqual([hex('cust-1'), hex('vid-0001-abcd')]);
    expect(e.user.emails_sha256).toEqual([hex('buyer@example.com'), hex('member@example.com')]);
    expect(e.user.first_names_sha256).toEqual([hex('ada')]);
    expect(e.user.last_names_sha256).toEqual([hex('lovelace')]);
  });

  it('drops empty lists and absent match keys', () => {
    const e = buildOrderCreatedEvent(facts({ contactEmail: null, shippingAddress: null, adMatch: null, oppref: null }), 'https://x.test/c');
    expect(e.user).toEqual({});
    expect('oppref' in e).toBe(false);
  });
});

describe('sendEvent', () => {
  const cfg = { pixelId: 'PIX 1', key: 'sk-secret-key', validateOnly: true, storefrontUrl: 'https://x.test' };
  const ev = buildOrderCreatedEvent(facts(), 'https://x.test/c');

  it('posts one event with the bearer key and validate_only', async () => {
    const f = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    expect(await sendEvent(cfg, ev, f)).toEqual({ kind: 'accepted' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://bzr.openai.com/v1/events?pid=PIX%201');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-secret-key');
    expect(JSON.parse(init.body as string)).toEqual({ validate_only: true, integration_source: 'sellright', events: [ev] });
  });

  it('a 4xx is a rejection (not retried); 429/5xx/network are retries; details never carry the key or an email', async () => {
    const r400 = await sendEvent(cfg, ev, vi.fn().mockResolvedValue(new Response('{"error":"bad Bearer sk-secret-key for a@b.co"}', { status: 400 })));
    expect(r400).toMatchObject({ kind: 'rejected', status: 400 });
    expect(JSON.stringify(r400)).not.toContain('sk-secret-key');
    expect(JSON.stringify(r400)).not.toContain('a@b.co');
    expect(await sendEvent(cfg, ev, vi.fn().mockResolvedValue(new Response('slow down', { status: 429 })))).toMatchObject({ kind: 'retry', status: 429 });
    expect(await sendEvent(cfg, ev, vi.fn().mockResolvedValue(new Response('oops', { status: 503 })))).toMatchObject({ kind: 'retry', status: 503 });
    expect(await sendEvent(cfg, ev, vi.fn().mockRejectedValue(new TypeError('fetch failed')))).toMatchObject({ kind: 'retry', status: null });
  });

  it('backs off exponentially from 5 minutes, capped at 6 hours', () => {
    expect(backoffMs(1)).toBe(5 * 60_000);
    expect(backoffMs(2)).toBe(10 * 60_000);
    expect(backoffMs(20)).toBe(6 * 3_600_000);
  });
});

describe('adMatchFor (checkout)', () => {
  it('keeps valid keys with the client IP address and user agent; nothing without a storefront key', () => {
    expect(adMatchFor({ obref: ' ob.1 ', visitorId: 'vid-0001-abcd' }, '198.51.100.7', 'UA/1')).toEqual({ obref: 'ob.1', visitorId: 'vid-0001-abcd', ip: '198.51.100.7', userAgent: 'UA/1' });
    expect(adMatchFor({ visitorId: 'bad id!' }, '198.51.100.7', 'UA/1')).toBeNull();
    expect(adMatchFor(undefined, '198.51.100.7', 'UA/1')).toBeNull();
    expect(adMatchFor({ obref: 'ob' }, 'unknown', '')).toEqual({ obref: 'ob' });
  });
});
