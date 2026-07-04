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
import { deliverEmails } from './outbox.js';

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
    const dueSec = (after.nextAttemptAt.getTime() - Date.now()) / 1000;
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
});