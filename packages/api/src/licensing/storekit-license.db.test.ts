/** StoreKit activation cap regressions against a disposable test database. */
import { requireDisposablePostgresUrl as assertTestDatabase } from '../db/test-database-url.js';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';
import { issueStoreKitActivation } from './storekit-license.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
assertTestDatabase(DB, 'storekit-license.db.test.ts');

const STORE = 'abababab-abab-4bab-8bab-abababababab';
const APP = 'storekit-cap-test';
const KEY = 'storekit-seat-cap';
const hashish = (label: string) => `${label}${'0'.repeat(64 - label.length)}`;
const issue = (deviceIdHash: string) => withStore(STORE, (tx) => issueStoreKitActivation(tx, {
  storeId: STORE, appKey: APP, licenseKey: KEY, deviceIdHash, platform: 'ios',
}));
const activationRows = () => withStore(STORE, async (tx) => {
  const result = await tx.execute(sql`
    SELECT id, state, generation, activation_token_hash FROM license_activation ORDER BY id
  `);
  return result.rows;
});

async function wipe() { await pool.query('TRUNCATE store CASCADE'); }
beforeEach(async () => {
  await wipe();
  await withStore(STORE, async (tx) => {
    await tx.execute(sql`INSERT INTO store (id, slug, name) VALUES (${STORE}, 'storekit-cap-test', 'StoreKit cap test')`);
    await tx.execute(sql`
      INSERT INTO license (store_id, app_key, license_key, status, seats, source)
      VALUES (${STORE}, ${APP}, ${KEY}, 'active'::license_status, 1, 'storekit')
    `);
  });
});
afterEach(wipe);
afterAll(() => pool.end());

describe('issueStoreKitActivation — tombstone seat accounting', () => {
  it.each(['removed', 'revoked'])('cannot reactivate a %s device while another device holds the last seat', async (state) => {
    const returningDevice = hashish('returning');
    const first = await issue(returningDevice);
    if (first.kind !== 'ok') throw new Error('fixture issuance failed');
    await withStore(STORE, (tx) => tx.execute(sql`
      UPDATE license_activation SET state = ${state}, generation = generation + 1,
        removed_at = CASE WHEN ${state} = 'removed' THEN now() ELSE NULL END,
        revoked_at = CASE WHEN ${state} = 'revoked' THEN now() ELSE NULL END
      WHERE id = ${first.activationId}
    `));
    const holderDevice = hashish('seat-holder');
    const holder = await issue(holderDevice);
    expect(holder.kind).toBe('ok');
    if (holder.kind !== 'ok') throw new Error('fixture issuance failed');
    const before = await activationRows();

    expect(await issue(returningDevice)).toEqual({ kind: 'full' });
    expect(await activationRows()).toEqual(before);
    // Re-linking the device that already holds this seat remains allowed.
    expect((await issue(holderDevice)).kind).toBe('ok');

    await withStore(STORE, (tx) => tx.execute(sql`
      UPDATE license_activation SET state = 'removed', removed_at = now(), generation = generation + 1
      WHERE id = ${holder.activationId}
    `));
    const restored = await issue(returningDevice);
    expect(restored.kind).toBe('ok');
    if (restored.kind !== 'ok') throw new Error('unreachable');
    expect(restored.activationId).toBe(first.activationId);
    const after = await activationRows();
    expect(after).toHaveLength(2);
    expect(after.filter((row) => row.state === 'active')).toEqual([
      expect.objectContaining({ id: first.activationId, generation: 1 }),
    ]);
    const timestamps = await withStore(STORE, (tx) => tx.execute(sql`
      SELECT removed_at, revoked_at FROM license_activation WHERE id = ${first.activationId}
    `));
    expect(timestamps.rows[0]).toEqual({ removed_at: null, revoked_at: null });
  });
});
