/**
 * One admission path for every background pass (#358 / #360 N3, N4, N5): scheduled ticks, the startup catalog
 * publication and stock-triggered manifest regeneration all run through `jobAdmission().run()`, which
 *   - holds one of JOBS_CONCURRENCY slots for the WHOLE pass, so actual active work never exceeds the cap;
 *   - runs the pass inside runInJobScope(), so its SQL uses the jobs pool, never the request pool;
 *   - raises an alarm when a pass outlives JOBS_PASS_DEADLINE_MS (and again every deadline after). The slot is NOT
 *     given back: the pass cannot be cancelled from outside, and freeing its slot would admit work beyond the cap.
 *     Passes that observe currentLeaseSignal() can stop themselves; the rest are reported until they settle.
 */
import { runInJobScope } from '../db/client.js';
import { env } from '../env.js';
import { err as logErr } from '../lib/logger.js';

/** Counting semaphore. FIFO, so a pass waits its turn behind earlier ones. */
export class Semaphore {
  private free: number;
  private readonly waiters: Array<() => void> = [];
  constructor(size: number) { this.free = Math.max(1, size); }
  async acquire(): Promise<() => void> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.free++;
    };
  }
}

export interface Admission {
  /** Run `fn` as one admitted pass; resolves/rejects with it. */
  run<T>(label: string, fn: () => Promise<T>): Promise<T>;
  /** Passes currently holding a slot. */
  readonly active: number;
  /** Admitted passes past their deadline (still holding their slots). */
  readonly overdue: number;
}

export function createAdmission(opts: { concurrency: number; deadlineMs: number; onOverdue?: (label: string, elapsedMs: number) => void }): Admission {
  const slots = new Semaphore(opts.concurrency);
  let active = 0;
  let overdue = 0;
  const alarm = opts.onOverdue ?? ((label: string, elapsedMs: number) =>
    logErr.error('job pass past its deadline; it keeps its slot until it settles', undefined, { job: label, elapsedMs, deadlineMs: opts.deadlineMs }));
  return {
    get active() { return active; },
    get overdue() { return overdue; },
    async run<T>(label: string, fn: () => Promise<T>): Promise<T> {
      const release = await slots.acquire();
      active++;
      const started = Date.now();
      let late = false;
      const timer = setInterval(() => {
        if (!late) { late = true; overdue++; }
        alarm(label, Date.now() - started);
      }, opts.deadlineMs);
      timer.unref?.();
      try {
        return await runInJobScope(fn);
      } finally {
        clearInterval(timer);
        if (late) overdue--;
        active--;
        release();
      }
    },
  };
}

let shared: Admission | undefined;

/** The process-wide admission (created on first use from JOBS_CONCURRENCY / JOBS_PASS_DEADLINE_MS). */
export function jobAdmission(): Admission {
  shared ??= createAdmission({ concurrency: env.JOBS_CONCURRENCY ?? 2, deadlineMs: env.JOBS_PASS_DEADLINE_MS ?? 10 * 60_000 });
  return shared;
}

/** Test-only: drop the process-wide admission so a suite that left passes hanging starts from free slots. */
export function _resetJobAdmissionForTest(): void {
  shared = undefined;
}
