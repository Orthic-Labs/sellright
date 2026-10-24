/**
 * One admission path for every background pass (#358 / #360 N3, N4, N5, H2): scheduled ticks, the startup catalog
 * publication, stock-triggered manifest publication and the post-commit email wake all run through
 * `jobAdmission().run()`, which
 *   - holds a slot for the WHOLE pass, so actual active work never exceeds the caps;
 *   - keeps two lanes: the money/delivery passes (CRITICAL_JOBS: settlement effects, gateway events, emails,
 *     webhooks) have their own JOBS_CRITICAL_CONCURRENCY slots, so a long catalog publication or Listmonk sync can
 *     never queue a payment settlement or a confirmation e-mail behind it; everything else shares JOBS_CONCURRENCY;
 *   - runs the pass inside runInJobScope(), so its SQL uses the jobs pool, never the request pool;
 *   - raises an alarm when a pass outlives JOBS_PASS_DEADLINE_MS (and again every deadline after) and counts it as
 *     overdue (GET /v1/readyz `jobs.overdue`). The slot is NOT given back: the pass cannot be cancelled from
 *     outside, and freeing its slot would admit work beyond the cap. Passes that observe currentLeaseSignal() stop
 *     themselves when their lease is lost.
 *   - on stop(): refuses new passes, rejects queued ones, and waits (bounded) for the running ones.
 */
import { runInJobScope } from '../db/client.js';
import { env } from '../env.js';
import { err as logErr } from '../lib/logger.js';

/** Passes whose delay is a customer-visible or money-visible delay; they never wait behind other work. */
export const CRITICAL_JOBS: ReadonlySet<string> = new Set(['pending-effects', 'gateway-events', 'emails', 'webhooks']);

export class AdmissionStoppedError extends Error {
  constructor() { super('job admission stopped (engine shutting down)'); }
}

/** Counting semaphore. FIFO, so a pass waits its turn behind earlier ones; queued waiters can be rejected. */
export class Semaphore {
  private free: number;
  private readonly waiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  constructor(size: number) { this.free = Math.max(1, size); }
  async acquire(): Promise<() => void> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next.resolve();
      else this.free++;
    };
  }
  /** Reject every queued waiter (slots already held are unaffected). */
  rejectWaiting(error: Error): void {
    for (const w of this.waiters.splice(0)) w.reject(error);
  }
}

export interface Admission {
  /** Run `fn` as one admitted pass; resolves/rejects with it. */
  run<T>(label: string, fn: () => Promise<T>): Promise<T>;
  /** Passes currently holding a slot. */
  readonly active: number;
  /** Admitted passes past their deadline (still holding their slots). */
  readonly overdue: number;
  readonly stopped: boolean;
  /** Refuse new passes, reject queued ones, and wait up to `timeoutMs` for running ones to settle. */
  stop(timeoutMs?: number): Promise<void>;
}

export function createAdmission(opts: {
  concurrency: number; criticalConcurrency?: number; deadlineMs: number;
  onOverdue?: (label: string, elapsedMs: number) => void;
}): Admission {
  const general = new Semaphore(opts.concurrency);
  const critical = new Semaphore(opts.criticalConcurrency ?? 2);
  let active = 0;
  let overdue = 0;
  let stopped = false;
  const inflight = new Set<Promise<unknown>>();
  const alarm = opts.onOverdue ?? ((label: string, elapsedMs: number) =>
    logErr.error('job pass past its deadline; it keeps its slot until it settles', undefined, { job: label, elapsedMs, deadlineMs: opts.deadlineMs }));
  const runAdmitted = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    if (stopped) throw new AdmissionStoppedError();
    const release = await (CRITICAL_JOBS.has(label) ? critical : general).acquire();
    if (stopped) { release(); throw new AdmissionStoppedError(); } // stop() ran while this pass was queued
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
  };
  return {
    get active() { return active; },
    get overdue() { return overdue; },
    get stopped() { return stopped; },
    run<T>(label: string, fn: () => Promise<T>): Promise<T> {
      const pass = runAdmitted(label, fn);
      inflight.add(pass);
      void pass.then(() => inflight.delete(pass), () => inflight.delete(pass));
      return pass;
    },
    async stop(timeoutMs = 5_000) {
      stopped = true;
      const error = new AdmissionStoppedError();
      general.rejectWaiting(error);
      critical.rejectWaiting(error);
      if (!inflight.size) return;
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
      await Promise.race([Promise.allSettled([...inflight]).then(() => undefined), deadline]);
      clearTimeout(timer);
    },
  };
}

let shared: Admission | undefined;

/** The process-wide admission (created on first use from JOBS_CONCURRENCY, JOBS_CRITICAL_CONCURRENCY and
 *  JOBS_PASS_DEADLINE_MS). Once stopped it stays stopped — every late caller gets AdmissionStoppedError — until
 *  resetJobAdmission() (createApp start). */
export function jobAdmission(): Admission {
  if (!shared) {
    shared = createAdmission({
      concurrency: env.JOBS_CONCURRENCY ?? 2,
      criticalConcurrency: env.JOBS_CRITICAL_CONCURRENCY ?? 2,
      deadlineMs: env.JOBS_PASS_DEADLINE_MS ?? 10 * 60_000,
    });
  }
  return shared;
}

/** Engine start (createApp): a fresh admission for this run, replacing one a previous run stopped. */
export function resetJobAdmission(): void {
  shared = undefined;
}

/** Test-only alias: drop the process-wide admission so a suite that left passes hanging starts from free slots. */
export const _resetJobAdmissionForTest = resetJobAdmission;

/** Readiness numbers (GET /v1/readyz): passes holding a slot, and how many of them are past their deadline. */
export function admissionGauges(): { active: number; overdue: number } {
  return { active: shared?.active ?? 0, overdue: shared?.overdue ?? 0 };
}
