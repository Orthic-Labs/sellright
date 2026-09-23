import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// extendEnv() closes over the module's own resolved env source, captured at
// import time — so each test resets modules and sets process.env BEFORE
// dynamically importing env.js, the same pattern env.test.ts already uses
// elsewhere in this package for env-source-dependent behavior.
const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe('extendEnv', () => {
  it('merges a typed extra shape parsed from the same resolved source as the base env', async () => {
    process.env.MY_EXTRA_FLAG = 'true';
    const { extendEnv, env } = await import('./env.js');
    const merged = extendEnv({ MY_EXTRA_FLAG: z.enum(['true', 'false']).default('false') });
    expect(merged.MY_EXTRA_FLAG).toBe('true');
    // Base SellRight fields are still present, untouched.
    expect(merged.NODE_ENV).toBe(env.NODE_ENV);
    expect(merged.DEV_DEFAULT_STORE_SLUG).toBe(env.DEV_DEFAULT_STORE_SLUG);
  });

  it('applies the extra shape default when the var is unset', async () => {
    const { extendEnv } = await import('./env.js');
    const merged = extendEnv({ MY_OTHER_FLAG: z.string().default('fallback') });
    expect(merged.MY_OTHER_FLAG).toBe('fallback');
  });

  it('does not mutate or re-run this file\'s own transform (base env unaffected)', async () => {
    const { extendEnv, env: envBefore } = await import('./env.js');
    extendEnv({ ANY_EXTRA: z.string().default('x') });
    const { env: envAfter } = await import('./env.js');
    expect(envAfter).toBe(envBefore); // same singleton — extendEnv never re-parses the base schema
  });

  it('runs the optional validator against the merged object and throws on returned errors', async () => {
    const { extendEnv } = await import('./env.js');
    expect(() =>
      extendEnv({ MY_FLAG: z.string().default('x') }, () => ['boom is not allowed']),
    ).toThrow(/boom is not allowed/);
  });

  it('does not throw when the validator returns no errors', async () => {
    const { extendEnv } = await import('./env.js');
    expect(() => extendEnv({ MY_FLAG: z.string().default('x') }, () => [])).not.toThrow();
  });
});
