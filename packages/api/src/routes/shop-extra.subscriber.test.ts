/**
 * DB tests for SUBSCRIBER-1 (docs/plans/2026-07-19-subscriber-newsletter-waitlist.md).
 * Runs against sellright_test ONLY — mirrors email/outbox.test.ts's wipe +
 * seed pattern. _test-DB guard hard-fails if pointed at a non-test DB.
 *
 * Covers the full lifecycle:
 *   1. POST /v1/shop/newsletter-signup  → persists pending + enqueues
 *      confirmation email in the same transaction (the whole point — a
 *      rolled-back signup must never leave a dangling email and vice versa).
 *   2. The same endpoint's idempotency: a second POST for a confirmed row
 *      does NOT re-enqueue (mailbomb guard at the per-row level), an
 *      unsubscribed row goes back to pending + re-enqueues, and a fresh
 *      address inserts.
 *   3. The per-address 1/hr cooldown: a second POST within the hour is
 *      silently dropped (no second email), even on a pending row.
 *   4. GET /v1/shop/subscriber/confirm/:token → pending becomes confirmed;
 *      a second confirm is idempotent; an unknown token returns the same
 *      generic HTML page (enumeration defense).
 *   5. POST /v1/shop/subscriber/unsubscribe/:token → confirmed becomes
 *      unsubscribed (RFC 8058 one-click); idempotent on the second call.
 *
 * The email outbox is asserted directly (we don't need a mailer mock — the
 * scheduler is the test boundary, not the SMTP transport).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { OpenAPIHono } from '@hono/zod-openapi';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { shopExtra } from './shop-extra.js';
import { subscriberRoutes } from './shop-extra.subscriber.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(
    `subscriber test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@]+@/, ':***@')}`,
  );
}

const STORE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const SLUG = 'subscriber-test-store';

const app = new OpenAPIHono();
app.route('/', shopExtra);
app.route('/', subscriberRoutes);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
}

async function seedStore(): Promise<void> {
  await pool.query(
    `INSERT INTO store (id, slug, name, currency) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
    [STORE, SLUG, 'Subscriber Test Store', 'USD'],
  );
}

/** Number of pending emails in the outbox for this store, partitioned by kind. */
async function outboxCount(kind: string): Promise<number> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT count(*)::int AS n FROM email_outbox WHERE kind = ${kind}`);
    return (r.rows[0] as { n: number }).n;
  });
}

async function rowByEmail(email: string): Promise<{ id: string; status: string; token: string; lastSentAt: Date | null; topic: string } | undefined> {
  return withStore(STORE, async (tx) => {
    const [r] = await tx.select({
      id: s.subscriber.id,
      status: s.subscriber.status,
      token: s.subscriber.token,
      lastSentAt: s.subscriber.lastSentAt,
      topic: s.subscriber.topic,
    }).from(s.subscriber).where(eq(s.subscriber.email, email)).limit(1);
    return r;
  });
}

import { eq } from 'drizzle-orm';

// The per-IP throttle in shop-extra.newsletter-limit.ts is a module-level Map
// that lives for the whole vitest process — 5 attempts per 15 min per IP. These
// tests make far more signup calls than that in aggregate, so without a distinct
// IP per call the bucket exhausts and later tests see 429 instead of the status
// they are actually asserting. Each request therefore gets its own x-real-ip
// (the default TRUSTED_PROXY_HEADER, see env.ts). The throttle itself is covered
// separately in shop-extra.newsletter.test.ts.
let ipSeq = 0;
async function signup(body: Record<string, unknown>): Promise<Response> {
  ipSeq += 1;
  return app.request(`http://localhost/v1/shop/newsletter-signup`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-store-slug': SLUG,
      'x-real-ip': `203.0.113.${ipSeq % 254}`, // TEST-NET-3, never routable
    },
    body: JSON.stringify(body),
  });
}

// `pool` is a module-level singleton shared by both describe blocks, so it can
// only be closed once, after the LAST of them. A per-describe afterAll that ends
// it kills the pool for every later block ("Cannot use a pool after calling end
// on the pool"). One file-level teardown owns it.
afterAll(async () => {
  await wipe();
  await pool.end();
});

