/**
 * DB tests for PERF-14: deliverWebhooks must not hold a pooled DB connection
 * across the outbound HTTP call. Previously the claim (FOR UPDATE SKIP
 * LOCKED) and the safeOutboundFetch(...) call ran inside the SAME withStore
 * txn, so a slow/timing-out endpoint pinned a pooled connection for up to
 * 10s per row in the batch. The fix splits it into claim→release (txn #1,
 * committed) → fetch (no txn open) → finalize (txn #2, short) — same class
 * of fix as MONEY-2/OPS-2.
 *
 * Mock strategy mirrors ../email/outbox.test.ts: vi.mock is HOISTED, so
 * safeOutboundFetch is replaced before emit.ts resolves it. Per-test behavior
 * is controlled via mockResolvedValueOnce / mockImplementation.
 *
 * Runs against sellright_test ONLY (DB guard mirrors the other *db test*
 * files; the guard hard-fails if pointed at a non-test DB).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';

// vi.mock is hoisted — applies before ANY import below resolves.
vi.mock('../security/outbound-url.js', () => ({
  safeOutboundFetch: vi.fn(),
}));

// Hard guard: this test TRUNCATEs — refuse anything but a *_test DB.
const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(
    `webhooks/emit db test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`,
  );
}

import { safeOutboundFetch } from '../security/outbound-url.js';
import { deliverWebhooks } from './emit.js';

const STORE = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

async function seedStore(): Promise<void> {
  await pool.query(
    `INSERT INTO store (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [STORE, 'webhook-emit-test', 'Webhook Emit Test Store'],
  );
}

/** Seed one enabled endpoint subscribed to '*' and return its id. */
async function seedEndpoint(url = 'https://example.com/hook'): Promise<string> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(
      sql`INSERT INTO webhook_endpoint (store_id, url, topics, secret) VALUES (${STORE}, ${url}, ARRAY['*'], 'test-secret') RETURNING id`,
    );
    return (r.rows[0] as { id: string }).id;
  });
}

/** Insert one due (next_attempt_at in the past) pending delivery row. */
async function enqueueDueDelivery(endpointId: string, topic = 'order.created'): Promise<string> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(
      sql`INSERT INTO webhook_delivery (store_id, endpoint_id, topic, payload, next_attempt_at)
          VALUES (${STORE}, ${endpointId}, ${topic}, ${'{"ok":true}'}::jsonb, now() - interval '1 minute')
          RETURNING id`,
    );
    return (r.rows[0] as { id: string }).id;
  });
}

async function rowStatus(id: string): Promise<{ status: string; attempts: number; deliveredAt: Date | null; lastError: string | null; nextAttemptAt: Date }> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(
      sql`SELECT status, attempts, delivered_at AS "deliveredAt", last_error AS "lastError", next_attempt_at AS "nextAttemptAt" FROM webhook_delivery WHERE id = ${id}`,
    );
    return r.rows[0] as { status: string; attempts: number; deliveredAt: Date | null; lastError: string | null; nextAttemptAt: Date };
  });
}

describe('webhook delivery (PERF-14)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await wipe();
    await seedStore();
  });
  afterAll(async () => {
    await wipe();
    await pool.end();
  });

  it('does not hold a pooled connection while the outbound fetch is in flight', async () => {
    const endpointId = await seedEndpoint();
    await enqueueDueDelivery(endpointId);

    // Structural assertion: while the outbound call is "in flight" (this mock
    // body executing), the withStore txn that claimed the row has ALREADY
    // committed and released its client — so total checked-out connections is
    // 0 (pool.totalCount - pool.idleCount === 0). Before the PERF-14 fix, the
    // claim txn's connection would still be checked out here because
    // safeOutboundFetch ran inside it.
    let sawFullyIdleDuringFetch = false;
    vi.mocked(safeOutboundFetch).mockImplementation(async () => {
      const checkedOut = pool.totalCount - pool.idleCount;
      sawFullyIdleDuringFetch = checkedOut === 0;
      return new Response(null, { status: 200 });
    });

    const res = await deliverWebhooks({ log: () => {} });

    expect(res.delivered).toBe(1);
    expect(sawFullyIdleDuringFetch).toBe(true);
  });

  it('claims, signs, and marks delivered on a 2xx response', async () => {
    const endpointId = await seedEndpoint();
    const id = await enqueueDueDelivery(endpointId, 'order.paid');
    vi.mocked(safeOutboundFetch).mockResolvedValue(new Response(null, { status: 200 }));

    const res = await deliverWebhooks({ log: () => {} });

    expect(res.delivered).toBe(1);
    expect(res.failed).toBe(0);
    expect(safeOutboundFetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(safeOutboundFetch).mock.calls[0]!;
    expect(url).toBe('https://example.com/hook');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-sr-topic']).toBe('order.paid');
    expect(headers['x-sr-signature']).toMatch(/^[0-9a-f]{64}$/);

    const after = await rowStatus(id);
    expect(after.status).toBe('delivered');
    expect(after.deliveredAt).not.toBeNull();
  });

  it('backs off a failing row (non-2xx) without dead-lettering under MAX_ATTEMPTS', async () => {
    const endpointId = await seedEndpoint();
    const id = await enqueueDueDelivery(endpointId);
    vi.mocked(safeOutboundFetch).mockResolvedValue(new Response(null, { status: 500 }));

    const res = await deliverWebhooks({ log: () => {} });

    expect(res.delivered).toBe(0);
    expect(res.failed).toBe(0); // not yet dead — under MAX_ATTEMPTS
    const after = await rowStatus(id);
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(1);
    expect(after.lastError).toContain('HTTP 500');
    // Backoff for attempts=1 → 30s (BACKOFF_S[0]).
    const dueSec = (new Date(after.nextAttemptAt).getTime() - Date.now()) / 1000;
    expect(dueSec).toBeGreaterThanOrEqual(20);
    expect(dueSec).toBeLessThanOrEqual(60);
  });

  it('also backs off when safeOutboundFetch rejects (network/timeout) — proves the split does not swallow throws', async () => {
    const endpointId = await seedEndpoint();
    const id = await enqueueDueDelivery(endpointId);
    vi.mocked(safeOutboundFetch).mockRejectedValue(new Error('fetch failed: ETIMEDOUT'));

    const res = await deliverWebhooks({ log: () => {} });

    expect(res.delivered).toBe(0);
    expect(res.failed).toBe(0);
    const after = await rowStatus(id);
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(1);
    expect(after.lastError).toContain('ETIMEDOUT');
  });

  it('dead-letters after MAX_ATTEMPTS (6) failures', async () => {
    const endpointId = await seedEndpoint();
    const id = await enqueueDueDelivery(endpointId);
    vi.mocked(safeOutboundFetch).mockResolvedValue(new Response(null, { status: 503 }));

    for (let i = 0; i < 6; i++) {
      await withStore(STORE, async (tx) => {
        await tx.execute(sql`UPDATE webhook_delivery SET next_attempt_at = now() - interval '1 minute' WHERE id = ${id}`);
      });
      await deliverWebhooks({ log: () => {} });
    }

    expect(safeOutboundFetch).toHaveBeenCalledTimes(6);
    const after = await rowStatus(id);
    expect(after.status).toBe('failed');
    expect(after.attempts).toBe(6);
  });
});
