/**
 * PAR-06 unit coverage for verifyTurnstileToken — every path is exercised
 * with a stubbed global fetch; the real Cloudflare siteverify endpoint is
 * never called from tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyTurnstileToken } from './turnstile.js';

const fetchMock = () => vi.stubGlobal('fetch', vi.fn());
const stubbedFetch = () => fetch as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verifyTurnstileToken', () => {
  it('returns true without calling fetch when no secret is configured (feature disabled)', async () => {
    fetchMock();
    expect(await verifyTurnstileToken({ secret: null, token: 'tok' })).toBe(true);
    expect(await verifyTurnstileToken({ secret: undefined, token: undefined })).toBe(true);
    expect(await verifyTurnstileToken({ secret: '   ', token: 'tok' })).toBe(true);
    expect(stubbedFetch()).not.toHaveBeenCalled();
  });

  it('fails closed when configured but the client presented no token', async () => {
    fetchMock();
    expect(await verifyTurnstileToken({ secret: 's', token: null })).toBe(false);
    expect(await verifyTurnstileToken({ secret: 's', token: '  ' })).toBe(false);
    expect(stubbedFetch()).not.toHaveBeenCalled();
  });

  it('POSTs secret + response + remoteip to siteverify and returns true only on success', async () => {
    fetchMock();
    stubbedFetch().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    const ok = await verifyTurnstileToken({ secret: 'sekret', token: 'tok123', remoteIp: '203.0.113.9' });
    expect(ok).toBe(true);

    const [url, init] = stubbedFetch().mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(init.method).toBe('POST');
    const params = new URLSearchParams(init.body as string);
    expect(params.get('secret')).toBe('sekret');
    expect(params.get('response')).toBe('tok123');
    expect(params.get('remoteip')).toBe('203.0.113.9');
  });

  it('returns false when siteverify answers success:false', async () => {
    fetchMock();
    stubbedFetch().mockResolvedValue(new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), { status: 200 }));
    expect(await verifyTurnstileToken({ secret: 's', token: 'bad' })).toBe(false);
  });

  it('returns false on non-2xx, network error, and malformed JSON (all fail closed)', async () => {
    fetchMock();
    stubbedFetch().mockResolvedValue(new Response('upstream error', { status: 502 }));
    expect(await verifyTurnstileToken({ secret: 's', token: 't' })).toBe(false);

    stubbedFetch().mockRejectedValue(new Error('socket hangup'));
    expect(await verifyTurnstileToken({ secret: 's', token: 't' })).toBe(false);

    stubbedFetch().mockResolvedValue(new Response('not json', { status: 200 }));
    expect(await verifyTurnstileToken({ secret: 's', token: 't' })).toBe(false);

    // success present but truthy-not-true must not pass.
    stubbedFetch().mockResolvedValue(new Response(JSON.stringify({ success: 'yes' }), { status: 200 }));
    expect(await verifyTurnstileToken({ secret: 's', token: 't' })).toBe(false);
  });
});

describe('verifyTurnstileToken — no secret configured (policy by NODE_ENV / TURNSTILE_DISABLED)', () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, TURNSTILE_DISABLED: process.env.TURNSTILE_DISABLED };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k as keyof typeof saved]; else process.env[k as keyof typeof saved] = v;
    }
  });

  it('production with no secret FAILS CLOSED, with or without a token', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.TURNSTILE_DISABLED;
    fetchMock();
    expect(await verifyTurnstileToken({ secret: null, token: 'tok' })).toBe(false);
    expect(await verifyTurnstileToken({ secret: '  ', token: null })).toBe(false);
    expect(stubbedFetch()).not.toHaveBeenCalled();
  });

  it('production with TURNSTILE_DISABLED=true passes without a secret', async () => {
    process.env.NODE_ENV = 'production';
    process.env.TURNSTILE_DISABLED = 'true';
    fetchMock();
    expect(await verifyTurnstileToken({ secret: null, token: null })).toBe(true);
    expect(stubbedFetch()).not.toHaveBeenCalled();
  });

  it('TURNSTILE_DISABLED values other than the literal "true" do not opt out', async () => {
    process.env.NODE_ENV = 'production';
    process.env.TURNSTILE_DISABLED = '1';
    expect(await verifyTurnstileToken({ secret: null, token: null })).toBe(false);
  });

  it('development/test with no secret keeps today\'s pass-through', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.TURNSTILE_DISABLED;
    expect(await verifyTurnstileToken({ secret: null, token: null })).toBe(true);
    process.env.NODE_ENV = 'test';
    expect(await verifyTurnstileToken({ secret: null, token: null })).toBe(true);
  });

  it('a configured secret is verified the same way in production (no fail-open)', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.TURNSTILE_DISABLED;
    fetchMock();
    stubbedFetch().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    expect(await verifyTurnstileToken({ secret: 's', token: 't' })).toBe(true);
    expect(await verifyTurnstileToken({ secret: 's', token: null })).toBe(false);
  });
});
