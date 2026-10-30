// B4: credit issuance reads the store row under FOR NO KEY UPDATE (it never changes store keys), so it no longer
// blocks — or is blocked by — concurrent inserts that reference the store (FK key-share checks: orders, carts, ...).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import * as s from '../db/schema.js';
import { issue } from './service.js';

assertTestDatabase(process.env.DATABASE_URL ?? env.DATABASE_URL, 'account-credit/service.store-lock.db.test.ts');
const STORE = 'cccccccc-accd-4000-8000-000000000001';
beforeEach(async () => {
  await pool.query('TRUNCATE store CASCADE');
  await withStore(STORE, tx => tx.insert(s.store).values({ id: STORE, slug: 'credit-store-lock', name: 'Credit store lock', currency: 'USD' }));
});
afterAll(async () => { await pool.query('TRUNCATE store CASCADE'); });

async function holdKeyShare() {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  let ready!: () => void; const held = new Promise<void>(r => { ready = r; });
  const done = withStore(STORE, async tx => {
    // An FK-checked insert takes FOR KEY SHARE on the referenced store row.
    await tx.insert(s.order).values({ storeId: STORE, code: 'KEYSHARE-1', currency: 'USD' });
    ready(); await gate;
  });
  await held;
  return async () => { release(); await done; };
}

describe('B4 store lock strength in credit issuance', () => {
  it('issue() completes while another transaction holds a key-share lock on the store', async () => {
    const release = await holdKeyShare();
    try {
      const result = await withStore(STORE, async tx => {
        await tx.execute(sql`SET LOCAL lock_timeout = '300ms'`);
        return issue(tx, { storeId: STORE, amount: 500, email: 'a@example.invalid', issuanceKey: 'store-lock-1' });
      });
      expect(result.created).toBe(true);
    } finally { await release(); }
  });

  it('issuance stays idempotent and serialized under concurrency (one account per key)', async () => {
    const run = () => withStore(STORE, tx => issue(tx, { storeId: STORE, amount: 500, email: 'a@example.invalid', issuanceKey: 'store-lock-2' }));
    const results = await Promise.all([run(), run(), run()]);
    expect(results.filter(r => r.created)).toHaveLength(1);
    expect(new Set(results.map(r => r.account.id)).size).toBe(1);
  });
});
