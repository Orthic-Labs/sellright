import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { pool } from '../db/client.js';
import { requireDisposablePostgresUrl } from '../db/test-database-url.js';
import { env } from '../env.js';
import { getAdminCredentialsById, mutateAdminSecondFactor } from './admin-staff.js';
import { regenerateRecoveryCodes } from './second-factor.js';

requireDisposablePostgresUrl(process.env.DATABASE_URL ?? env.DATABASE_URL, 'admin-mfa.db.test.ts');
const ADMIN = 'bfbfbfbf-0000-4000-8000-000000000001';
const STORE = 'bfbfbfbf-0000-4000-8000-000000000002';
const TOKEN = 'mfa-policy-fixture-session';
const OTHER_TOKEN = 'mfa-policy-fixture-other';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const originalMode = env.ADMIN_REQUIRE_TOTP;

async function cleanup() {
  await pool.query('DELETE FROM admin_recovery_code WHERE admin_user_id=$1', [ADMIN]);
  await pool.query('DELETE FROM admin_totp_used_step WHERE admin_user_id=$1', [ADMIN]);
  await pool.query('DELETE FROM "session" WHERE admin_user_id=$1', [ADMIN]);
  await pool.query('DELETE FROM admin_user_store WHERE admin_user_id=$1', [ADMIN]);
  await pool.query('DELETE FROM audit_log WHERE entity_id=$1', [ADMIN]);
  await pool.query('DELETE FROM admin_user WHERE id=$1', [ADMIN]);
  await pool.query('DELETE FROM store WHERE id=$1', [STORE]);
}
beforeEach(async () => {
  env.ADMIN_REQUIRE_TOTP = 'off';
  await cleanup();
  await pool.query("INSERT INTO store(id,slug,name,currency,config) VALUES($1,'mfa-policy-fixture','MFA fixture','USD','{}')", [STORE]);
  await pool.query("INSERT INTO admin_user(id,email,password_hash,totp_secret) VALUES($1,'mfa-policy-fixture@example.test','fixture-password-hash','JBSWY3DPEHPK3PXP')", [ADMIN]);
  await pool.query("INSERT INTO admin_user_store(admin_user_id,store_id,role) VALUES($1,$2,'owner')", [ADMIN, STORE]);
  await pool.query('INSERT INTO "session"(admin_user_id,token_hash,expires_at) VALUES($1,$2,now()+interval \'1 day\'),($1,$3,now()+interval \'1 day\')', [ADMIN, hash(TOKEN), hash(OTHER_TOKEN)]);
});
afterAll(async () => { env.ADMIN_REQUIRE_TOTP = originalMode; await cleanup(); await pool.end(); });

async function snapshot() {
  const credential = await pool.query('SELECT password_hash,totp_secret FROM admin_user WHERE id=$1', [ADMIN]);
  const codes = await pool.query('SELECT id,code_hash,used_at FROM admin_recovery_code WHERE admin_user_id=$1 ORDER BY id', [ADMIN]);
  const steps = await pool.query('SELECT step FROM admin_totp_used_step WHERE admin_user_id=$1 ORDER BY step', [ADMIN]);
  const sessions = await pool.query('SELECT id,token_hash,expires_at,last_seen_at,step_up_at FROM "session" WHERE admin_user_id=$1 ORDER BY id', [ADMIN]);
  const audit = await pool.query('SELECT id,action,data FROM audit_log WHERE entity_id=$1 ORDER BY id', [ADMIN]);
  return { credential: credential.rows, codes: codes.rows, steps: steps.rows, sessions: sessions.rows, audit: audit.rows };
}

describe('atomic required-MFA disable policy', () => {
  it.each(['all', 'installation', 'store'] as const)('refuses %s policy without changing credentials, sessions or proof ledgers', async policy => {
    const [code] = await regenerateRecoveryCodes(ADMIN);
    const creds = (await getAdminCredentialsById(ADMIN))!;
    if (policy === 'all') env.ADMIN_REQUIRE_TOTP = 'all';
    if (policy === 'installation') {
      env.ADMIN_REQUIRE_TOTP = 'privileged';
      await pool.query('DELETE FROM admin_user_store WHERE admin_user_id=$1', [ADMIN]);
      await pool.query('UPDATE admin_user SET is_installation_admin=true WHERE id=$1', [ADMIN]);
    }
    if (policy === 'store') await pool.query('UPDATE store SET config=$2::jsonb WHERE id=$1', [STORE, JSON.stringify({ security: { requireTotp: true } })]);
    await pool.query('INSERT INTO admin_totp_used_step(admin_user_id,step) VALUES($1,1)', [ADMIN]);
    const before = await snapshot();
    await expect(mutateAdminSecondFactor({ adminId: ADMIN, token: TOKEN, ...creds, action: 'disable', code })).rejects.toMatchObject({ code: 'TOTP_REQUIRED' });
    expect(await snapshot()).toEqual(before);
  });

  it('disables optional MFA after atomic recovery proof while preserving sessions', async () => {
    const [code] = await regenerateRecoveryCodes(ADMIN);
    const creds = (await getAdminCredentialsById(ADMIN))!, before = await snapshot();
    expect(await mutateAdminSecondFactor({ adminId: ADMIN, token: TOKEN, ...creds, action: 'disable', code })).toEqual({ recoveryCodes: [] });
    const after = await snapshot();
    expect(after.credential).toEqual([{ password_hash: creds.passwordHash, totp_secret: null }]);
    expect(after.codes).toEqual([]);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.steps).toEqual(before.steps);
    expect(after.audit).toEqual(before.audit);
  });

  it('observes a concurrent store-policy commit before consuming disable proof', async () => {
    const [code] = await regenerateRecoveryCodes(ADMIN);
    const creds = (await getAdminCredentialsById(ADMIN))!, before = await snapshot();
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query('UPDATE store SET config=$2::jsonb WHERE id=$1', [STORE, JSON.stringify({ security: { requireTotp: true } })]);
      const refusal = expect(mutateAdminSecondFactor({ adminId: ADMIN, token: TOKEN, ...creds, action: 'disable', code })).rejects.toMatchObject({ code: 'TOTP_REQUIRED' });
      await writer.query('COMMIT');
      await refusal;
    } finally { await writer.query('ROLLBACK'); writer.release(); }
    expect(await snapshot()).toEqual(before);
  });
});
