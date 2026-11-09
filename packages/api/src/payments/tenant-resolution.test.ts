import { beforeEach, describe, expect, it, vi } from 'vitest';

// DB-M3: the tenant-resolution pool carries a server-side statement_timeout and a client-side query_timeout.
const created: Array<Record<string, unknown>> = [];
vi.mock('pg', () => ({
  Pool: class {
    constructor(opts: Record<string, unknown>) { created.push(opts); }
    on() { return this; }
    query = vi.fn(async () => ({ rows: [{ store_id: '11111111-1111-4111-8111-111111111111' }] }));
    end = vi.fn(async () => undefined);
    connect = vi.fn(async () => undefined);
  },
}));

describe('tenant-resolution pool (DB-M3)', () => {
  beforeEach(() => { created.length = 0; vi.resetModules(); });

  it('opens its lazy pool with statement_timeout=3000 and a query_timeout just above it', async () => {
    const mod = await import('./tenant-resolution.js');
    const r = await mod.resolveStoreForGatewayEvent('stripe', { paymentRef: 'pi_1' });
    expect(r).toEqual({ storeId: '11111111-1111-4111-8111-111111111111' });
    expect(created).toHaveLength(1);
    expect(created[0]!.options).toBe('-c statement_timeout=3000');
    expect(created[0]!.query_timeout).toBe(mod.TENANT_RESOLUTION_QUERY_TIMEOUT_MS);
    expect(mod.TENANT_RESOLUTION_QUERY_TIMEOUT_MS).toBeGreaterThan(mod.TENANT_RESOLUTION_STATEMENT_TIMEOUT_MS);
  });
});
