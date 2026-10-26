import { describe, expect, it } from 'vitest';
import { jobOffsetMs, nextDelayMs } from './scheduler.js';

// #358 / #360: the engine jobs and their intervals, as registered by startJobScheduler().
const MIN = 60_000;
const HOUR = 60 * MIN;
const JOBS: Array<[string, number]> = [
  ['gateway-events', MIN], ['passkey-prune', 10 * MIN], ['gateway-recovery', 5 * MIN], ['catalog-manifest-drain', 2 * MIN],
  ['auto-deliver', HOUR], ['release-stale', 15 * MIN], ['purge-cancelled', 15 * MIN], ['reservation-release-sweep', 15 * MIN], ['cart-maintenance', 15 * MIN],
  ['webhooks', MIN], ['emails', MIN], ['push', MIN], ['listmonk-sync', 5 * MIN], ['sheerid-expiry', HOUR],
  ['birthday-bonus', HOUR], ['restock-notify', MIN], ['webhook-reaper', 5 * MIN], ['processed-event-reaper', HOUR],
  ['rate-limit-reaper', HOUR],
];
// Sub-minute and plugin jobs: offsets and slots must hold for them too.
const OTHER: Array<[string, number]> = [['pending-effects', 15_000], ['acme:sync', 5 * MIN], ['acme:nightly', HOUR]];

describe('job slots', () => {
  it('gives every job a fixed offset inside its interval', () => {
    for (const [label, interval] of [...JOBS, ...OTHER]) {
      const offset = jobOffsetMs(label, interval);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(interval);
      expect(jobOffsetMs(label, interval)).toBe(offset); // stable across calls and restarts
    }
  });

  it('never lines the hourly jobs up on one tick', () => {
    const hourly = JOBS.filter(([, interval]) => interval === HOUR).map(([label]) => jobOffsetMs(label, HOUR));
    expect(new Set(hourly).size).toBe(hourly.length);
  });

  it('spreads every minute-or-longer job across the hour: no second hosts more than two slots', () => {
    const perSecond = new Map<number, number>();
    for (const [label, interval] of JOBS) {
      const offset = jobOffsetMs(label, interval);
      for (let t = offset; t < HOUR; t += interval) perSecond.set(t / 1000, (perSecond.get(t / 1000) ?? 0) + 1);
    }
    expect(Math.max(...perSecond.values())).toBeLessThanOrEqual(2);
  });

  it('schedules the next pass at the slot plus at most 10 % jitter, never right after a pass', () => {
    for (const [label, interval] of [...JOBS, ...OTHER]) {
      for (const now of [0, 1_234_567, 1_790_000_000_000]) {
        const bare = nextDelayMs(label, interval, now, () => 0);
        expect(bare).toBeGreaterThanOrEqual(interval / 10);
        expect(bare).toBeLessThanOrEqual(interval * 1.1);
        expect((now + bare - jobOffsetMs(label, interval)) % interval).toBe(0); // lands on the job's own slot
        const jittered = nextDelayMs(label, interval, now, () => 0.999);
        expect(jittered - bare).toBeLessThan(interval * 0.1);
      }
    }
  });
});
