/** DB tests for abandoned-cart recovery selection + enqueue. Disposable *_test DB only. */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { sendCartRecoveryEmails } from './abandoned-cart-recovery.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'abandoned-cart-recovery.db.test.ts');

const STORE = 'dddddddd-1111-4111-8111-111111111111';
const HOURS = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);
let seq = 0;

async function seedStore(config?: unknown) {
  await pool.query('TRUNCATE store CASCADE');
  await pool.query('INSERT INTO store (id, slug, name, currency, config) VALUES ($1, $2, $2, $3, $4::jsonb)', [STORE, 'recovery-test', 'USD', config ? JSON.stringify(config) : null]);
}

async function seedCart(o: { status?: string; email?: string | null; lines?: number; ageMs?: number; reminded?: boolean }) {
  return withStore(STORE, async (tx) => {
    const r = await tx.execute(sql`INSERT INTO cart (id, store_id, token, status, email, updated_at, recovery_emailed_at)
      VALUES (gen_random_uuid(), ${STORE}, ${`rec-${++seq}`}, ${o.status ?? 'abandoned'}, ${o.email === undefined ? 'a@example.com' : o.email},
              ${ago(o.ageMs ?? 3 * HOURS)}, ${o.reminded ? new Date() : null}) RETURNING id`);
    const id = (r.rows[0] as { id: string }).id;
    for (let i = 0; i < (o.lines ?? 1); i++) await tx.execute(sql`INSERT INTO cart_line (id, store_id, cart_id, sku, quantity) VALUES (gen_random_uuid(), ${STORE}, ${id}, ${`SKU-${i}`}, 1)`);
    return id;
  });
}
const outbox = async () => (await pool.query("SELECT kind, recipient FROM email_outbox WHERE kind = 'cart_recovery'")).rows;

describe('sendCartRecoveryEmails', () => {
  beforeEach(async () => { await seedStore(); });

  it('mails only abandoned + email + lines + unreminded + past-delay carts, once', async () => {
    const due = await seedCart({});
    await seedCart({ status: 'active' });
    await seedCart({ email: null });
    await seedCart({ lines: 0 });
    await seedCart({ reminded: true });
    await seedCart({ ageMs: 30 * 60_000 });          // inside the delay window
    await seedCart({ ageMs: 8 * 24 * HOURS });       // older than the 7-day link lifetime
    expect(await sendCartRecoveryEmails({ delayHours: 2 })).toEqual({ enqueued: 1 });
    expect(await outbox()).toEqual([{ kind: 'cart_recovery', recipient: 'a@example.com' }]);
    const stamped = await pool.query('SELECT recovery_emailed_at FROM cart WHERE id = $1', [due]);
    expect(stamped.rows[0].recovery_emailed_at).not.toBeNull();
    expect(await sendCartRecoveryEmails({ delayHours: 2 })).toEqual({ enqueued: 0 }); // never twice
  });

  it('skips unsubscribed addresses', async () => {
    await seedCart({ email: 'Gone@Example.com' });
    await pool.query("INSERT INTO subscriber (store_id, email, kind, status) VALUES ($1, 'gone@example.com', 'newsletter', 'unsubscribed')", [STORE]);
    expect(await sendCartRecoveryEmails({ delayHours: 2 })).toEqual({ enqueued: 0 });
  });

  it('honours the per-store opt-out and delay 0', async () => {
    await seedStore({ marketing: { cartRecovery: false } });
    await seedCart({});
    expect(await sendCartRecoveryEmails({ delayHours: 2 })).toEqual({ enqueued: 0 });
    await seedStore();
    await seedCart({});
    expect(await sendCartRecoveryEmails({ delayHours: 0 })).toEqual({ enqueued: 0 });
  });
});
