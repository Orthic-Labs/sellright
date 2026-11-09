/**
 * DB tests — DB-M2: sent outbox rows are deleted after 30 days, dead rows after 90; pending/processing rows and
 * younger rows are never touched.
 */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { reapOutboxes } from './outbox-retention.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'outbox-retention.db.test.ts');

const STORE = 'dddddddd-dddd-dddd-dddd-ddddddddd002';
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 24 * 3_600_000).toISOString();

async function seedEmail(status: string, daysAgo: number) {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO email_outbox (store_id, kind, recipient, payload, status, sent_at, updated_at)
      VALUES (${STORE}, 'k', 'a@example.com', '{}'::jsonb, ${status}, ${iso(daysAgo)}::timestamptz, ${iso(daysAgo)}::timestamptz)`);
  });
}
async function seedPush(status: string, daysAgo: number) {
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO push_outbox (store_id, topic, device_token, payload, status, sent_at, updated_at)
      VALUES (${STORE}, 't', 'tok', '{}'::jsonb, ${status}, ${iso(daysAgo)}::timestamptz, ${iso(daysAgo)}::timestamptz)`);
  });
}
async function seedWebhook(status: string, daysAgo: number) {
  await withStore(STORE, async (tx) => {
    const ep = await tx.execute(sql`INSERT INTO webhook_endpoint (store_id, url, topics, secret) VALUES (${STORE}, 'https://example.com/h', ARRAY['*'], 's') RETURNING id`);
    const id = (ep.rows[0] as { id: string }).id;
    await tx.execute(sql`INSERT INTO webhook_delivery (store_id, endpoint_id, topic, payload, status, delivered_at, updated_at)
      VALUES (${STORE}, ${id}, 't', '{}'::jsonb, ${status}, ${iso(daysAgo)}::timestamptz, ${iso(daysAgo)}::timestamptz)`);
  });
}
const count = (table: string) => withStore(STORE, async (tx) => (await tx.execute(sql.raw(`SELECT status, count(*)::int AS n FROM ${table} GROUP BY status ORDER BY status`))).rows as Array<{ status: string; n: number }>);

describe('reapOutboxes (DB-M2)', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE store CASCADE');
    await withStore(STORE, async (tx) => { await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, 'outbox-retention-test', 'x')`); });
  });
  afterAll(async () => { await pool.query('TRUNCATE store CASCADE'); await pool.end(); });

  it('email: sent > 30 d and dead > 90 d go; younger, pending and processing stay', async () => {
    await seedEmail('sent', 31); await seedEmail('sent', 29);
    await seedEmail('dead', 91); await seedEmail('dead', 60);
    await seedEmail('pending', 200); await seedEmail('processing', 200);
    const r = await reapOutboxes({ apply: true });
    expect(r.deleted['email_outbox.sent']).toBe(1);
    expect(r.deleted['email_outbox.dead']).toBe(1);
    expect(await count('email_outbox')).toEqual([{ status: 'dead', n: 1 }, { status: 'pending', n: 1 }, { status: 'processing', n: 1 }, { status: 'sent', n: 1 }]);
  });

  it('push and webhook_delivery follow the same rule (webhook dead = failed)', async () => {
    await seedPush('sent', 40); await seedPush('dead', 100); await seedPush('pending', 400);
    await seedWebhook('delivered', 40); await seedWebhook('failed', 100); await seedWebhook('failed', 10); await seedWebhook('pending', 400);
    await reapOutboxes({ apply: true });
    expect(await count('push_outbox')).toEqual([{ status: 'pending', n: 1 }]);
    expect(await count('webhook_delivery')).toEqual([{ status: 'failed', n: 1 }, { status: 'pending', n: 1 }]);
  });

  it('dry-run counts and deletes nothing', async () => {
    await seedEmail('sent', 40);
    const r = await reapOutboxes({ apply: false });
    expect(r.deleted['email_outbox.sent']).toBe(1);
    expect(await count('email_outbox')).toEqual([{ status: 'sent', n: 1 }]);
  });
});
