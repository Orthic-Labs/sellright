import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmailWaker, WAKE_DEBOUNCE_MS } from './wake.js';

/** Deferred drain so tests control when an in-flight drain finishes. */
function deferredDrain() {
  const calls: number[] = [];
  let resolveNext: Array<() => void> = [];
  const drain = vi.fn(() => {
    calls.push(Date.now());
    return new Promise<void>((resolve) => resolveNext.push(resolve));
  });
  const finishAll = () => {
    const pending = resolveNext;
    resolveNext = [];
    pending.forEach((r) => r());
  };
  return { drain, finishAll, calls };
}

describe('createEmailWaker (post-commit wake)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is a no-op when disabled (JOBS_ENABLED off): poll covers it', async () => {
    const drain = vi.fn(async () => undefined);
    const w = createEmailWaker({ drain, enabled: () => false });
    w.wake();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(drain).not.toHaveBeenCalled();
  });

  it('drains once after the debounce window, not before', async () => {
    const drain = vi.fn(async () => undefined);
    const w = createEmailWaker({ drain, enabled: () => true });
    w.wake();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS - 1);
    expect(drain).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('coalesces wakes inside the debounce window into one drain', async () => {
    const drain = vi.fn(async () => undefined);
    const w = createEmailWaker({ drain, enabled: () => true });
    w.wake();
    w.wake();
    w.wake();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('is single-flight: a wake during a running drain re-runs once after it, never concurrently', async () => {
    const d = deferredDrain();
    const w = createEmailWaker({ drain: d.drain, enabled: () => true });
    w.wake();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    expect(d.drain).toHaveBeenCalledTimes(1);

    // Two wakes arrive while the first drain is still in flight.
    w.wake();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    w.wake();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    expect(d.drain).toHaveBeenCalledTimes(1); // no concurrent second drain

    d.finishAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(d.drain).toHaveBeenCalledTimes(2); // exactly one coalesced rerun

    d.finishAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(d.drain).toHaveBeenCalledTimes(2); // nothing further pending
  });

  it('reports drain errors via onError and never throws; later wakes still work', async () => {
    const onError = vi.fn();
    const drain = vi.fn()
      .mockRejectedValueOnce(new Error('smtp down'))
      .mockResolvedValue(undefined);
    const w = createEmailWaker({ drain, enabled: () => true, onError });
    w.wake();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await w.idle();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'smtp down' }));

    w.wake();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await w.idle();
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it('never throws into the caller when the enabled check itself throws', () => {
    const w = createEmailWaker({
      drain: async () => undefined,
      enabled: () => {
        throw new Error('env not loaded');
      },
      onError: vi.fn(),
    });
    expect(() => w.wake()).not.toThrow();
  });
});
