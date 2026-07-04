import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// SEC-5: error exposure is gated on env.DEBUG_ERRORS, not NODE_ENV, so a
// staging box booted without NODE_ENV=production still sanitizes error
// bodies by default. `env` is a module-level singleton parsed once from
// process.env at import time, so tests mock the module directly rather than
// mutating process.env (which the frozen singleton would never re-read).
vi.mock('./env.js', () => ({ env: { DEBUG_ERRORS: '0' } }));

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  vi.restoreAllMocks();
});

async function bootAppWithBoom() {
  const { createApp } = await import('./app.js');
  const app = createApp();
  app.get('/boom', () => {
    throw new Error('database password leaked in stack');
  });
  return app;
}

describe('app error handling', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('does not expose internal error messages when DEBUG_ERRORS is off, even in production', async () => {
    process.env.NODE_ENV = 'production';
    vi.doMock('./env.js', () => ({ env: { DEBUG_ERRORS: '0' } }));
    const app = await bootAppWithBoom();

    const res = await app.request('/boom');
    const body = await res.json() as { error: string };

    expect(res.status).toBe(500);
    expect(body.error).toBe('internal error');
  });

  it('does not expose internal error messages when NODE_ENV is unset (staging footgun)', async () => {
    delete process.env.NODE_ENV;
    vi.doMock('./env.js', () => ({ env: { DEBUG_ERRORS: '0' } }));
    const app = await bootAppWithBoom();

    const res = await app.request('/boom');
    const body = await res.json() as { error: string };

    expect(res.status).toBe(500);
    expect(body.error).toBe('internal error');
  });

  it('exposes the real error message only when DEBUG_ERRORS=1 is explicitly set', async () => {
    process.env.NODE_ENV = 'development';
    vi.doMock('./env.js', () => ({ env: { DEBUG_ERRORS: '1' } }));
    const app = await bootAppWithBoom();

    const res = await app.request('/boom');
    const body = await res.json() as { error: string };

    expect(res.status).toBe(500);
    expect(body.error).toBe('database password leaked in stack');
  });
});
