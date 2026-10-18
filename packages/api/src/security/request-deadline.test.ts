import { afterEach, describe, expect, it, vi } from 'vitest';
import { withRequestDeadline } from './request-deadline.js';

afterEach(() => vi.useRealTimers());
describe('absolute request deadline cleanup', () => {
  it.each(['success', 'failure'] as const)('clears timer & parent listener after %s', async outcome => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, 'removeEventListener');
    const failure = new Error('failed');
    const result = withRequestDeadline(10_000, async () => {
      if (outcome === 'failure') throw failure;
      return 7;
    }, parent.signal);
    if (outcome === 'failure') await expect(result).rejects.toBe(failure);
    else expect(await result).toBe(7);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves caller abort reason & cancels live work before returning', async () => {
    vi.useFakeTimers();
    const parent = new AbortController(); const reason = new Error('caller cancelled');
    let active = true;
    const result = withRequestDeadline(10_000, signal => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { active = false; reject(signal.reason); }, { once: true });
    }), parent.signal);
    const rejected = expect(result).rejects.toBe(reason);
    parent.abort(reason); await rejected;
    expect(active).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start work for an already cancelled caller', async () => {
    vi.useFakeTimers(); const parent = new AbortController(); parent.abort('cancelled'); const run = vi.fn();
    await expect(withRequestDeadline(10_000, run, parent.signal)).rejects.toBe('cancelled');
    expect(run).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});
