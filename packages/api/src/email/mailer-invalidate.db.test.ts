/**
 * P0 review: staff invites are e-mail-only, so "configure e-mail, then retry the invite" must work in the SAME
 * process. The per-store transporter cache used to remember "not configured" forever (until restart).
 * sellright_test only (TRUNCATEs).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../db/client.js';
import { env } from '../env.js';
import { createServer, type AddressInfo } from 'node:net';
import { invalidateStoreTransport, sendEmail } from './mailer.js';

/** Minimal SMTP sink recording the envelope sender of each message. */
async function smtpSink(): Promise<{ port: number; senders: string[]; close: () => void }> {
  const senders: string[] = [];
  const server = createServer((sock) => {
    let buf = ''; let data = false;
    sock.write('220 sink\r\n');
    sock.on('data', (d) => {
      buf += d.toString();
      for (;;) {
        if (data) { const e = buf.indexOf('\r\n.\r\n'); if (e < 0) return; buf = buf.slice(e + 5); data = false; sock.write('250 ok\r\n'); continue; }
        const i = buf.indexOf('\r\n'); if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'MAIL') { senders.push(/<([^>]*)>/.exec(line)?.[1] ?? ''); sock.write('250 ok\r\n'); }
        else if (cmd === 'DATA') { data = true; sock.write('354 go\r\n'); }
        else if (cmd === 'QUIT') { sock.end('221 bye\r\n'); return; }
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, senders, close: () => server.close() };
}

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

  it('a store\'s own SMTP account sends as its saved sender when the caller only has the install default', async () => {
    const sink = await smtpSink();
    try {
      await pool.query(`UPDATE store SET config = $2::jsonb WHERE id = $1`, [STORE, JSON.stringify({ email: { smtp: { preset: 'custom', host: '127.0.0.1', port: sink.port, secure: false, from: 'shop@store.example' } } })]);
      invalidateStoreTransport(STORE);
      const r = await sendEmail({ to: 'x@example.net', subject: 's', html: '<p>h</p>', text: 't', from: env.SMTP_FROM }, STORE);
      expect(r).toEqual({ delivered: true });
      expect(sink.senders).toEqual(['shop@store.example']);
      // an explicit, store-specific sender chosen by the caller still wins
      await sendEmail({ to: 'x@example.net', subject: 's', html: '<p>h</p>', text: 't', from: 'orders@store.example' }, STORE);
      expect(sink.senders[1]).toBe('orders@store.example');
    } finally { sink.close(); }
  });
});
