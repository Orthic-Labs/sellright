/**
 * Passkeys (0108) — branch contracts of passkeys-admin.ts / passkeys-shop.ts against a real database, driven by the
 * software authenticator (sdk/webauthn.testkit.ts). Each binding of the ceremony contract (design §7) is negated once;
 * the §4 matrix rows reachable at module level are proven here, the route-level rows in the authorization matrix.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, withStore } from '../db/client.js';
import { requireDisposablePostgresUrl } from '../db/test-database-url.js';
import { env } from '../env.js';
import { createSoftwareAuthenticator } from '../sdk/webauthn.testkit.js';
import { hashPassword } from './password.js';
import {
  adminLoginOptions, adminLoginVerify, adminRegisterOptions, adminRegisterVerify, adminStepUpOptions, adminStepUpVerify, deleteAdminPasskey, listAdminPasskeys,
} from './passkeys-admin.js';
import { adminUserHandle, customerUserHandle, relyingPartyFor } from './passkeys-core.js';
import {
  deleteCustomerPasskeysForRecovery, listCustomerPasskeys, shopDeletePasskey, shopGrantFromPassword, shopLoginOptions, shopLoginVerify, shopMailboxConfirm,
  shopMailboxRequest, shopManageOptions, shopManageVerify, shopRegisterOptions, shopRegisterVerify,
} from './passkeys-shop.js';

requireDisposablePostgresUrl(process.env.DATABASE_URL ?? env.DATABASE_URL, 'passkeys.db.test.ts');
const ADMIN = 'dd0d0d0d-0000-4000-8000-000000000001';
const STORE = 'dd0d0d0d-0000-4000-8000-000000000002';
const CUSTOMER = 'dd0d0d0d-0000-4000-8000-000000000003';
let SESSION = '';
let CSESSION = '';
let IP = '';
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const rp = relyingPartyFor('https://shop.example.test', 'Fixture');
const ORIGIN = 'https://shop.example.test';
const originalEnabled = env.PASSKEYS_ENABLED;

async function cleanup() {
  await pool.query('DELETE FROM admin_passkey_challenge WHERE admin_user_id=$1 OR admin_user_id IS NULL', [ADMIN]);
  await pool.query('DELETE FROM admin_passkey_credential WHERE admin_user_id=$1', [ADMIN]);
  await pool.query('DELETE FROM "session" WHERE admin_user_id=$1 OR customer_id=$2', [ADMIN, CUSTOMER]);
  await pool.query('DELETE FROM admin_user WHERE id=$1', [ADMIN]);
  await withStore(STORE, async (tx) => {
    await tx.execute(`DELETE FROM customer_passkey_challenge WHERE store_id='${STORE}'`);
    await tx.execute(`DELETE FROM customer_passkey_credential WHERE store_id='${STORE}'`);
    await tx.execute(`DELETE FROM customer_token WHERE customer_id='${CUSTOMER}'`);
    await tx.execute(`DELETE FROM customer WHERE id='${CUSTOMER}'`);
  }).catch(() => undefined);
  await pool.query('DELETE FROM store WHERE id=$1', [STORE]);
  await pool.query("DELETE FROM rate_limit_attempt WHERE bucket LIKE 'pk-%'").catch(() => undefined);
}
let customerPasswordHash = '';
beforeEach(async () => {
  env.PASSKEYS_ENABLED = '1';
  // Fresh session tokens and peer per test: the per-session / per-IP budgets (design §8) are real and persist.
  SESSION = 'pk-admin-' + randomBytes(12).toString('hex'); CSESSION = 'pk-cust-' + randomBytes(12).toString('hex'); IP = '198.51.' + (1 + Math.floor(Math.random() * 250)) + '.' + (1 + Math.floor(Math.random() * 250));
  await cleanup();
  await pool.query("INSERT INTO store(id,slug,name,currency,config) VALUES($1,'passkey-fixture','Passkey fixture','USD','{}')", [STORE]);
  await pool.query("INSERT INTO admin_user(id,email,password_hash,totp_secret) VALUES($1,'passkey-fixture@example.test','fixture-hash','JBSWY3DPEHPK3PXP')", [ADMIN]);
  await pool.query('INSERT INTO "session"(admin_user_id,token_hash,expires_at,last_seen_at,step_up_at,step_up_epoch) VALUES($1,$2,now()+interval \'1 day\',now(),now(),0)', [ADMIN, sha(SESSION)]);
  customerPasswordHash = await hashPassword('Fixture-password-1');
  await withStore(STORE, (tx) => tx.execute(`INSERT INTO customer(id,store_id,email,password_hash,email_verified) VALUES('${CUSTOMER}','${STORE}','passkey-customer@example.test','${customerPasswordHash}',true)`));
  await pool.query('INSERT INTO "session"(store_id,customer_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval \'30 days\')', [STORE, CUSTOMER, sha(CSESSION)]);
});
afterAll(async () => { env.PASSKEYS_ENABLED = originalEnabled; await cleanup(); await pool.end(); });

const authenticator = () => createSoftwareAuthenticator({ rpId: rp.rpId, origin: ORIGIN });

async function enrolAdmin(auth = authenticator()) {
  const o = await adminRegisterOptions({ rp, adminId: ADMIN, sessionToken: SESSION });
  if (!o.ok) throw new Error('register options refused: ' + o.code);
  const v = await adminRegisterVerify({ rp, adminId: ADMIN, sessionToken: SESSION, response: auth.register({ challenge: o.options.challenge, userHandle: adminUserHandle(ADMIN) }), nonce: o.nonce, label: 'phone' });
  if (!v.ok) throw new Error('register verify refused: ' + v.code);
  return { auth, passkey: v.passkey };
}
async function loginAdmin(auth: ReturnType<typeof authenticator>, counter = 1, overrides: { nonce?: string; userHandle?: Uint8Array; origin?: string } = {}) {
  const o = await adminLoginOptions(rp);
  return adminLoginVerify({ rp, response: auth.authenticate({ challenge: o.options.challenge, counter, userHandle: overrides.userHandle ?? adminUserHandle(ADMIN), ...(overrides.origin ? { origin: overrides.origin } : {}) }), nonce: overrides.nonce ?? o.nonce, ip: IP });
}

describe('admin passkeys', () => {
  it('registers under step-up, lists, signs in by discoverable assertion, advances the counter', async () => {
    const { auth, passkey } = await enrolAdmin();
    expect(passkey.label).toBe('phone');
    expect((await listAdminPasskeys(ADMIN)).map((p) => p.id)).toEqual([passkey.id]);
    const r = await loginAdmin(auth, 1);
    expect(r.ok).toBe(true);
    const row = (await pool.query('SELECT counter, last_used_at FROM admin_passkey_credential WHERE id=$1', [passkey.id])).rows[0]!;
    expect(Number(row.counter)).toBe(1);
    expect(row.last_used_at).not.toBeNull();
    const sessions = await pool.query('SELECT token_hash FROM "session" WHERE admin_user_id=$1', [ADMIN]);
    expect(sessions.rows.length).toBe(2);
  });
  it('refuses registration without TOTP and without a current-epoch step-up', async () => {
    await pool.query('UPDATE "session" SET step_up_epoch=NULL WHERE token_hash=$1', [sha(SESSION)]);
    expect((await adminRegisterOptions({ rp, adminId: ADMIN, sessionToken: SESSION }))).toMatchObject({ ok: false, code: 'STEP_UP_REQUIRED' });
    await pool.query('UPDATE "session" SET step_up_epoch=0 WHERE token_hash=$1', [sha(SESSION)]);
    await pool.query('UPDATE admin_user SET totp_secret=NULL WHERE id=$1', [ADMIN]); // trigger: epoch 1, step-ups cleared
    expect((await adminRegisterOptions({ rp, adminId: ADMIN, sessionToken: SESSION }))).toMatchObject({ ok: false, code: 'TOTP_REQUIRED_FIRST' });
  });
  it('negates every login binding: nonce, replay, wrong origin, userHandle, counter regression, stale epoch', async () => {
    const { auth, passkey } = await enrolAdmin();
    expect((await loginAdmin(auth, 1, { nonce: 'not-the-cookie' })).ok).toBe(false);
    expect((await loginAdmin(auth, 1, { origin: 'https://evil.example.test' })).ok).toBe(false);
    expect((await loginAdmin(auth, 1, { userHandle: new Uint8Array(32) })).ok).toBe(false);
    const o = await adminLoginOptions(rp);
    const assertion = auth.authenticate({ challenge: o.options.challenge, counter: 2, userHandle: adminUserHandle(ADMIN) });
    expect((await adminLoginVerify({ rp, response: assertion, nonce: o.nonce, ip: IP })).ok).toBe(true);
    expect((await adminLoginVerify({ rp, response: assertion, nonce: o.nonce, ip: IP })).ok).toBe(false); // replayed challenge
    expect((await loginAdmin(auth, 1)).ok).toBe(false); // counter regression (stored 2)
    expect(Number((await pool.query('SELECT counter FROM admin_passkey_credential WHERE id=$1', [passkey.id])).rows[0]!.counter)).toBe(2);
    await pool.query('UPDATE admin_user SET totp_secret=NULL WHERE id=$1', [ADMIN]); // trigger bumps the epoch
    await pool.query("UPDATE admin_user SET totp_secret='JBSWY3DPEHPK3PXP' WHERE id=$1", [ADMIN]);
    expect((await loginAdmin(auth, 3)).ok).toBe(false);
    expect((await pool.query('SELECT id FROM admin_passkey_credential WHERE id=$1', [passkey.id])).rows).toEqual([]); // stale-epoch credential deleted
  });
  it('passkey step-up stamps the current epoch; deletion clears step-up on every session and refuses a successor', async () => {
    const { auth, passkey } = await enrolAdmin();
    await pool.query('UPDATE "session" SET step_up_at=NULL, step_up_epoch=NULL WHERE token_hash=$1', [sha(SESSION)]);
    const o = await adminStepUpOptions({ rp, adminId: ADMIN, sessionToken: SESSION });
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    const v = await adminStepUpVerify({ rp, adminId: ADMIN, sessionToken: SESSION, response: auth.authenticate({ challenge: o.options.challenge, counter: 1, userHandle: adminUserHandle(ADMIN) }), nonce: o.nonce });
    expect(v.ok).toBe(true);
    const su = (await pool.query('SELECT step_up_at, step_up_epoch FROM "session" WHERE token_hash=$1', [sha(SESSION)])).rows[0]!;
    expect(su.step_up_at).not.toBeNull();
    expect(su.step_up_epoch).toBe(0);
    expect(await deleteAdminPasskey({ adminId: ADMIN, id: passkey.id })).toBe(true);
    const after = (await pool.query('SELECT step_up_at, step_up_epoch FROM "session" WHERE token_hash=$1', [sha(SESSION)])).rows[0]!;
    expect(after.step_up_at).toBeNull();
    expect((await adminRegisterOptions({ rp, adminId: ADMIN, sessionToken: SESSION }))).toMatchObject({ ok: false, code: 'STEP_UP_REQUIRED' });
  });
  it('a registration challenge cannot be redeemed as a step-up and a manage-kind challenge cannot register', async () => {
    const { auth } = await enrolAdmin();
    const reg = await adminRegisterOptions({ rp, adminId: ADMIN, sessionToken: SESSION });
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;
    const asStepUp = await adminStepUpVerify({ rp, adminId: ADMIN, sessionToken: SESSION, response: auth.authenticate({ challenge: reg.options.challenge, counter: 5, userHandle: adminUserHandle(ADMIN) }), nonce: reg.nonce });
    expect(asStepUp.ok).toBe(false);
    const su = await adminStepUpOptions({ rp, adminId: ADMIN, sessionToken: SESSION });
    if (!su.ok) throw new Error('step-up options');
    const asRegister = await adminRegisterVerify({ rp, adminId: ADMIN, sessionToken: SESSION, response: authenticator().register({ challenge: su.options.challenge }), nonce: su.nonce, label: 'x' });
    expect(asRegister.ok).toBe(false);
  });
});

async function grantByPassword() {
  const g = await shopGrantFromPassword({ rp, storeId: STORE, customerId: CUSTOMER, sessionToken: CSESSION, password: 'Fixture-password-1' });
  if (!g.ok) throw new Error('grant refused: ' + g.code);
  return g;
}
async function enrolCustomer(auth = authenticator()) {
  const g = await grantByPassword();
  const o = await shopRegisterOptions({ rp, storeId: STORE, customerId: CUSTOMER, sessionToken: CSESSION, grant: g.grant, nonce: g.grantNonce });
  if (!o.ok) throw new Error('register options refused: ' + o.code);
  const v = await shopRegisterVerify({ rp, storeId: STORE, customerId: CUSTOMER, sessionToken: CSESSION, response: auth.register({ challenge: o.options.challenge }), nonce: o.nonce, label: 'laptop' });
  if (!v.ok) throw new Error('register verify refused: ' + v.code);
  return { auth, passkey: v.passkey };
}
async function loginCustomer(auth: ReturnType<typeof authenticator>, counter = 1) {
  const o = await shopLoginOptions({ rp, storeId: STORE });
  return shopLoginVerify({ rp, storeId: STORE, storeConfig: {}, response: auth.authenticate({ challenge: o.options.challenge, counter, userHandle: customerUserHandle(STORE, CUSTOMER) }), nonce: o.nonce, ip: IP });
}

describe('customer passkeys', () => {
  it('password proof → grant → registration → discoverable login; a grant is single-use', async () => {
    const { auth, passkey } = await enrolCustomer();
    expect((await listCustomerPasskeys(STORE, CUSTOMER)).map((p) => p.id)).toEqual([passkey.id]);
    const r = await loginCustomer(auth, 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.customer.id).toBe(CUSTOMER);
    const g = await grantByPassword();
    const first = await shopRegisterOptions({ rp, storeId: STORE, customerId: CUSTOMER, sessionToken: CSESSION, grant: g.grant, nonce: g.grantNonce });
    expect(first.ok).toBe(true);
    const second = await shopRegisterOptions({ rp, storeId: STORE, customerId: CUSTOMER, sessionToken: CSESSION, grant: g.grant, nonce: g.grantNonce });
    expect(second).toMatchObject({ ok: false, code: 'CEREMONY_INVALID' });
  });
  it('an unverified account can neither obtain a grant nor sign in with a passkey', async () => {
    const { auth } = await enrolCustomer();
    await withStore(STORE, (tx) => tx.execute(`UPDATE customer SET email_verified=false WHERE id='${CUSTOMER}'`));
    expect((await shopGrantFromPassword({ rp, storeId: STORE, customerId: CUSTOMER, sessionToken: CSESSION, password: 'Fixture-password-1' })).ok).toBe(false);
    expect((await loginCustomer(auth, 1)).ok).toBe(false);
  });
  it('a password change (reset shape) ends every credential and pending authorization; a flagged rehash keeps them', async () => {
    const { auth } = await enrolCustomer();
    const g = await grantByPassword(); // pending grant
    await withStore(STORE, async (tx) => {
      await tx.execute(`UPDATE customer SET password_hash='${await hashPassword('Fixture-password-2')}' WHERE id='${CUSTOMER}'`);
      await deleteCustomerPasskeysForRecovery(tx, STORE, CUSTOMER);
    });
    expect(await listCustomerPasskeys(STORE, CUSTOMER)).toEqual([]);
    expect((await loginCustomer(auth, 1)).ok).toBe(false);
    expect((await shopRegisterOptions({ rp, storeId: STORE, customerId: CUSTOMER, sessionToken: CSESSION, grant: g.grant, nonce: g.grantNonce })).ok).toBe(false);
  });
  it('stale-epoch credentials are refused and removed even without the explicit wipe (previous-image shape)', async () => {
    const { auth, passkey } = await enrolCustomer();
    await withStore(STORE, (tx) => tx.execute(`UPDATE customer SET password_hash='${customerPasswordHash}x' WHERE id='${CUSTOMER}'`)); // trigger bumps the epoch
    expect((await loginCustomer(auth, 1)).ok).toBe(false);
    expect(await withStore(STORE, async (tx) => (await tx.execute(`SELECT id FROM customer_passkey_credential WHERE id='${passkey.id}'`)).rows)).toEqual([]);
  });
  it('manage proof with an existing passkey mints a grant; deleting that passkey kills the pending grant', async () => {
    const { auth, passkey } = await enrolCustomer();
    const o = await shopManageOptions({ rp, storeId: STORE, customerId: CUSTOMER, sessionToken: CSESSION });
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    const v = await shopManageVerify({ rp, storeId: STORE, customerId: CUSTOMER, sessionToken: CSESSION, response: auth.authenticate({ challenge: o.options.challenge, counter: 1, userHandle: customerUserHandle(STORE, CUSTOMER) }), nonce: o.nonce });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const g2 = await grantByPassword();
    expect((await shopDeletePasskey({ rp, storeId: STORE, storeConfig: {}, customerId: CUSTOMER, sessionToken: CSESSION, id: passkey.id, grant: g2.grant, nonce: g2.grantNonce })).ok).toBe(true);
    expect((await shopRegisterOptions({ rp, storeId: STORE, customerId: CUSTOMER, sessionToken: CSESSION, grant: v.grant, nonce: v.grantNonce })).ok).toBe(false);
  });
  it('mailbox proof only for accounts with neither password nor passkey; bound to session, browser and epoch; eligibility re-checked', async () => {
    await withStore(STORE, (tx) => tx.execute(`UPDATE customer SET password_hash=NULL WHERE id='${CUSTOMER}'`));
    let raw = '';
    const req = await shopMailboxRequest({ storeId: STORE, customerId: CUSTOMER, sessionToken: CSESSION, mail: async (_tx, token) => { raw = token; } });
    expect(req.ok && req.sent).toBe(true);
    if (!req.ok) return;
    expect((await shopMailboxConfirm({ rp, storeId: STORE, customerId: CUSTOMER, sessionToken: CSESSION, token: raw, nonce: 'other-browser' })).ok).toBe(false);
    const g = await shopMailboxConfirm({ rp, storeId: STORE, customerId: CUSTOMER, sessionToken: CSESSION, token: raw, nonce: req.nonce });
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    const o = await shopRegisterOptions({ rp, storeId: STORE, customerId: CUSTOMER, sessionToken: CSESSION, grant: g.grant, nonce: g.grantNonce });
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    const auth = authenticator();
    expect((await shopRegisterVerify({ rp, storeId: STORE, customerId: CUSTOMER, sessionToken: CSESSION, response: auth.register({ challenge: o.options.challenge }), nonce: o.nonce, label: 'key' })).ok).toBe(true);
    // Now ineligible (a passkey exists): a second request mints nothing and the identical answer says sent:false.
    const again = await shopMailboxRequest({ storeId: STORE, customerId: CUSTOMER, sessionToken: CSESSION, mail: async () => { throw new Error('must not mail'); } });
    expect(again.ok && again.sent).toBe(false);
    // Last-credential guard: passwordless, no provider, magic link off → the only passkey cannot be removed.
    const m = await shopManageOptions({ rp, storeId: STORE, customerId: CUSTOMER, sessionToken: CSESSION });
    if (!m.ok) throw new Error('manage options');
    const mv = await shopManageVerify({ rp, storeId: STORE, customerId: CUSTOMER, sessionToken: CSESSION, response: auth.authenticate({ challenge: m.options.challenge, counter: 1, userHandle: customerUserHandle(STORE, CUSTOMER) }), nonce: m.nonce });
    if (!mv.ok) throw new Error('manage verify');
    const [only] = await listCustomerPasskeys(STORE, CUSTOMER);
    expect((await shopDeletePasskey({ rp, storeId: STORE, storeConfig: {}, customerId: CUSTOMER, sessionToken: CSESSION, id: only!.id, grant: mv.grant, nonce: mv.grantNonce }))).toMatchObject({ ok: false, code: 'NO_RECOVERY_PATH' });
  });
  it('cross-store credentials are invisible: a foreign store sees no credential for the same id', async () => {
    const { auth } = await enrolCustomer();
    const foreign = randomBytes(8).toString('hex');
    await pool.query("INSERT INTO store(id,slug,name,currency,config) VALUES($1,$2,'Foreign','USD','{}')", ['dd0d0d0d-0000-4000-8000-00000000000f', 'passkey-foreign-' + foreign]);
    try {
      const o = await shopLoginOptions({ rp, storeId: 'dd0d0d0d-0000-4000-8000-00000000000f' });
      const r = await shopLoginVerify({ rp, storeId: 'dd0d0d0d-0000-4000-8000-00000000000f', storeConfig: {}, response: auth.authenticate({ challenge: o.options.challenge, counter: 1, userHandle: customerUserHandle(STORE, CUSTOMER) }), nonce: o.nonce, ip: IP });
      expect(r.ok).toBe(false);
    } finally {
      await withStore('dd0d0d0d-0000-4000-8000-00000000000f', (tx) => tx.execute("DELETE FROM customer_passkey_challenge WHERE store_id='dd0d0d0d-0000-4000-8000-00000000000f'"));
      await pool.query('DELETE FROM store WHERE id=$1', ['dd0d0d0d-0000-4000-8000-00000000000f']);
    }
  });
});
