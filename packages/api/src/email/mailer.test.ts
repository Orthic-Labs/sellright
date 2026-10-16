import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Tx } from '../db/client.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
  vi.clearAllMocks();
  vi.doUnmock('nodemailer');
  vi.doUnmock('../db/client.js');
  vi.doUnmock('../security/settings-resolver.js');
});

describe('sendEmail SMTP configuration', () => {
  it('uses Vendure-style Gmail env aliases when generic SMTP env is absent', async () => {
    const sendMail = vi.fn().mockResolvedValue(undefined);
    const createTransport = vi.fn(() => ({ sendMail }));

    vi.doMock('nodemailer', () => ({
      default: { createTransport },
    }));

    // SMTP alias resolution is independent of production boot validation. Run
    // this as a unit test so production DATABASE_URL/STOREFRONT_URL invariants
    // remain covered only by env-runtime tests that intentionally exercise them.
    process.env = {
      NODE_ENV: 'test',
      SMTP_HOST: '',
      SMTP_USER: '',
      SMTP_PASS: '',
      SMTP_FROM: '',
      GMAIL_USER: 'store@example.com',
      EMAIL_PASS: 'gmail-app-password',
      FROM_EMAIL: 'orders@example.com',
    };

    const { sendEmail } = await import('./mailer.js');

    await sendEmail({
      to: 'buyer@example.com',
      subject: 'Receipt',
      html: '<p>Receipt</p>',
      text: 'Receipt',
    });

    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: {
        user: 'store@example.com',
        pass: 'gmail-app-password',
      },
    });
    expect(sendMail).toHaveBeenCalledWith({
      to: 'buyer@example.com',
      subject: 'Receipt',
      html: '<p>Receipt</p>',
      text: 'Receipt',
      from: 'orders@example.com',
    });
  });
});

describe('sendEmail sender fallback', () => {
  // Regression: the spread was `{ from, ...input }`, so a caller passing
  // `from: undefined` (key present) blanked the resolved sender. The resolved
  // `from` must win over the caller's key.
  it('uses the resolved SMTP_FROM when the caller passes from: undefined', async () => {
    const sendMail = vi.fn().mockResolvedValue(undefined);
    const createTransport = vi.fn(() => ({ sendMail }));
    vi.doMock('nodemailer', () => ({ default: { createTransport } }));

    process.env = {
      NODE_ENV: 'test',
      SMTP_HOST: 'smtp.example.test',
      SMTP_USER: 'mailer@example.test',
      SMTP_PASS: 'not-a-real-secret',
      SMTP_FROM: 'fallback@example.test',
    };

    const { sendEmail } = await import('./mailer.js');

    await sendEmail({ to: 'buyer@example.com', subject: 'Receipt', html: '<p>R</p>', text: 'R', from: undefined });

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0]![0]).toMatchObject({ from: 'fallback@example.test' });
  });

  it('keeps an explicit caller sender', async () => {
    const sendMail = vi.fn().mockResolvedValue(undefined);
    vi.doMock('nodemailer', () => ({ default: { createTransport: vi.fn(() => ({ sendMail })) } }));

    process.env = {
      NODE_ENV: 'test',
      SMTP_HOST: 'smtp.example.test',
      SMTP_USER: 'mailer@example.test',
      SMTP_PASS: 'not-a-real-secret',
      SMTP_FROM: 'fallback@example.test',
    };

    const { sendEmail } = await import('./mailer.js');
    await sendEmail({ to: 'buyer@example.com', subject: 'Receipt', html: '<p>R</p>', text: 'R', from: 'orders@example.test' });

    expect(sendMail.mock.calls[0]![0]).toMatchObject({ from: 'orders@example.test' });
  });
});


