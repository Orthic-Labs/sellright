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
