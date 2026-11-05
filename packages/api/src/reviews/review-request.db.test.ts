/**
 * DB tests for the review-request email (#315): sent when an order is delivered, one per order, linking each distinct
 * product to its write-review entry (`?review=1`).
 *
 * Runs against a *_test DB only (TRUNCATEs store CASCADE).
 */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { autoDeliverStore } from '../jobs/auto-deliver.js';
import { enqueueReviewRequests } from './review-request.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
assertTestDatabase(DB, 'review-request.db.test.ts');

const STORE = 'aaaaaaaa-5555-5555-5555-555555555555';
const SLUG = 'review-request-test-store';
const CUSTOMER = 'aaaaaaaa-5555-5555-5555-0000000000c1';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

beforeEach(async () => {
  await wipe();
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name, currency, config) VALUES (${STORE}, ${SLUG}, 'RR Store', 'USD', ${JSON.stringify({ storefrontUrl: 'https://rr.example', emailFrom: 'hello@rr.example' })}::jsonb)`);
    await tx.execute(sql`INSERT INTO customer (id, store_id, email, email_verified) VALUES (${CUSTOMER}, ${STORE}, 'buyer@rr.test', true)`);
  });
});
afterAll(async () => { await wipe(); });

/** An order with a line per entry in `products` (a slug seeds a product + variant; null seeds a line whose variant is gone). */
async function seedOrder(code: string, products: Array<string | null>, opts: { customerId?: string | null; contactEmail?: string; shipped?: boolean } = {}): Promise<string> {
  return withStore(STORE, async (tx) => {
    const customerId = opts.customerId === undefined ? CUSTOMER : opts.customerId;
    const metadata = opts.contactEmail ? JSON.stringify({ contact: { email: opts.contactEmail } }) : null;
    const o = await tx.execute(sql`INSERT INTO "order" (id, store_id, code, customer_id, state, currency, grand_total, metadata)
      VALUES (gen_random_uuid(), ${STORE}, ${code}, ${customerId}, 'Paid', 'USD', 1000, ${metadata}::jsonb) RETURNING id`);
    const orderId = (o.rows[0] as { id: string }).id;
    let n = 0;
    for (const slug of products) {
      n++;
      let variantId: string | null = null;
      if (slug) {
        const existing = (await tx.execute(sql`SELECT v.id FROM product_variant v JOIN product p ON p.id = v.product_id WHERE p.slug = ${slug} AND p.store_id = ${STORE} LIMIT 1`)).rows as Array<{ id: string }>;
        if (existing[0]) variantId = existing[0].id;
        else {
          const p = (await tx.execute(sql`INSERT INTO product (store_id, slug, name) VALUES (${STORE}, ${slug}, ${'Product ' + slug}) RETURNING id`)).rows as Array<{ id: string }>;
          const v = (await tx.execute(sql`INSERT INTO product_variant (store_id, product_id, sku, name, price) VALUES (${STORE}, ${p[0]!.id}, ${'SKU-' + slug}, ${'Variant ' + slug}, 1000) RETURNING id`)).rows as Array<{ id: string }>;
          variantId = v[0]!.id;
        }
      }
      await tx.execute(sql`INSERT INTO order_line (store_id, order_id, variant_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total, fulfilled_qty)
        VALUES (${STORE}, ${orderId}, ${variantId}, ${'L' + n}, ${'Line ' + n}, 1, 1000, 1000, 1000, 1)`);
    }
    if (opts.shipped) {
      const t = new Date(Date.now() - 30 * 86_400_000);
      await tx.execute(sql`INSERT INTO fulfillment (id, store_id, order_id, state, tracking_code, created_at, updated_at)
        VALUES (gen_random_uuid(), ${STORE}, ${orderId}, 'Shipped', ${'TRK-' + code}, ${t}, ${t})`);
    }
    return orderId;
  });
}

type Mail = { kind: string; recipient: string; payload: { subject: string; html: string } };
const mails = () => withStore(STORE, async (tx) =>
  (await tx.execute(sql`SELECT kind, recipient, payload FROM email_outbox WHERE store_id = ${STORE} ORDER BY created_at`)).rows as Mail[]);
const queue = (ids: string[]) => withStore(STORE, (tx) => enqueueReviewRequests(tx, STORE, ids));

describe('enqueueReviewRequests (#315)', () => {
  it('mails the customer one email linking each distinct product to its write-review entry', async () => {
    const id = await seedOrder('RR-1', ['rev-a', 'rev-b', 'rev-a']);
    expect(await queue([id])).toBe(1);
    const sent = await mails();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'review_request', recipient: 'buyer@rr.test' });
    expect(sent[0]!.payload.subject).toContain('RR-1');
    const html = sent[0]!.payload.html;
    expect(html).toMatch(/href="https:\/\/rr\.example\/\S*rev-a\/\?review=1"/);
    expect(html).toMatch(/href="https:\/\/rr\.example\/\S*rev-b\/\?review=1"/);
    expect(html.match(/rev-a\/\?review=1/g)).toHaveLength(1);
  });

  it('is once per order: a second pass queues nothing more', async () => {
    const id = await seedOrder('RR-2', ['rev-a']);
    expect(await queue([id])).toBe(1);
    expect(await queue([id])).toBe(0);
    expect(await mails()).toHaveLength(1);
  });

  it('mails a guest order at its checkout contact address', async () => {
    const id = await seedOrder('RR-3', ['rev-a'], { customerId: null, contactEmail: 'Guest@RR.test' });
    expect(await queue([id])).toBe(1);
    expect((await mails())[0]!.recipient).toBe('guest@rr.test');
  });

  it('skips an order with no recipient, and one with no reviewable product', async () => {
    const noRecipient = await seedOrder('RR-4', ['rev-a'], { customerId: null });
    const noProduct = await seedOrder('RR-5', [null]);
    expect(await queue([noRecipient, noProduct])).toBe(0);
    expect(await mails()).toEqual([]);
  });

  it('sends nothing when the store has switched reviews off', async () => {
    const id = await seedOrder('RR-6', ['rev-a']);
    await withStore(STORE, (tx) => tx.execute(sql`UPDATE store SET config = config || '{"reviews":{"enabled":false}}'::jsonb WHERE id = ${STORE}`));
    expect(await queue([id])).toBe(0);
    expect(await mails()).toEqual([]);
  });
});

describe('auto-deliver sends the review request (#315)', () => {
  it('a delivered order gets exactly one review-request email, and a later pass sends no second', async () => {
    await seedOrder('RR-7', ['rev-a'], { shipped: true });
    const first = await autoDeliverStore(STORE, { apply: true, days: 10 });
    expect(first.count).toBe(1);
    expect((await mails()).map((m) => m.kind)).toEqual(['review_request']);
    const second = await autoDeliverStore(STORE, { apply: true, days: 10 });
    expect(second.count).toBe(0);
    expect(await mails()).toHaveLength(1);
  });

  it('a dry run mails nothing', async () => {
    await seedOrder('RR-8', ['rev-a'], { shipped: true });
    await autoDeliverStore(STORE, { apply: false, days: 10 });
    expect(await mails()).toEqual([]);
  });
});
