import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
  vi.clearAllMocks();
});

describe('email dispatch app routing', () => {
  it('picks one app key for single-app order lines and falls back for mixed carts', async () => {
    process.env = { NODE_ENV: 'test' };

    const { pickEmailAppKey } = await import('./dispatch.js');

    expect(pickEmailAppKey(['viewright', 'viewright', null])).toBe('viewright');
    expect(pickEmailAppKey(['viewright', 'heardright'])).toBeNull();
    expect(pickEmailAppKey([null, undefined])).toBeNull();
  });

  it('uses app-specific sender and storefront URL for order confirmations', async () => {
    const sendEmail = vi.fn().mockResolvedValue({ delivered: true });
    vi.doMock('./mailer.js', () => ({ sendEmail }));

    process.env = {
      NODE_ENV: 'production',
      SMTP_FROM: 'hello@rightapps.test',
      STOREFRONT_URL: 'https://store.example.com',
      EMAIL_FROM_BY_APP: [
        'heardright=hello@heardright.app',
        'viewright=hello@viewright.cc',
        'mailright=hello@mailright.cc',
      ].join(','),
      STOREFRONT_URL_BY_APP: [
        'heardright=https://heardright.app',
        'viewright=https://viewright.cc',
        'mailright=https://mailright.cc',
      ].join(','),
    };

    const { sendOrderConfirmation } = await import('./dispatch.js');

    await sendOrderConfirmation(
      { name: 'RightApps', currency: 'USD', appKey: 'viewright' },
      'buyer@example.com',
      {
        code: 'SR-VR-1',
        grandTotal: 2900,
        currency: 'USD',
        lines: [{ name: 'ViewRight Personal', quantity: 1, lineTotal: 2900 }],
      },
    );

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'buyer@example.com',
      from: 'hello@viewright.cc',
    }));
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      html: expect.stringContaining('https://viewright.cc/orders/SR-VR-1'),
      text: expect.stringContaining('https://viewright.cc/orders/SR-VR-1'),
    }));
  });
});
