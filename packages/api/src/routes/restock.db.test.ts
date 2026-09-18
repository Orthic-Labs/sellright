/**
 * DB tests for PAR-05 (back-in-stock automation). Runs against the lane test
 * DB only — same wipe + seed pattern as the other route db tests.
 *
 * Covers:
 *   - POST /v1/shop/restock-request: validation, honeypot, variant existence,
 *     already-in-stock no-op, idempotent re-submit, rate limit
 *   - restock trigger path: stock 0→>0 fires the DB trigger → restock_event;
 *     sweepRestockEvents drains it and enqueues 'restock_notify' via outbox
 *   - notifyRestock(storeId, variantId): the direct-call API for stock write
 *     sites; once-per-restock dedupe; OOS→OOS and IS→IS moves no-op
 *   - consent: canceled rows are never emailed; cancel endpoint via token
 *   - tenant routing: a restock in store A never touches store B's requests
 *   - re-arm: after being notified, an email may sign up again and is
 *     notified on the NEXT restock cycle
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { OpenAPIHono } from '@hono/zod-openapi';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { restockRoutes, notifyRestock, sweepRestockEvents } from './restock.js';
import { invalidateStoreCache } from '../store-context.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(
    `restock test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@]+@/, ':***@')}`,
  );
}

// Valid v4-shaped UUIDs — the public schema validates variantId as uuid.
const A = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const SLUG_A = 'restock-test-a';
const B = 'bbbbbbbb-0000-4000-8000-0000000000b1';
const SLUG_B = 'restock-test-b';
const VARIANT_A = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const VARIANT_A2 = 'aaaaaaaa-0000-4000-8000-0000000000a3';
const VARIANT_B = 'bbbbbbbb-0000-4000-8000-0000000000b2';

const app = new OpenAPIHono();
app.route('/', restockRoutes);

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('DELETE FROM "session"');
}

async function seedStore(id: string, slug: string): Promise<void> {
  await pool.query(`INSERT INTO store (id, slug, name, currency) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`, [id, slug, `Store ${slug}`, 'USD']);
  invalidateStoreCache(slug);
}

/** Seed a product + enabled variant + stock row at `onHand` inside store ctx. */
async function seedVariant(storeId: string, variantId: string, sku: string, onHand: number): Promise<void> {
  await withStore(storeId, async (tx) => {
    const pid = crypto.randomUUID();
    await tx.execute(sql`INSERT INTO product (id, store_id, slug, name, status) VALUES (${pid}, ${storeId}, ${`p-${sku}`}, ${`Product ${sku}`}, 'active')`);
    await tx.execute(sql`INSERT INTO product_variant (id, store_id, product_id, sku, name, price) VALUES (${variantId}, ${storeId}, ${pid}, ${sku}, ${`Variant ${sku}`}, 1000)`);
    await tx.execute(sql`INSERT INTO stock (variant_id, store_id, on_hand, allocated) VALUES (${variantId}, ${storeId}, ${onHand}, 0)`);
  });
}

async function setOnHand(storeId: string, variantId: string, onHand: number): Promise<void> {
  await withStore(storeId, async (tx) => {
    await tx.execute(sql`UPDATE stock SET on_hand = ${onHand} WHERE variant_id = ${variantId}`);
  });
}

let ipSeq = 0;
async function subscribe(body: Record<string, unknown>, slug = SLUG_A): Promise<Response> {
  ipSeq += 1;
  return app.request('http://localhost/v1/shop/restock-request', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-store-slug': slug,
      'x-real-ip': `198.51.101.${ipSeq % 250}`,
    },
    body: JSON.stringify(body),
  });
}

// NOTE: these helpers run through the owner pool (BYPASSRLS) — filter by
// store_id explicitly, otherwise cross-tenant rows leak into assertions.
async function requests(storeId: string, variantId?: string): Promise<Array<{ email: string; status: string; token: string }>> {
  return withStore(storeId, async (tx) => {
    const r = variantId
      ? await tx.execute(sql`SELECT email, status, token FROM restock_request WHERE store_id = ${storeId} AND variant_id = ${variantId} ORDER BY created_at`)
      : await tx.execute(sql`SELECT email, status, token FROM restock_request WHERE store_id = ${storeId} ORDER BY created_at`);
    return r.rows as Array<{ email: string; status: string; token: string }>;
  });
}

