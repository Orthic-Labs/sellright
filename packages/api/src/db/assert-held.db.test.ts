/**
 * Runtime guard for HeldLocks (STOREKIT §5.5): assertHeld accepts the brand only from withLockedSet, in the
 * same transaction, with the promised advisory keys granted to this backend; it is a no-op in production.
 * Lane test DB only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore, type Tx } from './client.js';
import { env } from '../env.js';
import { assertHeld, HeldLocksMissing, withLockedSet, type HeldLocks, type PurchaseId } from './locks.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
if (!/_test(\b|$|\?)/.test(DB)) {
  throw new Error('assertHeld test truncates data — point DATABASE_URL at a *_test database');
}

const STORE = 'ffffffff-ffff-ffff-ffff-ffffffffff31';
const forged = {} as HeldLocks;
const PURCHASE: PurchaseId = { storeId: STORE, environment: 'Sandbox', originalTransactionId: 'held-guard-1' };

afterAll(async () => {
  await pool.end();
});

describe('assertHeld (STOREKIT §5.5)', () => {
  it('rejects a brand that withLockedSet did not mint', async () => {
    await withStore(STORE, async (tx: Tx) => {
      await expect(assertHeld(tx, forged)).rejects.toBeInstanceOf(HeldLocksMissing);
    });
  });

  it('accepts the brand inside the set that minted it, with its purchase advisory granted', async () => {
    await pool.query(`INSERT INTO store (id, slug, name, currency, config) VALUES ('${STORE}', 'held-guard', 'Held', 'USD', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    const ok = await withLockedSet(STORE, { kind: 'link', purchases: [PURCHASE] }, async (tx, held) => {
      await assertHeld(tx, held);
      return true;
    });
    expect(ok).toBe(true);
  });

  it('rejects a brand carried out of its set and used in another transaction', async () => {
    let escaped: HeldLocks | null = null;
    await withLockedSet(STORE, { kind: 'link', purchases: [PURCHASE] }, async (_tx, held) => {
      escaped = held;
    });
    await withStore(STORE, async (tx: Tx) => {
      await expect(assertHeld(tx, escaped!)).rejects.toThrow(/different transaction/);
    });
  });

  it('is a no-op in production builds', async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await withStore(STORE, async (tx: Tx) => {
        await expect(assertHeld(tx, forged)).resolves.toBeUndefined();
      });
    } finally {
      process.env.NODE_ENV = before;
    }
  });

  it('checks granted advisory keys in pg_locks for this backend', async () => {
    await withLockedSet(STORE, { kind: 'link', purchases: [PURCHASE] }, async (tx, held) => {
      const { rows } = await tx.execute(sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted`);
      expect((rows as { n: number }[])[0]!.n).toBeGreaterThanOrEqual(1);
      await assertHeld(tx, held);
    });
  });
});
