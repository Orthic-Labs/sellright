import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  vi.restoreAllMocks();
});

describe('app error handling', () => {
  it('does not expose internal error messages in production', async () => {
    process.env.NODE_ENV = 'production';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createApp();
    app.get('/boom', () => {
      throw new Error('database password leaked in stack');
    });

    const res = await app.request('/boom');
    const body = await res.json() as { error: string };

    expect(res.status).toBe(500);
    expect(body.error).toBe('internal error');
  });
});
