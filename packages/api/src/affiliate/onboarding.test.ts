/**
 * Affiliate automation tests (DB-gated). Promotion-bound onboarding,
 * same-email no-op, recipient-change rotation + welcome/rotation mail enqueue.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { reassignAffiliate, syncPromotionAffiliate } from './onboarding.js';
import { pool, withStore } from '../db/client.js';
import { env } from '../env.js';

const DB = process.env.DATABASE_URL ?? env.DATABASE_URL;
const isTestDb = /_test(\b|$|\?)/.test(DB);
const STORE = '77777777-7777-7777-7777-777777777777';

async function wipe() { await pool.query('TRUNCATE store CASCADE'); }

async function seed(affiliateEmail: string | null): Promise<string> {
  await pool.query(`INSERT INTO store (id, slug, name, currency, config) VALUES ($1, 'aff-test', 'Aff Test', 'USD', '{}'::jsonb)`, [STORE]);
  const r = await withStore(STORE, (tx) => tx.execute(sql`
    INSERT INTO promotion (id, store_id, code, type, value, enabled, affiliate_email)
    VALUES (gen_random_uuid(), ${STORE}, 'INFLUENCER10', 'percentage', 10, true, ${affiliateEmail}) RETURNING id`));
  return (r.rows[0] as { id: string }).id;
}

const affiliates = () => withStore(STORE, async (tx) => {
  const r = await tx.execute(sql`SELECT id, email, access_token AS token, promotion_id FROM affiliate ORDER BY onboarded_at`);
  return r.rows as Array<{ id: string; email: string; token: string }>;
});
const outbox = () => withStore(STORE, async (tx) => {
  const r = await tx.execute(sql`SELECT kind, recipient, payload FROM email_outbox ORDER BY created_at`);
  return r.rows as Array<{ kind: string; recipient: string; payload: { subject: string; text: string } }>;
});
const setEmail = (promotionId: string, email: string | null) =>
  withStore(STORE, (tx) => tx.execute(sql`UPDATE promotion SET affiliate_email = ${email} WHERE id = ${promotionId}`));

describe.skipIf(!isTestDb)('promotion → affiliate onboarding', () => {
  beforeEach(wipe);
  afterAll(wipe);

  it('a promotion bound to an email onboards the affiliate + enqueues the welcome mail', async () => {
    const pid = await seed('Creator@X.test');
    const res = await withStore(STORE, (tx) => syncPromotionAffiliate(tx, STORE, pid, 'admin@x.test'));
    expect(res.kind).toBe('onboarded');

    const affs = await affiliates();
    expect(affs).toHaveLength(1);
    expect(affs[0]!.email).toBe('creator@x.test'); // lowercased
    expect(affs[0]!.token).toHaveLength(48);

    const mails = await outbox();
    expect(mails).toHaveLength(1);
    expect(mails[0]!.kind).toBe('affiliate_welcome');
    expect(mails[0]!.recipient).toBe('creator@x.test');
    expect(mails[0]!.payload.text).toContain('INFLUENCER10');
    expect(mails[0]!.payload.text).toContain(affs[0]!.token); // access link carries the token
  });

  it('repeated saves with the same email are a no-op (no second mail, no new token)', async () => {
    const pid = await seed('creator@x.test');
    await withStore(STORE, (tx) => syncPromotionAffiliate(tx, STORE, pid, 'admin@x.test'));
    const [a1] = await affiliates();
    const res = await withStore(STORE, (tx) => syncPromotionAffiliate(tx, STORE, pid, 'admin@x.test'));
    expect(res.kind).toBe('noop');
    expect(await affiliates()).toHaveLength(1);
    expect((await affiliates())[0]!.token).toBe(a1!.token);
    expect(await outbox()).toHaveLength(1);
  });

  it('a recipient change rotates the token (old link dies) and mails the new recipient', async () => {
    const pid = await seed('old@x.test');
    await withStore(STORE, (tx) => syncPromotionAffiliate(tx, STORE, pid, 'admin@x.test'));
    const [before] = await affiliates();

    await setEmail(pid, 'New@X.test');
    const res = await withStore(STORE, (tx) => syncPromotionAffiliate(tx, STORE, pid, 'admin@x.test'));
    expect(res.kind).toBe('rotated');

    const [after] = await affiliates();
    expect(after!.id).toBe(before!.id);            // same affiliate row
    expect(after!.email).toBe('new@x.test');
    expect(after!.token).not.toBe(before!.token);  // rotated — old dashboard link is dead

    const mails = await outbox();
    expect(mails).toHaveLength(2);
    const rotation = mails.find((m) => m.kind === 'affiliate_rotation')!;
    expect(rotation.recipient).toBe('new@x.test');
    expect(rotation.payload.text).toContain(after!.token);
  });

  it('an unbound promotion (no affiliate_email) is a no-op', async () => {
    const pid = await seed(null);
    const res = await withStore(STORE, (tx) => syncPromotionAffiliate(tx, STORE, pid, 'admin@x.test'));
    expect(res.kind).toBe('noop');
    expect(await affiliates()).toHaveLength(0);
    expect(await outbox()).toHaveLength(0);
  });

  it('reassignAffiliate (admin PATCH path) rotates + mails; same-email is a no-op', async () => {
    const pid = await seed('first@x.test');
    await withStore(STORE, (tx) => syncPromotionAffiliate(tx, STORE, pid, 'admin@x.test'));
    const [a] = await affiliates();

    const same = await withStore(STORE, (tx) => reassignAffiliate(tx, STORE, a!.id, 'first@x.test', 'admin@x.test'));
    expect(same!.email).toBe('first@x.test');
    expect((await affiliates())[0]!.token).toBe(a!.token);

    const moved = await withStore(STORE, (tx) => reassignAffiliate(tx, STORE, a!.id, 'second@x.test', 'admin@x.test'));
    expect(moved!.code).toBe('INFLUENCER10');
    const [after] = await affiliates();
    expect(after!.email).toBe('second@x.test');
    expect(after!.token).not.toBe(a!.token);
    expect((await outbox()).filter((m) => m.kind === 'affiliate_rotation')).toHaveLength(1);

    const missing = await withStore(STORE, (tx) => reassignAffiliate(tx, STORE, '00000000-0000-0000-0000-000000000000', 'x@y.z', 'admin@x.test'));
    expect(missing).toBeNull();
  });
});
