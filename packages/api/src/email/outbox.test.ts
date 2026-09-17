/**
 * DB tests for REL-4 (DISPATCH.md lane REL-4). The email outbox is the
 * order-confirmation retry/dead-letter mechanism; this test exercises the
 * full path:
 *
 *   1. enqueue (insert a row inside withStore, mirroring what checkout.ts
 *      does at the Paid transition)
 *   2. deliverEmails() (scheduler pass) claims the row, calls the (mocked)
 *      mailer, marks it 'sent'
 *   3. A row whose mailer always fails transitions 'pending' (with bumped
 *      next_attempt_at) → 'dead' after MAX_ATTEMPTS — surfacing it for ops
 *      via `SELECT * FROM email_outbox WHERE status='dead'`.
 *
 * Runs against sellright_test ONLY (DB guard mirrors the other *db test*
 * files; the guard hard-fails if pointed at a non-test DB).
 *
 * Mock strategy: vi.mock is HOISTED to the top by vitest's transformer, so
 * the mailer module gets replaced before outbox.ts resolves `sendEmail`. Per-
 * test behavior is controlled via mockResolvedValueOnce / mockResolvedValue
 * inside each test (vi.clearAllMocks in beforeEach).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';

// vi.mock is hoisted — applies before ANY import below resolves.
vi.mock('./mailer.js', () => ({
  sendEmail: vi.fn(),
}));

// Hard guard: this test TRUNCATEs — refuse anything but a *_test DB.
const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error(
    `outbox test truncates data — point DATABASE_URL at a *_test database, got: ${DB.replace(/:[^:@/]+@/, ':***@')}`,
  );
}

import { sendEmail } from './mailer.js';
import { deliverEmails, enqueueEmail } from './outbox.js';

const STORE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

async function wipe() {
  await pool.query('TRUNCATE store CASCADE');
}

async function seedStore(): Promise<void> {
  await pool.query(
    `INSERT INTO store (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [STORE, 'outbox-test', 'Outbox Test Store'],
  );
}

/** Insert one email_outbox row directly so we don't need a real order + customer. */
async function enqueueRow(recipient: string, subject: string): Promise<string> {
  return withStore(STORE, async (tx) => {
    const payload = JSON.stringify({ to: recipient, subject, html: `<p>${subject}</p>`, text: subject });
    const r = await tx.execute(
      sql`INSERT INTO email_outbox (store_id, kind, recipient, payload) VALUES (${STORE}, 'order_confirmation', ${recipient}, ${payload}::jsonb) RETURNING id`,
    );
    return (r.rows[0] as { id: string }).id;
  });
}

async function rowStatus(id: string): Promise<{ status: string; attempts: number; sentAt: Date | null; lastError: string | null; nextAttemptAt: Date }> {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`SELECT status, attempts, sent_at AS "sentAt", last_error AS "lastError", next_attempt_at AS "nextAttemptAt" FROM email_outbox WHERE id = ${id}`);
    return r.rows[0] as { status: string; attempts: number; sentAt: Date | null; lastError: string | null; nextAttemptAt: Date };
  });
}

/** Force a row's next_attempt_at into the past so the scheduler claim picks it up. */
async function makeDue(id: string): Promise<void> {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`UPDATE email_outbox SET next_attempt_at = now() - interval '1 minute' WHERE id = ${id}`);
  });
}

