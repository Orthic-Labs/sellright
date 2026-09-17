/**
 * Paid-order Listmonk enrollment tests (DB-gated, fetch mocked).
 * Covers: enrollment inserts a confirmed 'order' subscriber row, dedupe on
 * repeat orders, and the sync pass actually pushing it to Listmonk.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

// vi.hoisted: the factory is hoisted above the const — declare the mock there.
const fetchMock = vi.hoisted(() => vi.fn(async () => new Response('{}', { status: 200 })));
vi.mock('../security/outbound-url.js', () => ({ safeOutboundFetch: fetchMock }));

import { enrollOnPaidOrder, listmonkSync } from './listmonk-sync.js';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
const isTestDb = /_test(\b|$|\?)/.test(DB);
const STORE = '88888888-8888-8888-8888-888888888888';

async function wipe() { await pool.query('TRUNCATE store CASCADE'); fetchMock.mockClear(); }

async function seedStore(withListmonk = true): Promise<void> {
  await pool.query(
    `INSERT INTO store (id, slug, name, currency, config) VALUES ($1, 'lm-test', 'LM Test', 'USD', $2::jsonb)`,
    [STORE, JSON.stringify(withListmonk ? { listmonk: { url: 'https://listmonk.example.com', apiUser: 'u', apiToken: 't' } } : {})],
  );
}

const subscriberRows = () => withStore(STORE, async (tx) => {
  const r = await tx.execute(sql`SELECT email, kind, status, listmonk_synced_at AS synced FROM subscriber ORDER BY email, kind`);
  return r.rows as Array<{ email: string; kind: string; status: string; synced: string | null }>;
});

describe.skipIf(!isTestDb)('enrollOnPaidOrder + listmonkSync', () => {
  beforeEach(wipe);
  afterAll(wipe);

  it('enrolls a paid-order customer as a confirmed subscriber row, deduped on repeat', async () => {
    await seedStore();
    const first = await withStore(STORE, (tx) => enrollOnPaidOrder(tx, STORE, { orderId: 'o1', orderCode: 'ORD-1', email: 'Buyer@X.test' }));
    expect(first).toBe(true);
    // Replayed settlement / second order — dedupe via the unique index.
    const second = await withStore(STORE, (tx) => enrollOnPaidOrder(tx, STORE, { orderId: 'o2', orderCode: 'ORD-2', email: 'buyer@x.test' }));
    expect(second).toBe(false);

    const rows = await subscriberRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'buyer@x.test', kind: 'order', status: 'confirmed', synced: null });
  });

  it('a blank/invalid email never creates a row', async () => {
    await seedStore();
    expect(await withStore(STORE, (tx) => enrollOnPaidOrder(tx, STORE, { orderId: 'o', email: 'not-an-email' }))).toBe(false);
    expect(await subscriberRows()).toHaveLength(0);
  });

  it('the sync pass pushes the enrolled row to Listmonk and marks it; second pass is a no-op', async () => {
    await seedStore();
    await withStore(STORE, (tx) => enrollOnPaidOrder(tx, STORE, { orderId: 'o1', email: 'buyer@x.test' }));

    const res1 = await listmonkSync({ log: () => {} });
    expect(res1.synced).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, { body: string; headers: Record<string, string> }];
    expect(url).toBe('https://listmonk.example.com/api/subscribers');
    expect(JSON.parse(init.body)).toMatchObject({ email: 'buyer@x.test', status: 'enabled', preconfirm_subscriptions: true });
    expect((await subscriberRows())[0]!.synced).not.toBeNull();

    fetchMock.mockClear();
    const res2 = await listmonkSync({ log: () => {} });
    expect(res2.synced).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled(); // dedupe: synced row is never re-pushed
  });

  it('a Listmonk 409 (already exists upstream) still marks the row synced', async () => {
    await seedStore();
    fetchMock.mockResolvedValueOnce(new Response('exists', { status: 409 }));
    await withStore(STORE, (tx) => enrollOnPaidOrder(tx, STORE, { orderId: 'o1', email: 'dupe@x.test' }));
    const res = await listmonkSync({ log: () => {} });
    expect(res.synced).toBe(1);
    expect(res.failed).toBe(0);
    expect((await subscriberRows())[0]!.synced).not.toBeNull();
  });

  it('unconfigured store skips the push but the row stays queued for later', async () => {
    await seedStore(false);
    await withStore(STORE, (tx) => enrollOnPaidOrder(tx, STORE, { orderId: 'o1', email: 'wait@x.test' }));
    const res = await listmonkSync({ log: () => {} });
    expect(res.skipped).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await subscriberRows())[0]!.synced).toBeNull();
  });
});
