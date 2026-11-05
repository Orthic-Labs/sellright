import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { toggle, flag } = vi.hoisted(() => ({ toggle: vi.fn(async (_on: boolean, _opts: unknown) => 'purged'), flag: { on: false } }));
vi.mock('../maintenance-toggle.js', () => ({ toggleMaintenance: (on: boolean, opts: unknown) => { flag.on = on; return toggle(on, opts); } }));
vi.mock('../maintenance.js', () => ({ isMaintenanceOn: () => flag.on, maintenanceInfo: () => ({ maintenance: flag.on }) }));

const argv = process.argv;
beforeEach(() => { vi.resetModules(); toggle.mockClear(); vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { process.argv = argv; process.exitCode = undefined; vi.restoreAllMocks(); });

async function run(...args: string[]) {
  process.argv = ['node', 'maintenance-cli.js', ...args];
  await import('./maintenance-cli.js');
  await vi.waitFor(() => expect(process.exitCode).toBeDefined());
}

describe('maintenance CLI (ADR-0001 QS-6)', () => {
  it('on: toggles through toggleMaintenance (flag + host purge) with the reason', async () => {
    await run('on', 'deploy');
    expect(toggle).toHaveBeenCalledExactlyOnceWith(true, { reason: 'deploy' });
    expect(process.exitCode).toBe(0);
    expect(console.log).toHaveBeenCalledWith('maintenance: edge purge purged');
  });

  it('off: toggles through toggleMaintenance', async () => {
    await run('off');
    expect(toggle).toHaveBeenCalledExactlyOnceWith(false, { reason: undefined });
    expect(process.exitCode).toBe(0);
  });

  it('status never toggles or purges', async () => {
    process.argv = ['node', 'maintenance-cli.js', 'status'];
    await import('./maintenance-cli.js');
    await vi.waitFor(() => expect(console.log).toHaveBeenCalled());
    expect(toggle).not.toHaveBeenCalled();
  });
});
