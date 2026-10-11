/**
 * DB integration tests for POST /v1/shop/auth/google account linking. Google's
 * tokeninfo endpoint is mocked; the handler runs for real.
 *
 * Covers: gmail links by email; Workspace with matching hd links; a
 * non-Google-hosted address with no hd neither links nor signs in; an already
 * linked Google subject still signs in; a brand-new email creates an account.
 *
 * Runs against sellright_test ONLY (these wipe data).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq, sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { auth } from './auth.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`auth.google test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE = 'aaaaaaaa-3333-3333-3333-333333333333';
const SLUG = 'auth-google-test-store';
const CLIENT = 'test-google-client';

const app = new OpenAPIHono();
app.route('/', auth);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
}

beforeEach(async () => {
  await wipe();
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, ${SLUG}, ${SLUG}, 'USD', ${JSON.stringify({ googleClientId: CLIENT })}::jsonb)`);
  });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { await wipe(); await pool.end(); });

function mockGoogle(payload: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ aud: CLIENT, email_verified: 'true', ...payload }), { status: 200 })));
}
const signIn = () => app.request('/v1/shop/auth/google', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-store-slug': SLUG },
  body: JSON.stringify({ credential: 'c'.repeat(40) }),
});
async function seedCustomer(email: string, googleSub: string | null = null) {
  await withStore(STORE, async (tx) => {
    await tx.insert(s.customer).values({ storeId: STORE, email, emailVerified: true, googleSub });
  });
}
const byEmail = (email: string) => withStore(STORE, async (tx) => (await tx.select().from(s.customer).where(eq(s.customer.email, email)).limit(1))[0] ?? null);
const sessionCount = async () => (await pool.query('SELECT count(*)::int AS n FROM "session"')).rows[0].n as number;

describe('POST /v1/shop/auth/google linking', () => {
  it('links an existing account by email for a gmail address', async () => {
    await seedCustomer('owner@gmail.com');
    mockGoogle({ sub: 'g-1', email: 'owner@gmail.com' });
    const res = await signIn();
    expect(res.status).toBe(200);
    expect((await byEmail('owner@gmail.com'))?.googleSub).toBe('g-1');
  });

  it('links a Workspace address whose hd matches the email domain', async () => {
    await seedCustomer('staff@corp.example');
    mockGoogle({ sub: 'g-2', email: 'staff@corp.example', hd: 'corp.example' });
    const res = await signIn();
    expect(res.status).toBe(200);
    expect((await byEmail('staff@corp.example'))?.googleSub).toBe('g-2');
  });

  it('does not link or sign in a non-Google-hosted address without hd', async () => {
    await seedCustomer('owner@corp.example');
    mockGoogle({ sub: 'g-3', email: 'owner@corp.example' });
    const res = await signIn();
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('EMAIL_TAKEN');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await byEmail('owner@corp.example'))?.googleSub).toBeNull();
    expect(await sessionCount()).toBe(0);
  });

  it('does not link when hd names a different domain', async () => {
    await seedCustomer('owner@corp.example');
    mockGoogle({ sub: 'g-4', email: 'owner@corp.example', hd: 'other.example' });
    expect((await signIn()).status).toBe(409);
    expect((await byEmail('owner@corp.example'))?.googleSub).toBeNull();
  });

  it('still signs in an already-linked Google subject on any address', async () => {
    await seedCustomer('owner@corp.example', 'g-5');
    mockGoogle({ sub: 'g-5', email: 'owner@corp.example' });
    const res = await signIn();
    expect(res.status).toBe(200);
    expect(await sessionCount()).toBe(1);
  });

  it('creates an account for a brand-new email', async () => {
    mockGoogle({ sub: 'g-6', email: 'fresh@corp.example', given_name: 'Fresh' });
    const res = await signIn();
    expect(res.status).toBe(200);
    expect(await byEmail('fresh@corp.example')).toMatchObject({ googleSub: 'g-6', emailVerified: true });
  });
});
