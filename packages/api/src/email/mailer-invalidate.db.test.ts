/**
 * P0 review: staff invites are e-mail-only, so "configure e-mail, then retry the invite" must work in the SAME
 * process. The per-store transporter cache used to remember "not configured" forever (until restart).
 * sellright_test only (TRUNCATEs).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../db/client.js';
import { env } from '../env.js';
import { invalidateStoreTransport, sendEmail } from './mailer.js';

const isTestDb = /^\/[^/]*_test$/.test(new URL(process.env.DATABASE_URL ?? env.DATABASE_URL).pathname);
const STORE = 'eaeaeaea-eaea-eaea-eaea-eaeaeaeaea01';

beforeEach(async () => {
  if (!isTestDb) return;
  await pool.query('TRUNCATE store CASCADE');
  await pool.query(`INSERT INTO store (id, slug, name, currency) VALUES ($1, 'mailer-inv', 'M', 'USD')`, [STORE]);
});
afterAll(async () => { if (isTestDb) await pool.query('TRUNCATE store CASCADE'); await pool.end(); });

describe.skipIf(!isTestDb || !!env.SMTP_HOST)('per-store transporter cache', () => {
  it('"not configured" is not cached: configuring SMTP is picked up by the next send without a restart', async () => {
    const msg = { to: 'x@example.net', subject: 's', html: '<p>h</p>', text: 't', from: 'noreply@example.net' };
    expect(await sendEmail(msg, STORE)).toEqual({ delivered: false, reason: 'smtp_not_configured' });
    // Port 9 on loopback refuses the connection: a real transport attempt, not the no-op path.
    await pool.query(`UPDATE store SET config = '{"email":{"smtp":{"preset":"custom","host":"127.0.0.1","port":9,"secure":false}}}'::jsonb WHERE id = $1`, [STORE]);
    const second = await sendEmail(msg, STORE);
    expect(second.delivered).toBe(false);
    expect(second.reason).not.toBe('smtp_not_configured');
  });

  it('a settings save invalidates a cached transporter', async () => {
    await pool.query(`UPDATE store SET config = '{"email":{"smtp":{"preset":"custom","host":"127.0.0.1","port":9,"secure":false}}}'::jsonb WHERE id = $1`, [STORE]);
    const msg = { to: 'x@example.net', subject: 's', html: '<p>h</p>', text: 't', from: 'noreply@example.net' };
    expect((await sendEmail(msg, STORE)).reason).not.toBe('smtp_not_configured');
    await pool.query(`UPDATE store SET config = '{}'::jsonb WHERE id = $1`, [STORE]);
    invalidateStoreTransport(STORE);
    expect(await sendEmail(msg, STORE)).toEqual({ delivered: false, reason: 'smtp_not_configured' });
  });
});
