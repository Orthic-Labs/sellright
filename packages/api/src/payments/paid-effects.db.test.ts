/**
 * SR-05 regression test: a paid-order confirmation enqueued for store B must
 * carry store B's storefront URL + sender — never the deployment env globals
 * (which point at brand A in this deployment) — and the enqueue is idempotent
 * via dedupeKey so a settlement replay can't double-send (PAR-03/SR-12).
 *
 * Runs against a *_test DB only (TRUNCATEs store CASCADE).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { enqueuePaidEffects } from './paid-effects.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`paid-effects test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE_A = 'eeeeeeee-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const STORE_B = 'eeeeeeee-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

async function seedStores(): Promise<void> {
  await pool.query(
    `INSERT INTO store (id, slug, name, currency, config) VALUES
       ($1, 'pe-brand-a', 'Brand A', 'USD', $3::jsonb),
       ($2, 'pe-brand-b', 'Brand B', 'EUR', $4::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      STORE_A, STORE_B,
      JSON.stringify({ storefrontUrl: 'https://a-brand.example', emailFrom: 'orders@a-brand.example' }),
      JSON.stringify({ storefrontUrl: 'https://b-brand.example', emailFrom: 'orders@b-brand.example' }),
    ],
  );
}

/** Minimal paid order + one line + customer, inside the store's RLS scope. */
async function seedOrder(storeId: string, code: string, email: string): Promise<string> {
  return withStore(storeId, async (tx) => {
    const cust = await tx.execute(sql`INSERT INTO customer (store_id, email) VALUES (${storeId}, ${email}) RETURNING id`);
    const customerId = (cust.rows[0] as { id: string }).id;
    const o = await tx.execute(sql`INSERT INTO "order" (store_id, code, customer_id, state, currency, grand_total)
      VALUES (${storeId}, ${code}, ${customerId}, 'Paid', 'EUR', 4200) RETURNING id`);
    const orderId = (o.rows[0] as { id: string }).id;
    await tx.execute(sql`INSERT INTO order_line (store_id, order_id, variant_sku, variant_name, quantity, unit_price, line_subtotal, line_total)
      VALUES (${storeId}, ${orderId}, 'SKU-B', 'Widget B', 1, 4200, 4200, 4200)`);
    return orderId;
  });
}

// `type` so it stays `as`-castable from tx.execute's Record<string, unknown>[].
type OutboxRow = { kind: string; recipient: string; payload: { to?: string; from?: string; html?: string; text?: string }; dedupeKey: string | null };

// Explicit store_id filter — the test pool's superuser bypasses RLS, so
// withStore alone would return every tenant's rows.
async function outbox(storeId: string): Promise<OutboxRow[]> {
  return withStore(storeId, async (tx) => {
    const r = await tx.execute(sql`SELECT kind, recipient, payload, dedupe_key AS "dedupeKey" FROM email_outbox WHERE store_id = ${storeId} ORDER BY created_at`);
    return r.rows as OutboxRow[];
  });
}

describe('enqueuePaidEffects — per-store confirmation routing (SR-05)', () => {
  beforeEach(async () => { await wipe(); await seedStores(); });
  afterAll(async () => { await wipe(); await pool.end(); });

  it('store B’s confirmation carries B’s URL + sender — never the env globals', async () => {
    const orderId = await seedOrder(STORE_B, 'B-9001', 'buyer@b.test');
    await withStore(STORE_B, (tx) => enqueuePaidEffects(tx, STORE_B, orderId));
    const rows = await outbox(STORE_B);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe('order_confirmation');
    expect(row.recipient).toBe('buyer@b.test');
    expect(row.payload.from).toBe('orders@b-brand.example');
    expect(row.payload.html).toContain('https://b-brand.example/orders/B-9001');
    expect(row.payload.text).toContain('https://b-brand.example/orders/B-9001');
    expect(row.payload.html).not.toContain(env.STOREFRONT_URL);
    expect(row.payload.from).not.toBe(env.SMTP_FROM);
  });

  it('store A confirmation uses A’s identity; B and A stay isolated', async () => {
    const aId = await seedOrder(STORE_A, 'A-1001', 'buyer@a.test');
    const bId = await seedOrder(STORE_B, 'B-1001', 'buyer@b.test');
    await withStore(STORE_A, (tx) => enqueuePaidEffects(tx, STORE_A, aId));
    await withStore(STORE_B, (tx) => enqueuePaidEffects(tx, STORE_B, bId));
    const [a] = await outbox(STORE_A);
    const [b] = await outbox(STORE_B);
    expect(a!.payload.from).toBe('orders@a-brand.example');
    expect(a!.payload.html).toContain('https://a-brand.example/orders/A-1001');
    expect(b!.payload.from).toBe('orders@b-brand.example');
    expect(b!.payload.html).toContain('https://b-brand.example/orders/B-1001');
    expect(b!.payload.html).not.toContain('a-brand.example');
  });

  it('a repeated settlement for the same order cannot double-send', async () => {
    const orderId = await seedOrder(STORE_B, 'B-9002', 'buyer@b.test');
    await withStore(STORE_B, (tx) => enqueuePaidEffects(tx, STORE_B, orderId));
    await withStore(STORE_B, (tx) => enqueuePaidEffects(tx, STORE_B, orderId));
    const rows = await outbox(STORE_B);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dedupeKey).toContain('order_confirmation:');
  });
});
