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

    // This is an email-routing unit test, not a production-environment boot
    // test. Keep NODE_ENV=test so the independent production invariant checks
    // do not require a real-looking database/deployment URL fixture here.
    process.env = {
      NODE_ENV: 'test',
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

describe('per-store resolution precedence (SR-05)', () => {
  it('store.config wins over global env when no appKey applies', async () => {
    process.env = {
      NODE_ENV: 'test',
      SMTP_FROM: 'global@env.test',
      STOREFRONT_URL: 'https://global-env.test',
    };
    const { resolveFromEmail, resolveStorefrontUrl } = await import('./dispatch.js');
    const store = { name: 'Brand B', currency: 'EUR', config: { storefrontUrl: 'https://b-brand.example', emailFrom: 'orders@b-brand.example' } };
    expect(resolveStorefrontUrl(store)).toBe('https://b-brand.example');
    expect(resolveFromEmail(store)).toBe('orders@b-brand.example');
  });

  it('per-app env override still beats store.config (shared-store routing kept)', async () => {
    process.env = {
      NODE_ENV: 'test',
      SMTP_FROM: 'global@env.test',
      STOREFRONT_URL: 'https://global-env.test',
      EMAIL_FROM_BY_APP: 'viewright=hello@viewright.cc',
      STOREFRONT_URL_BY_APP: 'viewright=https://viewright.cc',
    };
    const { resolveFromEmail, resolveStorefrontUrl } = await import('./dispatch.js');
    const store = { name: 'Shared', currency: 'USD', appKey: 'viewright', config: { storefrontUrl: 'https://shared-store.example', emailFrom: 'hi@shared-store.example' } };
    expect(resolveStorefrontUrl(store)).toBe('https://viewright.cc');
    expect(resolveFromEmail(store)).toBe('hello@viewright.cc');
  });

  it('falls back to env only when config carries no storefront identity', async () => {
    process.env = {
      NODE_ENV: 'test',
      SMTP_FROM: 'global@env.test',
      STOREFRONT_URL: 'https://global-env.test',
    };
    const { resolveFromEmail, resolveStorefrontUrl } = await import('./dispatch.js');
    const store = { name: 'NoCfg', currency: 'USD', config: null };
    expect(resolveStorefrontUrl(store)).toBe('https://global-env.test');
    expect(resolveFromEmail(store)).toBe('global@env.test');
  });

  it('ignores a malformed config storefrontUrl rather than shipping it in a link', async () => {
    process.env = {
      NODE_ENV: 'test',
      SMTP_FROM: 'global@env.test',
      STOREFRONT_URL: 'https://global-env.test',
    };
    const { resolveStorefrontUrl } = await import('./dispatch.js');
    expect(resolveStorefrontUrl({ name: 'X', currency: 'USD', config: { storefrontUrl: 'javascript:alert(1)' } })).toBe('https://global-env.test');
    expect(resolveStorefrontUrl({ name: 'X', currency: 'USD', config: { storefrontUrl: 'not a url' } })).toBe('https://global-env.test');
    // trailing slash is normalized so link paths don't get `//`
    expect(resolveStorefrontUrl({ name: 'X', currency: 'USD', config: { storefrontUrl: 'https://shop.example/' } })).toBe('https://shop.example');
  });
});
