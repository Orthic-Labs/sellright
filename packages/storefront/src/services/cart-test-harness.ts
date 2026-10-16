/**
 * Shared test harness for the cart's cross-tab behaviour (tests only; imported by `*.test.ts` files).
 *
 * - `FakeLocks`: a REAL mutex with the `navigator.locks.request` shape the cart uses — callers run strictly one after
 *   another, in request order, across every `CartService` module instance in the test (jsdom has no Web Locks).
 * - Cookie jar: jsdom has a single `document.cookie`, so two `CartService` module instances (the "tabs") share it by
 *   construction. `freshTab()` loads a second, independent instance (its own mirror, coupon and enrichment).
 * - `deferred()`: a response held open until the test releases it, so arrival order is explicit.
 */
import { vi } from 'vitest';

export class FakeLocks {
  /** Names requested, in order. */
  names: string[] = [];
  /** Highest number of callbacks that ever ran at the same time (must stay 1). */
  maxConcurrent = 0;
  private running = 0;
  private tail: Promise<unknown> = Promise.resolve();

  get requests(): number {
    return this.names.length;
  }

  request<T>(name: string, _options: unknown, callback: (lock: unknown) => Promise<T> | T): Promise<T> {
    this.names.push(name);
    const run = this.tail.then(async () => {
      this.running++;
      this.maxConcurrent = Math.max(this.maxConcurrent, this.running);
      try {
        return await callback({ name });
      } finally {
        this.running--;
      }
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

/** Install a fresh `navigator.locks` and return it. */
export function installLocks(): FakeLocks {
  const locks = new FakeLocks();
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true, writable: true });
  return locks;
}

/** Simulate a browser without Web Locks. */
export function removeLocks(): void {
  Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true, writable: true });
  delete (navigator as unknown as { locks?: unknown }).locks;
}

/** A second "tab": an independent module instance of the cart service (and its HTTP client). */
export async function freshTab(): Promise<typeof import('./CartService')> {
  vi.resetModules();
  return import('./CartService');
}

export function deferred<T = Response>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks and zero-delay timers run (e.g. to prove a request did NOT get sent while a lock is held). */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
