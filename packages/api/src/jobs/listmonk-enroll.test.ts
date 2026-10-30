/**
 * Paid-order Listmonk enrollment tests (DB-gated, fetch mocked).
 * Covers: enrollment inserts a confirmed 'order' subscriber row, dedupe on
 * repeat orders, and the sync pass actually pushing it to Listmonk.
 */
import { isDisposablePostgresUrl } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

// vi.hoisted: the factory is hoisted above the const — declare the mock there.
const fetchMock = vi.hoisted(() => vi.fn(async (_url: string, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}')) as { email: string; lists: number[] };
  return Response.json({ data: { id: 12, email: body.email, status: 'enabled', lists: body.lists.map(id => ({ id, subscription_status: 'confirmed' })) } });
}));
vi.mock('../security/outbound-url.js', () => ({ safeOutboundFetch: fetchMock }));

import { enrollOnPaidOrder, listmonkSync, resetListmonkRetryBackoff } from './listmonk-sync.js';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
const isTestDb = isDisposablePostgresUrl(DB);
const STORE = '88888888-8888-8888-8888-888888888888';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { email: string; lists: number[] };
    return Response.json({ data: { id: 12, email: body.email, status: 'enabled', lists: body.lists.map(id => ({ id, subscription_status: 'confirmed' })) } });
  });
}

async function seedStore(withListmonk = true): Promise<void> {
  await pool.query(
    `INSERT INTO store (id, slug, name, currency, config) VALUES ($1, 'lm-test', 'LM Test', 'USD', $2::jsonb)`,
    [STORE, JSON.stringify(withListmonk ? { listmonk: { url: 'https://listmonk.example.com', apiUser: 'u', apiToken: 't', listId: 7 } } : {})],
  );
}

const subscriberRows = () => withStore(STORE, async (tx) => {
  const r = await tx.execute(sql`SELECT email, kind, status, listmonk_synced_at AS synced FROM subscriber ORDER BY email, kind`);
  return r.rows as Array<{ email: string; kind: string; status: string; synced: string | null }>;
});

