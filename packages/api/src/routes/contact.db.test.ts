/**
 * DB tests for PAR-01 (public contact form). Runs against the lane test DB
 * only — mirrors shop-extra.subscriber.test.ts's wipe + seed pattern.
 *
 * Covers:
 *   - validation (zod 400s), honeypot fake-success, per-IP rate limit
 *   - signed confirm-before-deliver: POST persists pending + enqueues the
 *     'contact_confirm' email; nothing reaches the team until the link click
 *   - first valid click → pending→delivered + 'contact_team' (per-store team
 *     inbox) + 'contact_ack' (submitter) enqueued atomically
 *   - duplicate click / prefetch suppression: second click sends nothing
 *   - tampered sig → 403, expired ts → 410, per-address mailbomb guard
 *   - per-store team routing via store.config.notifications.contactEmail
 *   - Turnstile: disabled (no secret) → passes; configured + bad token → 400
 *
 * The outbox is asserted directly — the scheduler/mailer is the boundary.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { OpenAPIHono } from '@hono/zod-openapi';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { contactRoutes, buildConfirmUrl } from './contact.js';
import { shopExtra } from './shop-extra.js';
import { invalidateStoreCache } from '../store-context.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(
    `contact test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@]+@/, ':***@')}`,
  );
}

const STORE = 'dddddddd-dddd-dddd-dddd-dddddddddddc';
const SLUG = 'contact-test-store';
const TEAM = 'team@contact-test.dev';
const STORE_B = 'dddddddd-dddd-dddd-dddd-dddddddddddb';
const SLUG_B = 'contact-test-store-b';
const TEAM_B = 'team-b@contact-test.dev';

const app = new OpenAPIHono();
app.route('/', contactRoutes);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
}

async function seedStore(id: string, slug: string, contactEmail: string): Promise<void> {
  await pool.query(
    `INSERT INTO store (id, slug, name, currency, config) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO UPDATE SET config = $5`,
    [id, slug, `Store ${slug}`, 'USD', JSON.stringify({ notifications: { contactEmail } })],
  );
  // The resolver caches by slug — drop the cached pre-seed row.
  invalidateStoreCache(slug);
}

let ipSeq = 0;
async function submit(body: Record<string, unknown>, slug = SLUG): Promise<Response> {
  ipSeq += 1;
  return app.request('http://localhost/v1/shop/contact', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-store-slug': slug,
      'x-real-ip': `198.51.100.${ipSeq % 250}`, // TEST-NET-2 — unique IP per call, bucket tested separately
    },
    body: JSON.stringify(body),
  });
}

// NOTE: these helpers run through the owner pool (BYPASSRLS) — filter by
// store_id explicitly, otherwise cross-tenant rows leak into assertions.
async function outbox(kind: string, storeId = STORE): Promise<Array<{ recipient: string; payload: { html: string; to: string } }>> {
  return withStore(storeId, async (tx) => {
    const r = await tx.execute(
      sql`SELECT recipient, payload FROM email_outbox WHERE store_id = ${storeId} AND kind = ${kind} ORDER BY created_at`,
    );
    return r.rows as Array<{ recipient: string; payload: { html: string; to: string } }>;
  });
}

async function submissions(email: string, storeId = STORE): Promise<Array<{ id: string; status: string }>> {
  return withStore(storeId, async (tx) => {
    const r = await tx.execute(
      sql`SELECT id, status FROM contact_submission WHERE store_id = ${storeId} AND email = ${email} ORDER BY created_at`,
    );
    return r.rows as Array<{ id: string; status: string }>;
  });
}

/** Pull the signed confirm URL out of the queued confirmation email. */
async function confirmPathFor(email: string, storeId = STORE): Promise<string> {
  const mails = await outbox('contact_confirm', storeId);
  const mail = mails.find((m) => m.recipient === email);
  expect(mail, `no contact_confirm email for ${email}`).toBeDefined();
  const m = mail!.payload.html.match(/\/v1\/shop\/contact\/confirm\?[^"<]+/);
  expect(m).toBeTruthy();
  return m![0].replaceAll('&amp;', '&');
}

const VALID = { name: 'Ada', email: 'ada@example.com', subject: 'Order question', message: 'Where is my order?' };

afterAll(async () => {
  await wipe();
  await pool.end();
});

describe('contact form (PAR-01) — submit', () => {
  beforeEach(async () => {
    await wipe();
    await seedStore(STORE, SLUG, TEAM);
  });

  it('persists pending + enqueues the signed confirmation email in one txn; delivers nothing yet', async () => {
    const res = await submit(VALID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: 'Check your email to confirm your submission.' });

    const rows = await submissions('ada@example.com');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');

    const confirms = await outbox('contact_confirm');
    expect(confirms).toHaveLength(1);
    expect(confirms[0]!.recipient).toBe('ada@example.com');
    expect(confirms[0]!.payload.html).toContain('/v1/shop/contact/confirm?id=');
    // Confirm-before-deliver: no team/ack mail exists pre-click.
    expect(await outbox('contact_team')).toHaveLength(0);
    expect(await outbox('contact_ack')).toHaveLength(0);
  });

  it('rejects invalid input with 400 and writes nothing', async () => {
    for (const body of [
      { ...VALID, name: '' },
      { ...VALID, email: 'not-an-email' },
      { ...VALID, subject: '' },
      { ...VALID, message: '' },
      { ...VALID, message: 'x'.repeat(5001) },
      { ...VALID, name: 'x'.repeat(201) },
    ]) {
      const res = await submit(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await submissions('ada@example.com')).toHaveLength(0);
  });

  it('fake-succeeds on a filled honeypot without persisting or emailing', async () => {
    for (const field of ['honeypot', 'website']) {
      const res = await submit({ ...VALID, email: `hp-${field}@example.com`, [field]: 'spammy' });
      expect(res.status).toBe(200);
    }
    expect(await submissions('hp-honeypot@example.com')).toHaveLength(0);
    expect(await submissions('hp-website@example.com')).toHaveLength(0);
    expect(await outbox('contact_confirm')).toHaveLength(0);
  });

  it('rate-limits the public endpoint at 5/hour per IP', async () => {
    const ip = '192.0.2.77';
    for (let i = 0; i < 5; i++) {
      const res = await app.request('http://localhost/v1/shop/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-store-slug': SLUG, 'x-real-ip': ip },
        body: JSON.stringify({ ...VALID, email: `rl${i}@example.com` }),
      });
      expect(res.status).toBe(200);
    }
    const res = await app.request('http://localhost/v1/shop/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-store-slug': SLUG, 'x-real-ip': ip },
      body: JSON.stringify({ ...VALID, email: 'rl-over@example.com' }),
    });
    expect(res.status).toBe(429);
  });

  it('suppresses a repeat submission for the same address inside the 1h cooldown (mailbomb guard)', async () => {
    await submit(VALID);
    const res = await submit(VALID); // same email, seconds later
    expect(res.status).toBe(200);
    expect(await submissions('ada@example.com')).toHaveLength(1);
    expect((await outbox('contact_confirm')).filter((m) => m.recipient === 'ada@example.com')).toHaveLength(1);
  });

  it('rejects the submission when Turnstile is configured and the token fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false }), { status: 200 })));
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    try {
      const res = await submit(VALID);
      expect(res.status).toBe(400);
      // Missing token while configured also fails closed.
      const res2 = await submit({ ...VALID, turnstileToken: 'x' });
      expect(res2.status).toBe(400);
      expect(await submissions('ada@example.com')).toHaveLength(0);
    } finally {
      delete process.env.TURNSTILE_SECRET_KEY;
      vi.unstubAllGlobals();
    }
  });

  it('accepts when Turnstile is configured and siteverify succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 })));
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    try {
      const res = await submit({ ...VALID, turnstileToken: 'good' });
      expect(res.status).toBe(200);
      expect(await submissions('ada@example.com')).toHaveLength(1);
    } finally {
      delete process.env.TURNSTILE_SECRET_KEY;
      vi.unstubAllGlobals();
    }
  });
});