describe('subscriber (SUBSCRIBER-1) — signup persistence', () => {
  beforeEach(async () => {
    await wipe();
    await seedStore();
  });

  it('persists a pending row AND enqueues a confirmation email in the same txn', async () => {
    const before = await outboxCount('subscriber_newsletter_confirm');
    const res = await signup({ email: 'first@example.com', name: 'First' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });

    const row = await rowByEmail('first@example.com');
    expect(row?.status).toBe('pending');
    expect(row?.topic).toBe('');
    expect(row?.lastSentAt).not.toBeNull();

    const after = await outboxCount('subscriber_newsletter_confirm');
    expect(after - before).toBe(1);
  });

  it('treats a duplicate signup of a pending address as a no-op (no second email) — within the 1hr cooldown', async () => {
    await signup({ email: 'pending@example.com' });
    const before = await outboxCount('subscriber_newsletter_confirm');
    const res = await signup({ email: 'pending@example.com' });
    expect(res.status).toBe(200);
    const after = await outboxCount('subscriber_newsletter_confirm');
    expect(after).toBe(before); // 1/hr cooldown: silently dropped.
  });

  it('does not duplicate for an already-confirmed row (mailbomb guard, status-aware)', async () => {
    await signup({ email: 'confirmed@example.com' });
    // Force into confirmed without going through the token — we're testing
    // the signup's status-awareness, not the confirm endpoint here.
    await withStore(STORE, async (tx) => {
      await tx.update(s.subscriber).set({ status: 'confirmed', confirmedAt: new Date() }).where(eq(s.subscriber.email, 'confirmed@example.com'));
    });
    const before = await outboxCount('subscriber_newsletter_confirm');
    const res = await signup({ email: 'confirmed@example.com' });
    expect(res.status).toBe(200);
    const after = await outboxCount('subscriber_newsletter_confirm');
    expect(after).toBe(before); // confirmed → silent no-op.
  });

  it('flips unsubscribed back to pending and re-enqueues confirmation (re-consent path)', async () => {
    await signup({ email: 'unsubbed@example.com' });
    // Simulate unsubscribed.
    await withStore(STORE, async (tx) => {
      await tx.update(s.subscriber).set({ status: 'unsubscribed', unsubscribedAt: new Date() }).where(eq(s.subscriber.email, 'unsubbed@example.com'));
    });
    const before = await outboxCount('subscriber_newsletter_confirm');
    const res = await signup({ email: 'unsubbed@example.com' });
    expect(res.status).toBe(200);
    const row = await rowByEmail('unsubbed@example.com');
    expect(row?.status).toBe('pending');
    const after = await outboxCount('subscriber_newsletter_confirm');
    expect(after - before).toBe(1);
  });

  it('treats the general newsletter and a waitlist as different lists (one row per kind+topic)', async () => {
    await signup({ email: 'shared@example.com', kind: 'newsletter' });
    await signup({ email: 'shared@example.com', kind: 'waitlist', topic: 'scraperight' });
    const newsRow = await withStore(STORE, async (tx) =>
      (await tx.select({ status: s.subscriber.status, topic: s.subscriber.topic }).from(s.subscriber).where(eq(s.subscriber.email, 'shared@example.com'))),
    );
    expect(newsRow.find((r) => r.topic === '')).toBeDefined();
    expect(newsRow.find((r) => r.topic === 'scraperight')).toBeDefined();
  });

  it('lower-cases and trims the email before persisting', async () => {
    await signup({ email: '  MIXED@Example.COM  ' });
    const row = await rowByEmail('mixed@example.com');
    expect(row).toBeDefined();
  });
});

describe('subscriber (SUBSCRIBER-1) — confirm + unsubscribe', () => {
  beforeEach(async () => {
    await wipe();
    await seedStore();
  });
  // No pool teardown here — the file-level afterAll owns it (see top of file).

  it('GET confirm/:token flips pending → confirmed; idempotent on second call', async () => {
    await signup({ email: 'confirmme@example.com' });
    const pending = await rowByEmail('confirmme@example.com');
    expect(pending?.status).toBe('pending');

    const res1 = await app.request(`http://localhost/v1/shop/subscriber/confirm/${pending!.token}`, { headers: { 'x-store-slug': SLUG } });
    expect(res1.status).toBe(200);
    expect(res1.headers.get('content-type')).toMatch(/text\/html/);
    const after1 = await rowByEmail('confirmme@example.com');
    expect(after1?.status).toBe('confirmed');

    const res2 = await app.request(`http://localhost/v1/shop/subscriber/confirm/${pending!.token}`, { headers: { 'x-store-slug': SLUG } });
    expect(res2.status).toBe(200); // idempotent
    const after2 = await rowByEmail('confirmme@example.com');
    expect(after2?.status).toBe('confirmed');
  });

  it('GET confirm/:token returns the same generic HTML on an unknown token (enumeration defense)', async () => {
    const fakeToken = '00000000-0000-0000-0000-000000000000';
    const res = await app.request(`http://localhost/v1/shop/subscriber/confirm/${fakeToken}`, { headers: { 'x-store-slug': SLUG } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Subscription confirmed');
  });

  it('POST unsubscribe/:token flips confirmed → unsubscribed (RFC 8058 one-click)', async () => {
    await signup({ email: 'unsub@example.com' });
    const row = await rowByEmail('unsub@example.com');
    await withStore(STORE, async (tx) => {
      await tx.update(s.subscriber).set({ status: 'confirmed', confirmedAt: new Date() }).where(eq(s.subscriber.id, row!.id));
    });
    const res = await app.request(`http://localhost/v1/shop/subscriber/unsubscribe/${row!.token}`, {
      method: 'POST',
      headers: { 'x-store-slug': SLUG },
    });
    expect(res.status).toBe(200);
    const after = await rowByEmail('unsub@example.com');
    expect(after?.status).toBe('unsubscribed');

    // Idempotent: a second POST is still 200, still unsubscribed.
    const res2 = await app.request(`http://localhost/v1/shop/subscriber/unsubscribe/${row!.token}`, {
      method: 'POST',
      headers: { 'x-store-slug': SLUG },
    });
    expect(res2.status).toBe(200);
    const after2 = await rowByEmail('unsub@example.com');
    expect(after2?.status).toBe('unsubscribed');
  });

  it('GET unsubscribe/:token returns the landing page form without unsubscribing', async () => {
    await signup({ email: 'land@example.com' });
    const row = await rowByEmail('land@example.com');
    await withStore(STORE, async (tx) => {
      await tx.update(s.subscriber).set({ status: 'confirmed', confirmedAt: new Date() }).where(eq(s.subscriber.id, row!.id));
    });
    const res = await app.request(`http://localhost/v1/shop/subscriber/unsubscribe/${row!.token}`, { headers: { 'x-store-slug': SLUG } });
    expect(res.status).toBe(200);
    const after = await rowByEmail('land@example.com');
    expect(after?.status).toBe('confirmed'); // GET does NOT unsubscribe — mail-scanner safe.
  });
});
