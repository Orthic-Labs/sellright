/**
 * Post-commit wake for the email outbox. Transactional mail (magic link, verify,
 * password reset, order confirmation, balance pay link) is enqueued in the
 * request transaction; without a wake it waits for the 60 s scheduler poll.
 * `wakeEmailDelivery()` runs one deliverEmails() drain shortly after COMMIT.
 *
 * Safety: deliverEmails claims rows with FOR UPDATE SKIP LOCKED and flips them
 * to 'processing' (claimed_at) in the same statement, so a wake-triggered drain
 * and the scheduled drain never deliver the same row. This waker is not leader
 * locked on purpose — it only ever adds an earlier pass, never a second owner.
 *
 * Single-flight: at most one drain runs in this process; wakes arriving during a
 * drain set a rerun flag, and wakes arriving inside the debounce window coalesce.
 * Disabled (no-op) unless JOBS_ENABLED=1; otherwise the 60 s poll still covers it.
 * Never throws: drain errors are reported via onError.
 */
import { getEnv } from '../env.js';
import { err as logErr } from '../lib/logger.js';
import { deliverEmails } from './outbox.js';

export const WAKE_DEBOUNCE_MS = 250;

export interface EmailWaker {
  /** Request a drain soon. Safe to call from any post-commit hook. */
  wake(): void;
  /** Resolves once no drain is running and no wake is pending. Test helper. */
  idle(): Promise<void>;
}

export interface EmailWakerOptions {
  drain: () => Promise<unknown>;
  enabled: () => boolean;
  debounceMs?: number;
  onError?: (err: unknown) => void;
}

export function createEmailWaker(opts: EmailWakerOptions): EmailWaker {
  const debounceMs = opts.debounceMs ?? WAKE_DEBOUNCE_MS;
  const report = opts.onError ?? (() => {});
  let timer: ReturnType<typeof setTimeout> | null = null;
  let draining = false;
  let rerun = false;
  let current: Promise<void> | null = null;

  const kick = (): void => {
    if (draining) {
      rerun = true;
      return;
    }
    draining = true;
    current = (async () => {
      try {
        do {
          rerun = false;
          try {
            await opts.drain();
          } catch (err) {
            report(err);
          }
        } while (rerun);
      } finally {
        draining = false;
        current = null;
      }
    })();
  };

  return {
    wake(): void {
      try {
        if (!opts.enabled()) return;
        if (timer) return; // coalesce: a drain is already scheduled
        timer = setTimeout(() => {
          timer = null;
          kick();
        }, debounceMs);
        timer.unref?.();
      } catch (err) {
        report(err);
      }
    },
    async idle(): Promise<void> {
      while (timer || current) {
        if (current) await current;
        else await new Promise((r) => setTimeout(r, 5));
      }
    },
  };
}

let enabledOverride: (() => boolean) | null = null;

/** Test hook: override the JOBS_ENABLED check for the process-wide waker. */
export function setEmailWakeEnabledForTests(fn: (() => boolean) | null): void {
  enabledOverride = fn;
}

const sharedWaker = createEmailWaker({
  drain: () => deliverEmails({ log: () => {} }),
  enabled: () => (enabledOverride ? enabledOverride() : getEnv().JOBS_ENABLED === '1'),
  onError: (e) => logErr.error('email wake drain failed; 60 s poll will retry', e),
});

/** Process-wide post-commit wake. No-op unless JOBS_ENABLED=1. */
export function wakeEmailDelivery(): void {
  sharedWaker.wake();
}

/** Test helper: wait for the process-wide waker to finish its pending drain. */
export function emailWakeIdleForTests(): Promise<void> {
  return sharedWaker.idle();
}