async function events(storeId: string): Promise<Array<{ variant_id: string; processed_at: Date | null }>> {
  return withStore(storeId, async (tx) => {
    const r = await tx.execute(sql`SELECT variant_id, processed_at FROM restock_event WHERE store_id = ${storeId} ORDER BY created_at`);
    return r.rows as Array<{ variant_id: string; processed_at: Date | null }>;
  });
}

async function restockMails(storeId: string): Promise<Array<{ recipient: string; payload: { html: string } }>> {
  return withStore(storeId, async (tx) => {
    const r = await tx.execute(sql`SELECT recipient, payload FROM email_outbox WHERE store_id = ${storeId} AND kind = 'restock_notify' ORDER BY created_at`);
    return r.rows as Array<{ recipient: string; payload: { html: string } }>;
  });
}

afterAll(async () => {
  await wipe();
  await pool.end();
});

describe('restock request (PAR-05) — subscribe', () => {
  beforeEach(async () => {
    await wipe();
    await seedStore(A, SLUG_A);
    await seedVariant(A, VARIANT_A, 'A1', 0); // out of stock
    await seedVariant(A, VARIANT_A2, 'A2', 7); // in stock
  });

  it('records a pending request for an OOS variant', async () => {
    const res = await subscribe({ variantId: VARIANT_A, email: 'sam@example.com' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const rows = await requests(A, VARIANT_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
  });

  it('is idempotent while pending — a double submit writes one row', async () => {
    await subscribe({ variantId: VARIANT_A, email: 'sam@example.com' });
    await subscribe({ variantId: VARIANT_A, email: 'sam@example.com' });
    expect(await requests(A, VARIANT_A)).toHaveLength(1);
  });

  it('no-ops when the variant is already in stock', async () => {
    const res = await subscribe({ variantId: VARIANT_A2, email: 'sam@example.com' });
    expect(res.status).toBe(200);
    expect(await requests(A, VARIANT_A2)).toHaveLength(0);
  });

  it('404s an unknown variant and 400s bad input; honeypot fakes success', async () => {
    expect((await subscribe({ variantId: crypto.randomUUID(), email: 'x@example.com' })).status).toBe(404);
    expect((await subscribe({ variantId: VARIANT_A, email: 'nope' })).status).toBe(400);
    expect((await subscribe({ variantId: VARIANT_A, email: 'hp@example.com', honeypot: 'x' })).status).toBe(200);
    expect(await requests(A, VARIANT_A)).toHaveLength(0);
  });
});

describe('restock request (PAR-05) — notify', () => {
  beforeEach(async () => {
    await wipe();
    await seedStore(A, SLUG_A);
    await seedStore(B, SLUG_B);
    await seedVariant(A, VARIANT_A, 'A1', 0);
    await seedVariant(B, VARIANT_B, 'B1', 0);
  });

  it('notifies each pending subscriber once when the variant crosses 0→>0 (sweep path)', async () => {
    await subscribe({ variantId: VARIANT_A, email: 'one@example.com' });
    await subscribe({ variantId: VARIANT_A, email: 'two@example.com' });

    // The stock write itself lands the trigger event — no notifier call yet.
    await setOnHand(A, VARIANT_A, 5);
    const ev = await events(A);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.processed_at).toBeNull();

    const res = await sweepRestockEvents();
    expect(res.events).toBe(1);
    expect(res.notified).toBe(2);

    const mails = await restockMails(A);
    expect(mails.map((m) => m.recipient).sort()).toEqual(['one@example.com', 'two@example.com']);
    expect(mails[0]!.payload.html).toContain('Product A1');
    expect(mails[0]!.payload.html).toContain('/products/p-A1');
    expect(mails[0]!.payload.html).toContain('/v1/shop/restock-request/cancel/');

    const rows = await requests(A, VARIANT_A);
    expect(rows.every((r) => r.status === 'notified')).toBe(true);
    expect((await events(A))[0]!.processed_at).not.toBeNull();
  });

  it('dedupes: a second sweep / direct notifyRestock sends nothing more', async () => {
    await subscribe({ variantId: VARIANT_A, email: 'one@example.com' });
    await setOnHand(A, VARIANT_A, 5);
    await sweepRestockEvents();
    expect((await restockMails(A))).toHaveLength(1);

    expect(await sweepRestockEvents()).toEqual({ events: 0, notified: 0 });
    expect(await notifyRestock(A, VARIANT_A)).toBe(0);
    expect((await restockMails(A))).toHaveLength(1);
  });

  it('no-ops on writes that do not cross into stock (OOS→OOS, IS→IS)', async () => {
    await subscribe({ variantId: VARIANT_A, email: 'one@example.com' });
    await setOnHand(A, VARIANT_A, 0); // still OOS — no event
    expect(await events(A)).toHaveLength(0);
    expect(await notifyRestock(A, VARIANT_A)).toBe(0);

    await setOnHand(A, VARIANT_A, 4); // → in stock
    await setOnHand(A, VARIANT_A, 9); // IS→IS: no NEW pending event
    const ev = await events(A);
    expect(ev).toHaveLength(1);
    await sweepRestockEvents();
    expect((await restockMails(A))).toHaveLength(1);
  });

  it('direct notifyRestock(storeId, variantId) is the call-site API and also dedupes', async () => {
    await subscribe({ variantId: VARIANT_A, email: 'direct@example.com' });
    await setOnHand(A, VARIANT_A, 3);
    expect(await notifyRestock(A, VARIANT_A)).toBe(1);
    expect(await notifyRestock(A, VARIANT_A)).toBe(0);
    // The trigger event the stock write left behind is swept without re-send.
    const res = await sweepRestockEvents();
    expect(res.notified).toBe(0);
    expect((await restockMails(A))).toHaveLength(1);
  });

  it('respects consent: a canceled request is never emailed', async () => {
    await subscribe({ variantId: VARIANT_A, email: 'gone@example.com' });
    const [row] = await requests(A, VARIANT_A);
    const landing = await app.request(`http://localhost/v1/shop/restock-request/cancel/${row!.token}`);
    expect(landing.status).toBe(200);
    // GET is a landing page — the request survives a mail-scanner prefetch.
    expect((await requests(A, VARIANT_A))[0]!.status).toBe('pending');
    const res = await app.request(`http://localhost/v1/shop/restock-request/cancel/${row!.token}`, { method: 'POST', headers: { 'x-store-slug': SLUG_A } });
    expect(res.status).toBe(200);
    expect((await requests(A, VARIANT_A))[0]!.status).toBe('canceled');

    await setOnHand(A, VARIANT_A, 5);
    await sweepRestockEvents();
    expect((await restockMails(A))).toHaveLength(0);
  });

  it('stays inside the tenant: restocking store A never notifies store B requests', async () => {
    await subscribe({ variantId: VARIANT_B, email: 'b@example.com' }, SLUG_B);
    await subscribe({ variantId: VARIANT_A, email: 'a@example.com' });

    await setOnHand(A, VARIANT_A, 2);
    await sweepRestockEvents();

    expect((await restockMails(A)).map((m) => m.recipient)).toEqual(['a@example.com']);
    expect(await restockMails(B)).toHaveLength(0);
    // Store B cannot even see store A's rows under RLS is covered globally;
    // here: B's request is untouched by A's restock.
    expect((await requests(B, VARIANT_B))[0]!.status).toBe('pending');
  });

  it('also notifies confirmed topic-waitlist subscribers (restock:<variantId>), pending ones never', async () => {
    // The existing subscriber system: kind='waitlist', topic='restock:<vid>'.
    await withStore(A, async (tx) => {
      await tx.execute(sql`INSERT INTO subscriber (store_id, email, kind, topic, status, confirmed_at)
        VALUES (${A}, 'confirmed@example.com', 'waitlist', ${`restock:${VARIANT_A}`}, 'confirmed', now())`);
      await tx.execute(sql`INSERT INTO subscriber (store_id, email, kind, topic, status)
        VALUES (${A}, 'pending@example.com', 'waitlist', ${`restock:${VARIANT_A}`}, 'pending')`);
      // A different topic must not be claimed.
      await tx.execute(sql`INSERT INTO subscriber (store_id, email, kind, topic, status, confirmed_at)
        VALUES (${A}, 'other@example.com', 'waitlist', 'scraperight', 'confirmed', now())`);
    });

    await setOnHand(A, VARIANT_A, 3);
    await sweepRestockEvents();

    const mails = await restockMails(A);
    expect(mails.map((m) => m.recipient)).toEqual(['confirmed@example.com']);

    const subs = await withStore(A, async (tx) => {
      const r = await tx.execute(sql`SELECT email, status FROM subscriber WHERE store_id = ${A} ORDER BY email`);
      return r.rows as Array<{ email: string; status: string }>;
    });
    expect(subs.find((r) => r.email === 'confirmed@example.com')!.status).toBe('unsubscribed'); // consumed
    expect(subs.find((r) => r.email === 'pending@example.com')!.status).toBe('pending'); // consent gate
    expect(subs.find((r) => r.email === 'other@example.com')!.status).toBe('confirmed'); // other topic untouched

    // A second transition sends nothing to the consumed row.
    await setOnHand(A, VARIANT_A, 0);
    await setOnHand(A, VARIANT_A, 6);
    await sweepRestockEvents();
    expect((await restockMails(A))).toHaveLength(1);
  });

  it('consumes an imported product-level signup once across its variant topics (signup_group parity)', async () => {
    // DD parity: one product-level waitlist signup is imported as one
    // subscriber row per variant topic sharing signup_group. Restocking ANY
    // variant emails the shopper once and consumes the whole group — a later
    // restock of a sibling variant must NOT re-email.
    await seedVariant(A, VARIANT_A2, 'A2', 0);
    await withStore(A, async (tx) => {
      // The two expanded rows of ONE imported signup (waiter@example.com).
      await tx.execute(sql`INSERT INTO subscriber (store_id, email, kind, topic, status, confirmed_at, source, signup_group)
        VALUES (${A}, 'waiter@example.com', 'waitlist', ${`restock:${VARIANT_A}`}, 'confirmed', now(), 'import', 'grp-1')`);
      await tx.execute(sql`INSERT INTO subscriber (store_id, email, kind, topic, status, confirmed_at, source, signup_group)
        VALUES (${A}, 'waiter@example.com', 'waitlist', ${`restock:${VARIANT_A2}`}, 'confirmed', now(), 'import', 'grp-1')`);
      // A different signup on the sibling variant — a separate group.
      await tx.execute(sql`INSERT INTO subscriber (store_id, email, kind, topic, status, confirmed_at, source, signup_group)
        VALUES (${A}, 'solo@example.com', 'waitlist', ${`restock:${VARIANT_A2}`}, 'confirmed', now(), 'import', 'grp-2')`);
      // Native single-variant signup (no group) — its own consumption unit.
      await tx.execute(sql`INSERT INTO subscriber (store_id, email, kind, topic, status, confirmed_at)
        VALUES (${A}, 'native@example.com', 'waitlist', ${`restock:${VARIANT_A}`}, 'confirmed', now())`);
    });

    // Variant A restocks: one mail per claimed unit — waiter@ (grp-1) and
    // native@ (no group). grp-1's sibling row on VARIANT_A2 is consumed
    // silently in the same claim.
    await setOnHand(A, VARIANT_A, 5);
    let res = await sweepRestockEvents();
    expect(res.notified).toBe(2);
    let mails = await restockMails(A);
    expect(mails.map((m) => m.recipient).sort()).toEqual(['native@example.com', 'waiter@example.com']);

    const afterA = await withStore(A, async (tx) => {
      const r = await tx.execute(sql`SELECT email, topic, status, signup_group FROM subscriber WHERE store_id = ${A} ORDER BY email, topic`);
      return r.rows as Array<{ email: string; topic: string; status: string; signup_group: string | null }>;
    });
    expect(afterA.find((r) => r.topic === `restock:${VARIANT_A2}` && r.email === 'waiter@example.com')!.status).toBe('unsubscribed'); // sibling consumed
    expect(afterA.find((r) => r.email === 'solo@example.com')!.status).toBe('confirmed'); // other group untouched

    // Variant A2 restocks: waiter@ gets NOTHING — the signup was consumed by
    // the first restock. solo@ (grp-2) is claimed normally.
    await setOnHand(A, VARIANT_A2, 3);
    res = await sweepRestockEvents();
    expect(res.notified).toBe(1);
    mails = await restockMails(A);
    expect(mails.map((m) => m.recipient).sort()).toEqual(['native@example.com', 'solo@example.com', 'waiter@example.com']);
    expect(mails.filter((m) => m.recipient === 'waiter@example.com')).toHaveLength(1);
  });

  it('re-arms: a notified email can sign up again and is notified on the next restock', async () => {
    await subscribe({ variantId: VARIANT_A, email: 'loop@example.com' });
    await setOnHand(A, VARIANT_A, 5);
    await sweepRestockEvents();
    expect((await restockMails(A))).toHaveLength(1);

    // New cycle: goes OOS, shopper re-subscribes (old row is 'notified', not
    // 'pending', so the partial unique index allows the fresh pending row).
    await setOnHand(A, VARIANT_A, 0);
    const res = await subscribe({ variantId: VARIANT_A, email: 'loop@example.com' });
    expect(res.status).toBe(200);
    const rows = await requests(A, VARIANT_A);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1);

    await setOnHand(A, VARIANT_A, 3);
    await sweepRestockEvents();
    expect((await restockMails(A))).toHaveLength(2);
  });
});
