import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
  vi.clearAllMocks();
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
