/**
 * Passkeys (0108) — the two security-epoch triggers, exercised with the exact SQL shapes the engine (and the previous
 * image) emits (design §4 matrix, "any image" rows). Runs as the configured runtime role, like every other db test.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../db/client.js';
import { requireDisposablePostgresUrl } from '../db/test-database-url.js';
import { env } from '../env.js';

requireDisposablePostgresUrl(process.env.DATABASE_URL ?? env.DATABASE_URL, 'passkeys-triggers.db.test.ts');
const ADMIN = 'ee0e0e0e-0000-4000-8000-000000000001';
const STORE = 'ee0e0e0e-0000-4000-8000-000000000002';
const CUSTOMER = 'ee0e0e0e-0000-4000-8000-000000000003';
const inStore = async (sql: string, values: unknown[] = []) => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.current_store', $1, true)", [STORE]);
    const r = await c.query(sql, values);
    await c.query('COMMIT');
    return r.rows;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
};
const adminEpoch = async () => Number((await pool.query('SELECT security_epoch FROM admin_user WHERE id=$1', [ADMIN])).rows[0]!.security_epoch);
const customerEpoch = async () => Number((await inStore('SELECT security_epoch FROM customer WHERE id=$1', [CUSTOMER]))[0]!.security_epoch);
const stepUps = async () => (await pool.query('SELECT step_up_at, step_up_epoch FROM "session" WHERE admin_user_id=$1 ORDER BY token_hash', [ADMIN])).rows;

async function cleanup() {
  await pool.query('DELETE FROM "session" WHERE admin_user_id=$1', [ADMIN]);
  await pool.query('DELETE FROM admin_user WHERE id=$1', [ADMIN]);
  await inStore('DELETE FROM customer WHERE id=$1', [CUSTOMER]).catch(() => undefined);
  await pool.query('DELETE FROM store WHERE id=$1', [STORE]);
}
beforeEach(async () => {
  await cleanup();
  await pool.query("INSERT INTO store(id,slug,name,currency,config) VALUES($1,'passkey-trigger-fixture','Trigger fixture','USD','{}')", [STORE]);
  await pool.query("INSERT INTO admin_user(id,email,password_hash,totp_secret) VALUES($1,'passkey-trigger@example.test','hash-1','JBSWY3DPEHPK3PXP')", [ADMIN]);
  await pool.query('INSERT INTO "session"(admin_user_id,token_hash,expires_at,step_up_at,step_up_epoch) VALUES($1,$2,now()+interval \'1 day\',now(),0),($1,$3,now()+interval \'1 day\',now(),0)', [ADMIN, 'trg-a', 'trg-b']);
  await inStore("INSERT INTO customer(id,store_id,email,password_hash,email_verified) VALUES($1,$2,'passkey-trigger-customer@example.test','ph-1',true)", [CUSTOMER, STORE]);
});
afterAll(async () => { await cleanup(); await pool.end(); });

describe('admin_user_security_epoch_trg', () => {
  it('seal and unseal of the same logical secret change nothing', async () => {
    await pool.query("UPDATE admin_user SET totp_secret='enc1:sealed-form' WHERE id=$1", [ADMIN]);
    expect(await adminEpoch()).toBe(0);
    expect((await stepUps()).every((r) => r.step_up_at !== null && r.step_up_epoch === 0)).toBe(true);
    await pool.query("UPDATE admin_user SET totp_secret='JBSWY3DPEHPK3PXP' WHERE id=$1", [ADMIN]);
    expect(await adminEpoch()).toBe(0);
  });
  it('disable bumps the epoch and clears step-up on every session; re-enabling the same secret bumps again', async () => {
    await pool.query('UPDATE admin_user SET totp_secret=NULL WHERE id=$1', [ADMIN]);
    expect(await adminEpoch()).toBe(1);
    expect((await stepUps()).every((r) => r.step_up_at === null && r.step_up_epoch === null)).toBe(true);
    await pool.query("UPDATE admin_user SET totp_secret='JBSWY3DPEHPK3PXP' WHERE id=$1", [ADMIN]);
    expect(await adminEpoch()).toBe(2);
  });
  it('a password change clears step-ups without bumping the epoch (passkeys are not password-derived)', async () => {
    await pool.query("UPDATE admin_user SET password_hash='hash-2' WHERE id=$1", [ADMIN]);
    expect(await adminEpoch()).toBe(0);
    expect((await stepUps()).every((r) => r.step_up_at === null && r.step_up_epoch === null)).toBe(true);
  });
  it('an unrelated column update leaves everything alone', async () => {
    await pool.query("UPDATE admin_user SET name='Trigger' WHERE id=$1", [ADMIN]);
    expect(await adminEpoch()).toBe(0);
    expect((await stepUps()).every((r) => r.step_up_at !== null)).toBe(true);
  });
});

describe('customer_security_epoch_trg', () => {
  it('a password change bumps; the engine flagged in-place rehash does not; the flag dies with its transaction', async () => {
    await inStore("UPDATE customer SET password_hash='ph-2' WHERE id=$1", [CUSTOMER]);
    expect(await customerEpoch()).toBe(1);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.current_store', $1, true)", [STORE]);
      await c.query("SELECT set_config('app.passkey_rehash', '1', true)");
      await c.query("UPDATE customer SET password_hash='ph-3' WHERE id=$1", [CUSTOMER]);
      await c.query('COMMIT');
    } finally { c.release(); }
    expect(await customerEpoch()).toBe(1);
    await inStore("UPDATE customer SET password_hash='ph-4' WHERE id=$1", [CUSTOMER]);
    expect(await customerEpoch()).toBe(2);
  });
  it('a first password on a passwordless account bumps (the previous image reset takes this shape)', async () => {
    await inStore('UPDATE customer SET password_hash=NULL WHERE id=$1', [CUSTOMER]);
    const after = await customerEpoch();
    await inStore("UPDATE customer SET password_hash='ph-first' WHERE id=$1", [CUSTOMER]);
    expect(await customerEpoch()).toBe(after + 1);
  });
});
