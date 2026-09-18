/**
 * DB tests for the SR-05/SR-12 email dispatch path: every transactional send
 * lands in email_outbox with the ENQUEUING store's own sender + storefront URL.
 * Two stores carry distinct config.storefrontUrl / config.emailFrom; the
 * deployment env points at brand A, so a brand-B email containing an env-global
 * link is exactly the SR-05 regression this guards.
 *
 * Runs against a *_test DB only (TRUNCATEs store CASCADE).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import {
  enqueueOrderConfirmation,
  enqueueShippingNotification,
  enqueuePasswordReset,
  enqueueEmailVerify,
  enqueueEmailAddressChange,
  enqueueRefundConfirmation,
  EMAIL_KIND,
} from './dispatch.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(`dispatch.db test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`);
}

const STORE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const STORE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// `type` (not `interface`) so the alias gets an implicit index signature and
// stays `as`-castable from tx.execute's Record<string, unknown>[].
type OutboxRow = { id: string; kind: string; recipient: string; payload: { to?: string; from?: string; subject?: string; html?: string; text?: string }; status: string; dedupeKey?: string | null };

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

async function seedStores(): Promise<void> {
  await pool.query(
    `INSERT INTO store (id, slug, name, currency, config) VALUES
       ($1, 'brand-a', 'Brand A', 'USD', $3::jsonb),
       ($2, 'brand-b', 'Brand B', 'EUR', $4::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      STORE_A, STORE_B,
      JSON.stringify({ storefrontUrl: 'https://a-brand.example', emailFrom: 'orders@a-brand.example' }),
      JSON.stringify({ storefrontUrl: 'https://b-brand.example', emailFrom: 'orders@b-brand.example' }),
    ],
  );
}

// NB: the test pool connects as the superuser (BYPASSRLS), so scoping here is
// an explicit WHERE — not the RLS policy. Keep the store_id filter: without it
// cross-tenant rows would silently satisfy (or pollute) these assertions.
async function outboxRows(storeId: string): Promise<OutboxRow[]> {
  return withStore(storeId, async (tx) => {
    const r = await tx.execute(sql`SELECT id, kind, recipient, payload, status, dedupe_key AS "dedupeKey" FROM email_outbox WHERE store_id = ${storeId} ORDER BY created_at`);
    return r.rows as OutboxRow[];
  });
}

const ctxB = { name: 'Brand B', currency: 'EUR', config: { storefrontUrl: 'https://b-brand.example', emailFrom: 'orders@b-brand.example' } };

describe('email dispatch — per-store sender + storefront (SR-05)', () => {
  beforeEach(async () => { await wipe(); await seedStores(); });
  afterAll(async () => { await wipe(); await pool.end(); });

  it('order confirmation carries the store’s own URL + sender, never the env globals', async () => {
    await withStore(STORE_B, async (tx) => {
      await enqueueOrderConfirmation(tx, STORE_B, ctxB, 'buyer@example.com', {
        code: 'B-100', grandTotal: 4200, currency: 'EUR',
        lines: [{ name: 'Widget', quantity: 1, lineTotal: 4200 }],
      });
    });
    const [row] = await outboxRows(STORE_B);
    expect(row!.kind).toBe(EMAIL_KIND.ORDER_CONFIRMATION);
    expect(row!.recipient).toBe('buyer@example.com');
    expect(row!.payload.from).toBe('orders@b-brand.example');
    expect(row!.payload.html).toContain('https://b-brand.example/orders/B-100');
    // The deployment env points at brand A — B's mail must not leak it (SR-05).
    expect(row!.payload.html).not.toContain(env.STOREFRONT_URL);
    expect(row!.payload.from).not.toBe(env.SMTP_FROM);
  });

  it('password reset / verify / shipping / change links all use the store URL', async () => {
    await withStore(STORE_B, async (tx) => {
      await enqueuePasswordReset(tx, STORE_B, ctxB, 'u@example.com', { url: 'https://b-brand.example/password-reset?token=t1', ttlHours: 2 });
      await enqueueEmailVerify(tx, STORE_B, ctxB, 'u@example.com', { url: 'https://b-brand.example/verify-email?token=t2' });
      await enqueueShippingNotification(tx, STORE_B, ctxB, 'u@example.com', { code: 'B-200', trackingCode: 'TRK1', carrier: 'UPS' });
      await enqueueEmailAddressChange(tx, STORE_B, ctxB, 'new@example.com', { url: 'https://b-brand.example/verify-email-address-change?token=t3', newEmail: 'new@example.com', ttlHours: 24 });
    });
    const rows = await outboxRows(STORE_B);
    expect(rows.map((r) => r.kind)).toEqual([
      EMAIL_KIND.PASSWORD_RESET, EMAIL_KIND.EMAIL_VERIFY, EMAIL_KIND.SHIPPING_NOTIFICATION, EMAIL_KIND.EMAIL_CHANGE,
    ]);
    for (const row of rows) {
      expect(row.payload.from).toBe('orders@b-brand.example');
      expect(row.payload.html).not.toContain(env.STOREFRONT_URL);
    }
    const change = rows.find((r) => r.kind === EMAIL_KIND.EMAIL_CHANGE)!;
    expect(change.recipient).toBe('new@example.com'); // goes to the NEW address
    expect(change.payload.html).toContain('new@example.com');
  });

  it('refund confirmation resolves under the PAR-03 contract key with correct partial/full copy', async () => {
    await withStore(STORE_B, async (tx) => {
      await enqueueRefundConfirmation(tx, STORE_B, ctxB, 'buyer@example.com', {
        code: 'B-300', amount: 1000, currency: 'EUR', refundedTotal: 1000, grandTotal: 4200,
        dedupeKey: 'order-refund-confirmation:ref-1',
      });
      await enqueueRefundConfirmation(tx, STORE_B, ctxB, 'buyer@example.com', {
        code: 'B-301', amount: 5000, currency: 'EUR', refundedTotal: 5000, grandTotal: 5000,
      });
    });
    const rows = await outboxRows(STORE_B);
    const partial = rows.find((r) => r.payload.html!.includes('B-300'))!;
    const full = rows.find((r) => r.payload.html!.includes('B-301'))!;
    expect(partial.kind).toBe('order-refund-confirmation');
    expect(partial.payload.html).toContain('10.00 EUR');
    expect(partial.payload.html).toContain('Total refunded so far: 10.00 EUR of 42.00 EUR');
    expect(partial.payload.html).toContain('https://b-brand.example/orders/B-300');
    expect(full.payload.html).toContain('fully refunds the order total of 50.00 EUR');
  });

  it('dedupeKey suppresses a duplicate enqueue (replayed settlement event)', async () => {
    const data = { code: 'B-300', amount: 1000, currency: 'EUR', refundedTotal: 4200, grandTotal: 4200, dedupeKey: 'order-refund-confirmation:ref-1' };
    const first = await withStore(STORE_B, (tx) => enqueueRefundConfirmation(tx, STORE_B, ctxB, 'buyer@example.com', data));
    const second = await withStore(STORE_B, (tx) => enqueueRefundConfirmation(tx, STORE_B, ctxB, 'buyer@example.com', data));
    expect(first).toBe(true);
    expect(second).toBe(false);
    const rows = await outboxRows(STORE_B);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dedupeKey).toBe('order-refund-confirmation:ref-1');
  });

  it('store A and store B never share branding', async () => {
    const ctxA = { name: 'Brand A', currency: 'USD', config: { storefrontUrl: 'https://a-brand.example', emailFrom: 'orders@a-brand.example' } };
    await withStore(STORE_A, (tx) => enqueuePasswordReset(tx, STORE_A, ctxA, 'a@example.com', { url: 'https://a-brand.example/password-reset?token=ta', ttlHours: 2 }));
    await withStore(STORE_B, (tx) => enqueuePasswordReset(tx, STORE_B, ctxB, 'b@example.com', { url: 'https://b-brand.example/password-reset?token=tb', ttlHours: 2 }));
    const [a] = await outboxRows(STORE_A);
    const [b] = await outboxRows(STORE_B);
    expect(a!.payload.from).toBe('orders@a-brand.example');
    expect(a!.payload.html).toContain('https://a-brand.example/password-reset');
    expect(b!.payload.from).toBe('orders@b-brand.example');
    expect(b!.payload.html).toContain('https://b-brand.example/password-reset');
  });
});