describe('sendEmail explicit SMTP disable', () => {
  const message = { to: 'buyer@example.test', subject: 'Receipt', html: '<p>R</p>', text: 'R' };

  async function savedStoreMailer(smtpEnabled?: 'true' | 'false', host?: string) {
    process.env = { NODE_ENV: 'test', SMTP_ENABLED: smtpEnabled, SMTP_HOST: host };
    const sendMail = vi.fn().mockResolvedValue(undefined);
    const createTransport = vi.fn(() => ({ sendMail }));
    const select = vi.fn();
    const chain = {
      select,
      from: () => chain,
      where: () => chain,
      limit: async () => [{ config: { email: { smtp: {
        preset: 'custom', host: 'smtp.store.test', port: 587, secure: false,
        user: 'store@example.test', from: 'store@example.test',
      } } } }],
    };
    select.mockReturnValue(chain);
    const withStore = vi.fn(async (_storeId: string, fn: (tx: Tx) => Promise<unknown>) => fn(chain as unknown as Tx));
    const resolveField = vi.fn().mockResolvedValue({ value: 'synthetic-smtp-password', source: 'db' });
    vi.doMock('nodemailer', () => ({ default: { createTransport } }));
    vi.doMock('../db/client.js', () => ({ withStore }));
    vi.doMock('../security/settings-resolver.js', () => ({ resolveField }));
    const { sendEmail } = await import('./mailer.js');
    const { env } = await import('../env.js');
    return { sendEmail, env, sendMail, createTransport, withStore, select, resolveField };
  }

  it('does not look up saved store SMTP or create/send a transport when explicitly disabled', async () => {
    const mailer = await savedStoreMailer('false', 'smtp.global.test');
    expect(await mailer.sendEmail(message, 'fresh-store')).toEqual({ delivered: false, reason: 'smtp_not_configured' });
    expect(mailer.withStore).not.toHaveBeenCalled();
    expect(mailer.select).not.toHaveBeenCalled();
    expect(mailer.resolveField).not.toHaveBeenCalled();
    expect(mailer.createTransport).not.toHaveBeenCalled();
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('does not reuse an already cached store transport after explicit disable', async () => {
    const mailer = await savedStoreMailer();
    expect(await mailer.sendEmail(message, 'cached-store')).toEqual({ delivered: true });
    expect(mailer.withStore).toHaveBeenCalledTimes(1);
    expect(mailer.createTransport).toHaveBeenCalledTimes(1);
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    mailer.env.SMTP_ENABLED = 'false';
    vi.clearAllMocks();
    expect(await mailer.sendEmail(message, 'cached-store')).toEqual({ delivered: false, reason: 'smtp_not_configured' });
    expect(mailer.withStore).not.toHaveBeenCalled();
    expect(mailer.resolveField).not.toHaveBeenCalled();
    expect(mailer.createTransport).not.toHaveBeenCalled();
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('does not reuse an already cached global transport after explicit disable', async () => {
    const mailer = await savedStoreMailer('true', 'smtp.global.test');
    expect(await mailer.sendEmail(message, 'store')).toEqual({ delivered: true });
    mailer.env.SMTP_ENABLED = 'false';
    vi.clearAllMocks();
    expect(await mailer.sendEmail(message, 'store')).toEqual({ delivered: false, reason: 'smtp_not_configured' });
    expect(mailer.withStore).not.toHaveBeenCalled();
    expect(mailer.createTransport).not.toHaveBeenCalled();
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('keeps saved store SMTP fallback and sender selection when SMTP_ENABLED is unset', async () => {
    const mailer = await savedStoreMailer();
    expect(await mailer.sendEmail(message, 'store')).toEqual({ delivered: true });
    expect(mailer.withStore).toHaveBeenCalledTimes(1);
    expect(mailer.resolveField).toHaveBeenCalledTimes(1);
    expect(mailer.createTransport).toHaveBeenCalledWith({
      host: 'smtp.store.test', port: 587, secure: false,
      auth: { user: 'store@example.test', pass: 'synthetic-smtp-password' },
    });
    expect(mailer.sendMail).toHaveBeenCalledWith({ ...message, from: 'store@example.test' });
  });
});
