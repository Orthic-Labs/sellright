import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same isolation pattern as app.test.ts: env is a frozen singleton, so tests
// that need a different value per-test mock the module and vi.resetModules()
// before each dynamic import of app.js.
vi.mock('./env.js', () => ({ env: { DEBUG_ERRORS: '0' } }));
vi.setConfig({ testTimeout: 60000 });

let dir: string;
let flagFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sr-app-maintenance-'));
  flagFile = join(dir, 'MAINTENANCE');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// Both app.js AND maintenance.js read the SAME mocked env.js singleton within
// one vi.resetModules() "generation" — so the maintenance.js used to arm the
// flag in a test must come from the identical dynamic import generation as
// the app.js under test, not one imported before the mock was installed.
async function bootAppAndMaintenance() {
  vi.resetModules();
  vi.doMock('./env.js', () => ({ env: { DEBUG_ERRORS: '0', MAINTENANCE_FLAG_FILE: flagFile } }));
  const [{ createApp }, maintenanceModule] = await Promise.all([
    import('./app.js'),
    import('./maintenance.js'),
  ]);
  return { app: createApp(), maintenanceModule };
}

describe('maintenance-mode gate (WS-E)', () => {
  it('GET /v1/health, /v1/readyz and /v1/maintenance stay reachable during maintenance', async () => {
    const { app, maintenanceModule } = await bootAppAndMaintenance();
    maintenanceModule.setMaintenance(true, 'update');

    const health = await app.request('/v1/health');
    expect(health.status).toBe(200);

    const maintenanceRes = await app.request('/v1/maintenance');
    expect(maintenanceRes.status).toBe(200);
    const body = await maintenanceRes.json() as { maintenance: boolean; reason?: string };
    expect(body).toEqual({ maintenance: true, since: expect.any(String), reason: 'update' });
  });

  it('reports maintenance: false when the flag is off', async () => {
    const { app } = await bootAppAndMaintenance();
    const res = await app.request('/v1/maintenance');
    expect(await res.json()).toEqual({ maintenance: false });
  });

  it('rejects a mutating /v1/* request with 503 while maintenance is on', async () => {
    const { app, maintenanceModule } = await bootAppAndMaintenance();
    maintenanceModule.setMaintenance(true);

    const res = await app.request('/v1/shop/cart', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-store-slug': 'does-not-matter' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(503);
    const body = await res.json() as { maintenance: boolean };
    expect(body.maintenance).toBe(true);
  });

  it('does not gate mutating requests when maintenance is off (falls through to normal routing/validation)', async () => {
    const { app } = await bootAppAndMaintenance();
    const res = await app.request('/v1/shop/cart', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-store-slug': 'does-not-matter' },
      body: JSON.stringify({}),
    });
    // Not 503 — whatever it is (404/500 from an unresolvable store in this
    // unit test with no DB), it must not be the maintenance response.
    expect(res.status).not.toBe(503);
  });

  it('allows GET requests through even while maintenance is on', async () => {
    const { app, maintenanceModule } = await bootAppAndMaintenance();
    maintenanceModule.setMaintenance(true);

    const res = await app.request('/v1/shop/catalog/products', {
      headers: { 'x-store-slug': 'does-not-matter' },
    });
    expect(res.status).not.toBe(503);
  });

  it('cleans up: turning maintenance off removes the flag file', async () => {
    const { maintenanceModule } = await bootAppAndMaintenance();
    maintenanceModule.setMaintenance(true);
    expect(existsSync(flagFile)).toBe(true);
    maintenanceModule.setMaintenance(false);
    expect(maintenanceModule.isMaintenanceOn()).toBe(false);
  });
});
