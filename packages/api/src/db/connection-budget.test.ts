import { describe, expect, it } from 'vitest';
import { connectionBudget } from './client.js';
import type { Env } from '../env.js';

// #360 N7: the per-process maximum counts every pool plus the tenant resolver, the webhook pass and the listener.
const env = (requests: number) => ({ PGPOOL_MAX: requests, PGJOBS_POOL_MAX: 4, PGLOCKS_POOL_MAX: 4 }) as Env;

describe('connectionBudget', () => {
  it('is 26 per process at the default request pool of 10', () => {
    const b = connectionBudget(env(10));
    expect(b.total).toBe(26);
    expect(b.parts).toEqual({ requests: 10, jobs: 4, locks: 4, advisory: 3, tenantResolution: 2, webhookPass: 2, listener: 1 });
  });

  it('is 37 at a request pool of 20 (the advisory pool caps at 4)', () => {
    expect(connectionBudget(env(20)).total).toBe(37);
  });
});
