import { afterEach, describe, expect, it, vi } from 'vitest';

// #360 re-review item 2: scheduler.stop() has ONE deadline (pm2 kill_timeout is 10 s), and a stopped admission
// stays stopped until the engine's next start resets it.
vi.mock('../env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../env.js')>();
  return { ...actual, env: { ...actual.env, JOBS_ENABLED: '1', NODE_ENV: 'development', CATALOG_MANIFEST_JOBS_ENABLED: '0' } };
});
vi.mock('../maintenance.js', () => ({ isMaintenanceOn: () => false }));
vi.mock('../lib/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, err: { error: vi.fn() } }));
vi.mock('./leader-lock.js', () => ({
  // The first job to start hangs forever; every other job skips before touching data.
  withLeaderLock: (job: string) => (job === 'gateway-events' ? new Promise(() => {}) : Promise.resolve(undefined)),
}));
import { admissionGauges, AdmissionStoppedError, jobAdmission, resetJobAdmission } from './admission.js';
import { startJobScheduler } from './scheduler.js';

afterEach(() => resetJobAdmission());

describe('scheduler.stop', () => {
  it('returns within one shared deadline while a pass hangs, and admission stays stopped', async () => {
    resetJobAdmission();
    const scheduler = startJobScheduler();
    await expect.poll(() => admissionGauges().active).toBe(1); // gateway-events is running (and never ends)
    const started = Date.now();
    await scheduler.stop(300);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(550); // not 2 × 300
    await expect(jobAdmission().run('emails', async () => 'late')).rejects.toBeInstanceOf(AdmissionStoppedError);
    resetJobAdmission();
    expect(await jobAdmission().run('emails', async () => 'fresh')).toBe('fresh');
  });
});
