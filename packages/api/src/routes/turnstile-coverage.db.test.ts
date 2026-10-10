/**
 * DB tests for Turnstile coverage on the public endpoints that were open:
 *   - POST /v1/shop/auth/resend-verification  (body turnstileToken)
 *   - POST /v1/shop/newsletter-signup         (body turnstileToken)
 *   - GET  /v1/shop/track                     (query turnstileToken)
 *
 * Per endpoint: no token → 403 BOT_CHECK_FAILED when a secret is configured;
 * valid token → gate passes; production with no secret → 403 unless
 * TURNSTILE_DISABLED=true; TURNSTILE_DISABLED=true → passes.
 *
 * Runs against a *_test DB only (TRUNCATEs store CASCADE).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { pool } from '../db/client.js';
import { env } from '../env.js';
import { invalidateStoreCache } from '../store-context.js';
import { auth } from './auth.js';
import { shopExtra } from './shop-extra.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`turnstile coverage test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@]+@/, ':***@')}`);
}

const STORE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1';
const SLUG = 'turnstile-coverage-store';
const SECRET = 'coverage-secret';

const app = new OpenAPIHono();
app.route('/', auth);
app.route('/', shopExtra);

const saved = {
  NODE_ENV: process.env.NODE_ENV,
  TURNSTILE_DISABLED: process.env.TURNSTILE_DISABLED,
  TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY,
};

async function seedStore(withSecret: boolean): Promise<void> {
  const config = withSecret ? { turnstileSecretKey: SECRET } : {};
  await pool.query(`TRUNCATE store CASCADE`);
  await pool.query(
    `INSERT INTO store (id, slug, name, currency, config) VALUES ($1, $2, $3, $4, $5)`,
    [STORE, SLUG, 'Turnstile coverage', 'USD', JSON.stringify(config)],
  );
  invalidateStoreCache(SLUG);
}

let ipSeq = 0;
function nextIp(): string {
  ipSeq += 1;
  return `198.51.100.${(ipSeq % 200) + 20}`;
}
function headers(): Record<string, string> {
  return { 'content-type': 'application/json', 'x-store-slug': SLUG, 'x-real-ip': nextIp() };
}

const resend = (body: Record<string, unknown>) =>
  app.request('http://localhost/v1/shop/auth/resend-verification', { method: 'POST', headers: headers(), body: JSON.stringify(body) });
const newsletter = (body: Record<string, unknown>) =>
  app.request('http://localhost/v1/shop/newsletter-signup', { method: 'POST', headers: headers(), body: JSON.stringify(body) });
const track = (query: Record<string, string>) =>
  app.request(`http://localhost/v1/shop/track?${new URLSearchParams(query)}`, { headers: headers() });

/** Siteverify stub: success only for the token 'good'. */
function stubSiteverify(): void {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = new URLSearchParams(init.body as string);
    return new Response(JSON.stringify({ success: body.get('response') === 'good' }), { status: 200 });
  }));
}

function restoreEnv(): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k as keyof typeof saved]; else process.env[k as keyof typeof saved] = v;
  }
  vi.unstubAllGlobals();
}

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  delete process.env.TURNSTILE_DISABLED;
  delete process.env.TURNSTILE_SECRET_KEY;
});
afterAll(restoreEnv);

const EMAIL = 'shopper@turnstile-coverage.dev';

describe('resend-verification Turnstile gate', () => {
  it('configured store: no token → 403 BOT_CHECK_FAILED; invalid token → 403', async () => {
    await seedStore(true);
    stubSiteverify();
    const none = await resend({ email: EMAIL });
    expect(none.status).toBe(403);
    expect((await none.json() as { error?: { code?: string } }).error?.code).toBe('BOT_CHECK_FAILED');
    expect((await resend({ email: EMAIL, turnstileToken: 'bad' })).status).toBe(403);
  });

  it('configured store: valid token → 200 (enumeration-safe)', async () => {
    await seedStore(true);
    stubSiteverify();
    expect((await resend({ email: EMAIL, turnstileToken: 'good' })).status).toBe(200);
  });

  it('production, no secret, no opt-out → 403', async () => {
    await seedStore(false);
    process.env.NODE_ENV = 'production';
    expect((await resend({ email: EMAIL })).status).toBe(403);
  });

  it('production, no secret, TURNSTILE_DISABLED=true → 200', async () => {
    await seedStore(false);
    process.env.NODE_ENV = 'production';
    process.env.TURNSTILE_DISABLED = 'true';
    expect((await resend({ email: EMAIL })).status).toBe(200);
  });

  it('dev/test, no secret → 200 (unchanged)', async () => {
    await seedStore(false);
    expect((await resend({ email: EMAIL })).status).toBe(200);
  });
});

describe('newsletter-signup Turnstile gate', () => {
  const body = { email: 'reader@turnstile-coverage.dev', source: 'storefront' };

  it('configured store: no token → 403; invalid token → 403; valid token → 200', async () => {
    await seedStore(true);
    stubSiteverify();
    const none = await newsletter(body);
    expect(none.status).toBe(403);
    expect((await none.json() as { error?: { code?: string } }).error?.code).toBe('BOT_CHECK_FAILED');
    expect((await newsletter({ ...body, turnstileToken: 'bad' })).status).toBe(403);
    expect((await newsletter({ ...body, turnstileToken: 'good' })).status).toBe(200);
  });

  it('production, no secret, no opt-out → 403', async () => {
    await seedStore(false);
    process.env.NODE_ENV = 'production';
    expect((await newsletter(body)).status).toBe(403);
  });

  it('production, no secret, TURNSTILE_DISABLED=true → 200', async () => {
    await seedStore(false);
    process.env.NODE_ENV = 'production';
    process.env.TURNSTILE_DISABLED = 'true';
    expect((await newsletter(body)).status).toBe(200);
  });
});

describe('order tracking (GET /v1/shop/track) Turnstile gate', () => {
  const q = { code: 'SR-NOPE', email: EMAIL };

  it('configured store: no token → 403 before any order lookup; valid token → passes gate (404 for unknown order)', async () => {
    await seedStore(true);
    stubSiteverify();
    const none = await track(q);
    expect(none.status).toBe(403);
    expect((await none.json() as { error?: { code?: string } }).error?.code).toBe('BOT_CHECK_FAILED');
    expect((await track({ ...q, turnstileToken: 'bad' })).status).toBe(403);
    expect((await track({ ...q, turnstileToken: 'good' })).status).toBe(404);
  });

  it('production, no secret, no opt-out → 403', async () => {
    await seedStore(false);
    process.env.NODE_ENV = 'production';
    expect((await track(q)).status).toBe(403);
  });

  it('production, no secret, TURNSTILE_DISABLED=true → passes gate (404 unknown order)', async () => {
    await seedStore(false);
    process.env.NODE_ENV = 'production';
    process.env.TURNSTILE_DISABLED = 'true';
    expect((await track(q)).status).toBe(404);
  });
});
