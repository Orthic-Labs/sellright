import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEmitter } from 'node:events';

type Stream = EventEmitter & { destroy: ReturnType<typeof vi.fn> };
const transport = vi.hoisted(() => ({ request: null as Stream | null, response: null as Stream | null }));
vi.mock('node:http', async original => {
  const actual = await original<typeof import('node:http')>();
  const { EventEmitter } = await import('node:events');
  return { ...actual, request: vi.fn((_url: URL, options: { signal: AbortSignal }, receive: (value: unknown) => void) => {
    function stream() {
      let closed = false;
      const value = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      value.destroy.mockImplementation(() => {
        if (!closed) { closed = true; value.emit('error', new Error('destroyed')); value.emit('close'); }
        return value;
      });
      return value;
    }
    const req = Object.assign(stream(), { end: vi.fn() });
    const abort = () => req.emit('error', options.signal.reason);
    options.signal.addEventListener('abort', abort, { once: true });
    req.once('close', () => options.signal.removeEventListener('abort', abort));
    req.end.mockImplementation(() => {
      const res = Object.assign(stream(), { headers: {}, statusCode: 200, statusMessage: 'OK' });
      transport.response = res; receive(res); res.emit('data', Buffer.from('partial'));
      // Peer never finishes its body; only cancellation may end this request.
    });
    transport.request = req; return req;
  }) };
});
import { assertSafeOutboundUrl, safeOutboundFetch } from './outbound-url.js';
import { withRequestDeadline } from './request-deadline.js';

beforeEach(() => { vi.useFakeTimers(); transport.request = null; transport.response = null; });
afterEach(() => vi.useRealTimers());
describe('outbound absolute cancellation', () => {
  it.each(['resolve', 'reject'] as const)('stops during DNS & consumes late lookup %s without starting transport', async late => {
    let resolve!: (rows: Array<{ address: string; family: number }>) => void;
    let reject!: (error: Error) => void;
    const lookup = vi.fn(() => new Promise<Array<{ address: string; family: number }>>((yes, no) => { resolve = yes; reject = no; }));
    const request = vi.fn();
    const operation = withRequestDeadline(10_000, signal => safeOutboundFetch('http://merchant.example/api', { signal }, { lookup, request }));
    const rejected = expect(operation).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(10_000); await rejected;
    if (late === 'resolve') resolve([{ address: '93.184.216.34', family: 4 }]);
    else reject(new Error('late DNS failure'));
    await Promise.resolve(); await Promise.resolve();
    expect(request).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('applies cancellation to URL prevalidation & preserves supplied reason', async () => {
    const controller = new AbortController(); const reason = new Error('cancelled');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const operation = assertSafeOutboundUrl('https://merchant.example', { signal: controller.signal, lookup: () => new Promise(() => {}) });
    const rejected = expect(operation).rejects.toBe(reason);
    await Promise.resolve(); controller.abort(reason); await rejected;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('destroys stalled request & response bodies, releases listeners & deadline timer', async () => {
    const operation = withRequestDeadline(10_000, signal => safeOutboundFetch('http://merchant.example/api', { signal }, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    }));
    const rejected = expect(operation).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(10_000); await rejected;
    expect(transport.request?.destroy).toHaveBeenCalledOnce();
    expect(transport.response?.destroy).toHaveBeenCalledOnce();
    for (const event of ['data', 'end', 'aborted', 'error', 'close']) expect(transport.response?.listenerCount(event)).toBe(0);
    for (const event of ['error', 'close']) expect(transport.request?.listenerCount(event)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