describe('contact form (PAR-01) — signed confirm + delivery', () => {
  beforeEach(async () => {
    await wipe();
    await seedStore(STORE, SLUG, TEAM);
    await seedStore(STORE_B, SLUG_B, TEAM_B);
  });

  it('delivers to the per-store team inbox + acks the customer on the first valid click', async () => {
    await submit(VALID);
    const path = await confirmPathFor('ada@example.com');
    const res = await app.request(`http://localhost${path}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Message confirmed');

    const rows = await submissions('ada@example.com');
    expect(rows[0]!.status).toBe('delivered');

    const team = await outbox('contact_team');
    expect(team).toHaveLength(1);
    expect(team[0]!.recipient).toBe(TEAM);
    expect(team[0]!.payload.html).toContain('ada@example.com');
    expect(team[0]!.payload.html).toContain('Where is my order?');

    const ack = await outbox('contact_ack');
    expect(ack).toHaveLength(1);
    expect(ack[0]!.recipient).toBe('ada@example.com');
  });

  it('suppresses duplicate clicks / prefetches — no second delivery', async () => {
    await submit(VALID);
    const path = await confirmPathFor('ada@example.com');
    const r1 = await app.request(`http://localhost${path}`);
    const r2 = await app.request(`http://localhost${path}`);
    const r3 = await app.request(`http://localhost${path}`);
    for (const r of [r1, r2, r3]) expect(r.status).toBe(200);
    expect(await outbox('contact_team')).toHaveLength(1);
    expect(await outbox('contact_ack')).toHaveLength(1);
  });

  it('routes to the correct store team on a multi-store deployment', async () => {
    await submit({ ...VALID, email: 'bob@example.com' }, SLUG_B);
    const path = await confirmPathFor('bob@example.com', STORE_B);
    expect(path).toContain(`s=${SLUG_B}`);
    const res = await app.request(`http://localhost${path}`);
    expect(res.status).toBe(200);

    expect(await outbox('contact_team', STORE_B)).toHaveLength(1);
    expect((await outbox('contact_team', STORE_B))[0]!.recipient).toBe(TEAM_B);
    expect(await outbox('contact_team', STORE)).toHaveLength(0);
  });

  it('is reachable through the production mount (shopExtra.route)', async () => {
    const prodApp = new OpenAPIHono();
    prodApp.route('/', shopExtra); // same mount app.ts uses
    const res = await prodApp.request('http://localhost/v1/shop/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-store-slug': SLUG, 'x-real-ip': '198.51.100.240' },
      body: JSON.stringify({ ...VALID, email: 'mounted@example.com' }),
    });
    expect(res.status).toBe(200);
    expect((await submissions('mounted@example.com'))[0]!.status).toBe('pending');
  });

  it('rejects a tampered signature (403) and an expired link (410)', async () => {
    await submit(VALID);
    const path = await confirmPathFor('ada@example.com');
    const u = new URL(`http://localhost${path}`);

    const tampered = new URL(u);
    tampered.searchParams.set('sig', '0'.repeat(64));
    const r1 = await app.request(tampered.toString());
    expect(r1.status).toBe(403);

    // Properly-signed but expired (25h old) link → 410. buildConfirmUrl uses
    // the real signer, so this exercises the age check past the HMAC gate.
    const id = u.searchParams.get('id')!;
    const expiredPath = buildConfirmUrl('http://localhost', SLUG, id, Date.now() - 25 * 60 * 60 * 1000)
      .replace(/^http:\/\/localhost/, '');
    const r2 = await app.request(`http://localhost${expiredPath}`);
    expect(r2.status).toBe(410);

    // Nothing delivered for either failure.
    expect(await outbox('contact_team')).toHaveLength(0);
    expect((await submissions('ada@example.com'))[0]!.status).toBe('pending');
  });
});
