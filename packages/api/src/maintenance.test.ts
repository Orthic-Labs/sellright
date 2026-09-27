import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let flagFile: string;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sr-maintenance-'));
  // Nested path (not yet created) — exercises setMaintenance's mkdirSync.
  flagFile = join(dir, 'state', 'MAINTENANCE');
  vi.resetModules();
  vi.doMock('./env.js', () => ({ env: { MAINTENANCE_FLAG_FILE: flagFile } }));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('maintenance flag (WS-E)', () => {
  it('is off by default', async () => {
    const { isMaintenanceOn, maintenanceInfo } = await import('./maintenance.js');
    expect(isMaintenanceOn()).toBe(false);
    expect(maintenanceInfo()).toEqual({ maintenance: false });
  });

  it('turning on creates the flag file (including its parent dir) and records since/reason', async () => {
    const { isMaintenanceOn, maintenanceInfo, setMaintenance } = await import('./maintenance.js');
    setMaintenance(true, 'update');
    expect(existsSync(flagFile)).toBe(true);
    expect(isMaintenanceOn()).toBe(true);
    const info = maintenanceInfo();
    expect(info.maintenance).toBe(true);
    expect(info.reason).toBe('update');
    expect(typeof info.since).toBe('string');
  });

  it('turning off removes the flag file', async () => {
    const { isMaintenanceOn, setMaintenance } = await import('./maintenance.js');
    setMaintenance(true);
    expect(isMaintenanceOn()).toBe(true);
    setMaintenance(false);
    expect(isMaintenanceOn()).toBe(false);
  });

  it('turning off when never on is a no-op, not an error', async () => {
    const { isMaintenanceOn, setMaintenance } = await import('./maintenance.js');
    expect(() => setMaintenance(false)).not.toThrow();
    expect(isMaintenanceOn()).toBe(false);
  });

  it('fails closed (maintenance: true) if the flag file exists but is not valid JSON', async () => {
    const { setMaintenance, maintenanceInfo } = await import('./maintenance.js');
    setMaintenance(true);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(flagFile, 'not json');
    expect(maintenanceInfo()).toEqual({ maintenance: true });
  });
});