describe('email outbox (REL-4)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await wipe();
    await seedStore();
  });
  afterAll(async () => {
    await wipe();
    await pool.end();
  });

  it('enqueues + claims + marks sent on successful delivery', async () => {
    vi.mocked(sendEmail).mockResolvedValue({ delivered: true });

    const id = await enqueueRow('buyer@example.com', 'Order confirmed — SR-OK');
    await makeDue(id);

    const res = await deliverEmails({ log: () => {} });

    expect(res.sent).toBe(1);
    expect(res.failed).toBe(0);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'buyer@example.com', subject: 'Order confirmed — SR-OK' }));

    const after = await rowStatus(id);
    expect(after.status).toBe('sent');
    expect(after.sentAt).not.toBeNull();
    expect(after.lastError).toBeNull();
  });

  it('keeps a failing row pending with a future next_attempt_at under MAX_ATTEMPTS', async () => {
    vi.mocked(sendEmail).mockResolvedValue({ delivered: false, reason: 'smtp 421 transient' });

    const id = await enqueueRow('buyer@example.com', 'Order confirmed — SR-RETRY');
    await makeDue(id);

    const res = await deliverEmails({ log: () => {} });
    const after = await rowStatus(id);

    expect(res.sent).toBe(0);
    expect(res.failed).toBe(0); // not yet dead — under MAX_ATTEMPTS
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(1);
    expect(after.lastError).toContain('smtp 421');
    // Backoff for attempts=1 → 60s (BACKOFF_S[0]). next_attempt_at must be at
    // least ~55s in the future so the row is NOT immediately re-claimed.
    // raw SQL execute() returns the timestamp as a string, not a Date — coerce.
    const dueSec = (new Date(after.nextAttemptAt).getTime() - Date.now()) / 1000;
    expect(dueSec).toBeGreaterThanOrEqual(50);
    expect(dueSec).toBeLessThanOrEqual(120);
  });

  it('transitions a row to dead after MAX_ATTEMPTS failures', async () => {
    vi.mocked(sendEmail).mockResolvedValue({ delivered: false, reason: 'smtp 550 permanent' });

    const id = await enqueueRow('buyer@example.com', 'Order confirmed — SR-DEAD');
    // Force each attempt's next_attempt_at into the past so the scheduler can
    // re-claim it — simulates real backoff elapsing between ticks.
    for (let i = 0; i < 5; i++) {
      await makeDue(id);
      await deliverEmails({ log: () => {} });
    }

    expect(sendEmail).toHaveBeenCalledTimes(5);
    const after = await rowStatus(id);
    expect(after.status).toBe('dead');
    expect(after.attempts).toBe(5);
    expect(after.lastError).toContain('smtp 550');
  });

  it('dedupeKey makes a second enqueue a no-op (SR-12/PAR-03 replay suppression)', async () => {
    const payload = { to: 'buyer@example.com', subject: 'Refund', html: '<p>refund</p>', text: 'refund' };
    const first = await withStore(STORE, (tx) => enqueueEmail(tx, STORE, { kind: 'order-refund-confirmation', recipient: 'buyer@example.com', payload, dedupeKey: 'order-refund-confirmation:ref-9' }));
    const dupe = await withStore(STORE, (tx) => enqueueEmail(tx, STORE, { kind: 'order-refund-confirmation', recipient: 'buyer@example.com', payload, dedupeKey: 'order-refund-confirmation:ref-9' }));
    const other = await withStore(STORE, (tx) => enqueueEmail(tx, STORE, { kind: 'order-refund-confirmation', recipient: 'buyer@example.com', payload, dedupeKey: 'order-refund-confirmation:ref-10' }));
    expect(first).toBe(true);
    expect(dupe).toBe(false);
    expect(other).toBe(true);
    const n = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT count(*)::int AS n FROM email_outbox`);
      return (r.rows[0] as { n: number }).n;
    });
    expect(n).toBe(2);
  });

  it('a dead-lettered email emits an operator-visible signal (audit + email.dead event)', async () => {
    // Subscribe a webhook endpoint so the 'email.dead' emit produces a delivery row.
    await withStore(STORE, async (tx) => {
      await tx.execute(sql`INSERT INTO webhook_endpoint (store_id, url, topics, secret) VALUES (${STORE}, 'https://ops.example/hook', '{email.dead}', 's3cret')`);
    });
    vi.mocked(sendEmail).mockResolvedValue({ delivered: false, reason: 'smtp 550 permanent' });

    const id = await enqueueRow('buyer@example.com', 'Order confirmed — SR-DEAD2');
    for (let i = 0; i < 5; i++) {
      await makeDue(id);
      await deliverEmails({ log: () => {} });
    }

    const audit = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT action, entity_id AS "entityId", data FROM audit_log WHERE entity = 'email_outbox'`);
      return r.rows as Array<{ action: string; entityId: string; data: { kind?: string; recipient?: string; attempts?: number } }>;
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('delivery_dead');
    expect(audit[0]!.entityId).toBe(id);
    expect(audit[0]!.data.recipient).toBe('buyer@example.com');

    const deliveries = await withStore(STORE, async (tx) => {
      const r = await tx.execute(sql`SELECT topic, payload FROM webhook_delivery`);
      return r.rows as Array<{ topic: string; payload: { id?: string; kind?: string } }>;
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.topic).toBe('email.dead');
    expect(deliveries[0]!.payload.id).toBe(id);
  });
});