describe.skipIf(!isTestDb)('enrollOnPaidOrder + listmonkSync', () => {
  beforeEach(async () => { resetListmonkRetryBackoff(); await wipe(); });
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
    expect(JSON.parse(init.body)).toMatchObject({ email: 'buyer@x.test', status: 'enabled', lists: [7], preconfirm_subscriptions: true });
    expect((await subscriberRows())[0]!.synced).not.toBeNull();

    fetchMock.mockClear();
    const res2 = await listmonkSync({ log: () => {} });
    expect(res2.synced).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled(); // dedupe: synced row is never re-pushed
  });

  it('enrolls an existing subscriber into the configured list before marking synced', async () => {
    await seedStore();
    fetchMock.mockResolvedValueOnce(new Response('exists', { status: 409 }))
      .mockResolvedValueOnce(Response.json({ data: { results: [{ id: 12, email: 'dupe@x.test', status: 'enabled', lists: [{ id: 8, subscription_status: 'confirmed' }] }] } }))
      .mockResolvedValueOnce(Response.json({ data: true }))
      .mockResolvedValueOnce(Response.json({ data: { id: 12, email: 'dupe@x.test', status: 'enabled', lists: [{ id: 8, subscription_status: 'confirmed' }, { id: 7, subscription_status: 'confirmed' }] } }));
    await withStore(STORE, (tx) => enrollOnPaidOrder(tx, STORE, { orderId: 'o1', email: 'dupe@x.test' }));
    const res = await listmonkSync({ log: () => {} });
    expect(res.synced).toBe(1);
    expect(res.failed).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [lookupUrl] = fetchMock.mock.calls[1]! as unknown as [string];
    expect(new URL(lookupUrl).searchParams.get('query')).toBe("subscribers.email = E'dupe@x.test'");
    const [url, init] = fetchMock.mock.calls[2]! as unknown as [string, { method: string; body: string }];
    expect(url).toBe('https://listmonk.example.com/api/subscribers/query/lists');
    expect(init.method).toBe('PUT');
    // Add-only query uses the validated numeric identity & never replaces other lists.
    expect(JSON.parse(init.body)).toEqual({ query: "subscribers.id = 12 AND subscribers.status = 'enabled'", action: 'add', target_list_ids: [7], status: 'confirmed' });
    expect((await subscriberRows())[0]!.synced).not.toBeNull();
  });

  it.each(['order', 'newsletter'] as const)('keeps confirmed upstream membership idempotent for %s', async (kind) => {
    await seedStore();
    await pool.query(`INSERT INTO subscriber (store_id, email, kind, topic, status) VALUES ($1, 'known@x.test', $2, '', 'confirmed')`, [STORE, kind]);
    fetchMock.mockResolvedValueOnce(new Response('exists', { status: 409 }))
      .mockResolvedValueOnce(Response.json({ data: { results: [{ id: 12, email: 'known@x.test', status: 'enabled', lists: [{ id: 7, subscription_status: 'confirmed' }] }] } }));
    expect(await listmonkSync()).toMatchObject({ synced: 1, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['order', 'newsletter'] as const)('handles an explicit Listmonk opt-out for %s', async (kind) => {
    await seedStore();
    await pool.query(`INSERT INTO subscriber (store_id, email, kind, topic, status) VALUES ($1, 'optout@x.test', $2, '', 'confirmed')`, [STORE, kind]);
    fetchMock.mockResolvedValueOnce(new Response('exists', { status: 409 }))
      .mockResolvedValueOnce(Response.json({ data: { results: [{ id: 12, email: 'optout@x.test', status: 'enabled', lists: [{ id: 7, subscription_status: 'unsubscribed' }] }] } }));
    const log = vi.fn();
    expect(await listmonkSync({ log })).toMatchObject({ synced: 0, suppressed: 1, failed: 0 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('preserving provider unsubscribed'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await subscriberRows())[0]!.synced).not.toBeNull();
    fetchMock.mockClear();
    expect(await listmonkSync()).toMatchObject({ synced: 0, suppressed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('syncs only confirmed newsletter rows & uses the configured destination', async () => {
    await seedStore();
    await pool.query(`INSERT INTO subscriber (store_id, email, kind, topic, status) VALUES
      ($1, 'confirmed@x.test', 'newsletter', '', 'confirmed'),
      ($1, 'pending@x.test', 'newsletter', '', 'pending'),
      ($1, 'unsubscribed@x.test', 'newsletter', '', 'unsubscribed')`, [STORE]);
    expect(await listmonkSync()).toMatchObject({ synced: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({ email: 'confirmed@x.test', lists: [7], preconfirm_subscriptions: true });
    expect((await subscriberRows()).filter(row => row.synced !== null)).toHaveLength(1);
  });

  it('never syncs waitlist (restock) rows, imported or live, even when confirmed', async () => {
    await seedStore();
    await pool.query(`INSERT INTO subscriber (store_id, email, kind, topic, status, source, signup_group) VALUES
      ($1, 'imported@x.test', 'waitlist', 'restock:v1', 'confirmed', 'import', gen_random_uuid()::text),
      ($1, 'imported@x.test', 'waitlist', 'restock:v2', 'confirmed', 'import', gen_random_uuid()::text),
      ($1, 'live@x.test', 'waitlist', 'restock:v1', 'confirmed', 'storefront', gen_random_uuid()::text),
      ($1, 'news@x.test', 'newsletter', '', 'confirmed', 'storefront', NULL::text)`, [STORE]);
    expect(await listmonkSync({ log: () => {} })).toMatchObject({ synced: 1, failed: 0 });
    // Only the newsletter address reached Listmonk.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({ email: 'news@x.test' });
    const rows = await subscriberRows();
    expect(rows.filter((r) => r.kind === 'waitlist').every((r) => r.synced === null)).toBe(true);
    expect(rows.filter((r) => r.kind === 'newsletter').every((r) => r.synced !== null)).toBe(true);
    // A later pass still leaves them alone.
    fetchMock.mockClear();
    expect(await listmonkSync({ log: () => {} })).toMatchObject({ synced: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, -1, 1.5])('keeps rows queued with a diagnostic when listId is %s', async (listId) => {
    await seedStore();
    await pool.query('UPDATE store SET config = $2::jsonb WHERE id = $1', [STORE, JSON.stringify({ listmonk: { url: 'https://listmonk.example.com', apiUser: 'u', apiToken: 't', listId } })]);
    await withStore(STORE, tx => enrollOnPaidOrder(tx, STORE, { orderId: 'o', email: 'queued@x.test' }));
    const log = vi.fn();
    expect(await listmonkSync({ log })).toMatchObject({ synced: 0, skipped: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('configure a positive listId'));
    expect((await subscriberRows())[0]!.synced).toBeNull();
  });

  it.each(['lookup', 'membership', 'identity'])('retries failed duplicate %s without marking synced', async (failure) => {
    await seedStore();
    await withStore(STORE, tx => enrollOnPaidOrder(tx, STORE, { orderId: 'o', email: "o'brien@x.test" }));
    fetchMock.mockResolvedValueOnce(new Response('exists', { status: 409 }))
      .mockResolvedValueOnce(failure === 'lookup' ? new Response('error', { status: 503 }) : Response.json({ data: { results: [{ id: 12, email: failure === 'identity' ? 'wrong@x.test' : "o'brien@x.test", status: 'enabled', lists: [] }] } }));
    if (failure === 'membership') fetchMock.mockResolvedValueOnce(new Response('error', { status: 503 }));
    expect(await listmonkSync()).toMatchObject({ synced: 0, failed: 1 });
    const [lookupUrl] = fetchMock.mock.calls[1]! as unknown as [string];
    expect(new URL(lookupUrl).searchParams.get('query')).toBe("subscribers.email = E'o''brien@x.test'");
    expect((await subscriberRows())[0]!.synced).toBeNull();
    // D9: the failed row backs off instead of being re-pushed on the very next pass.
    fetchMock.mockClear();
    expect(await listmonkSync()).toMatchObject({ synced: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    resetListmonkRetryBackoff(); // backoff elapsed
    expect(await listmonkSync()).toMatchObject({ synced: 1, failed: 0 });
  });

  it('keeps a failed row queued while syncing the rest of the batch', async () => {
    await seedStore();
    await pool.query(`INSERT INTO subscriber (store_id, email, kind, topic, status) VALUES
      ($1, 'first@x.test', 'newsletter', '', 'confirmed'),
      ($1, 'second@x.test', 'newsletter', '', 'confirmed')`, [STORE]);
    fetchMock.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    expect(await listmonkSync()).toMatchObject({ synced: 1, failed: 1 });
    const rows = await subscriberRows();
    expect(rows.filter(row => row.synced !== null)).toHaveLength(1);
    expect(rows.filter(row => row.synced === null)).toHaveLength(1);
  });

  it('does not mark a newly created orphan as synced when its destination list disappeared', async () => {
    await seedStore();
    await withStore(STORE, tx => enrollOnPaidOrder(tx, STORE, { orderId: 'o', email: 'orphan@x.test' }));
    fetchMock.mockResolvedValueOnce(Response.json({ data: { id: 12, email: 'orphan@x.test', status: 'enabled', lists: [] } }));
    expect(await listmonkSync()).toMatchObject({ synced: 0, failed: 1 });
    expect((await subscriberRows())[0]!.synced).toBeNull();
  });

  it.each(['blocklisted', 'disabled', 'unconfirmed'])('preserves provider %s without an enrollment write', async (status) => {
    await seedStore();
    await withStore(STORE, tx => enrollOnPaidOrder(tx, STORE, { orderId: 'o', email: 'preserve@x.test' }));
    fetchMock.mockResolvedValueOnce(new Response('exists', { status: 409 }))
      .mockResolvedValueOnce(Response.json({ data: { results: [{
        id: 12, email: 'preserve@x.test', status: status === 'unconfirmed' ? 'enabled' : status,
        lists: status === 'unconfirmed' ? [{ id: 7, subscription_status: 'unconfirmed' }] : [],
      }] } }));
    const log = vi.fn();
    expect(await listmonkSync({ log })).toMatchObject({ synced: 0, suppressed: 1, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`preserving provider ${status}`));
    expect((await subscriberRows())[0]!.synced).not.toBeNull();
  });

  it.each(['confirmed', 'unsubscribed', 'missing', 'readback-failure'])('uses membership readback after add-only enrollment: %s', async (membership) => {
    await seedStore();
    await withStore(STORE, tx => enrollOnPaidOrder(tx, STORE, { orderId: 'o', email: 'race@x.test' }));
    fetchMock.mockResolvedValueOnce(new Response('exists', { status: 409 }))
      .mockResolvedValueOnce(Response.json({ data: { results: [{ id: 12, email: 'race@x.test', status: 'enabled', lists: [] }] } }))
      .mockResolvedValueOnce(Response.json({ data: true }))
      .mockResolvedValueOnce(membership === 'readback-failure' ? new Response('unavailable', { status: 503 }) : Response.json({ data: {
        id: 12, email: 'race@x.test', status: 'enabled', lists: membership === 'missing' ? [] : [{ id: 7, subscription_status: membership }],
      } }));
    const failed = membership === 'missing' || membership === 'readback-failure';
    expect(await listmonkSync()).toMatchObject({ synced: membership === 'confirmed' ? 1 : 0, suppressed: membership === 'unsubscribed' ? 1 : 0, failed: failed ? 1 : 0 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect((await subscriberRows())[0]!.synced === null).toBe(failed);
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
