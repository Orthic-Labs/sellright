import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * OBS-1: the logger is a thin wrapper over pino. The two contracts that must
 * hold for the rest of the lane to be useful:
 *
 *   1. Every line emitted is parseable JSON (so log collectors index fields).
 *   2. A child logger built via `withContext({ requestId })` carries that
 *      requestId onto every emitted line — the access log + handler log then
 *      share one correlatable token.
 *
 * Capture stdout while the test runs and assert on the raw lines.
 */
describe('logger', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let captured: string[];

  beforeEach(() => {
    captured = [];
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('emits one parseable JSON line per call', async () => {
    const { log, err } = await import('./logger.js');
    log.info('hello world', { foo: 'bar' });
    err.error('boom', new Error('explode'), { context: 'unit-test' });

    // Both lines were written to stdout.
    expect(captured.length).toBeGreaterThanOrEqual(2);

    // Each chunk may contain multiple lines; split, then pick the JSON ones.
    const lines = captured.join('').split('\n').filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l));

    expect(parsed.some((p) => p.msg === 'hello world' && p.foo === 'bar')).toBe(true);
    const boom = parsed.find((p) => p.msg === 'boom');
    expect(boom).toBeTruthy();
    // pino's stdErrorSerializer turns the Error into { type, message, stack }.
    expect(boom.err).toBeTruthy();
    expect(boom.err.message).toBe('explode');
    expect(boom.context).toBe('unit-test');
  });

  it('propagates requestId from withContext onto every emitted line', async () => {
    // Re-import after spy is in place so the captured stdout is from THIS run.
    const { withContext } = await import('./logger.js');
    const child = withContext({ requestId: 'req-test-123', storeId: 'store-test-456' });

    child.info('first');
    // pino's overload: either (msg) or (obj, msg) — passing fields first, then msg.
    child.info({ extra: 1 }, 'second');

    const lines = captured.join('').split('\n').filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l));
    const infoLines = parsed.filter((p) => p.msg === 'first' || p.msg === 'second');

    expect(infoLines.length).toBe(2);
    for (const l of infoLines) {
      expect(l.requestId).toBe('req-test-123');
      expect(l.storeId).toBe('store-test-456');
    }
    const second = infoLines.find((p) => p.msg === 'second');
    expect(second?.extra).toBe(1);
  });

  it('returns the base logger when no context is provided (no child wrapper)', async () => {
    const { withContext, baseLogger } = await import('./logger.js');
    const child = withContext({});
    child.info('no-context');
    const lines = captured.join('').split('\n').filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l));
    const last = parsed.find((p) => p.msg === 'no-context');
    expect(last).toBeTruthy();
    expect(last.requestId).toBeUndefined();
    expect(last.storeId).toBeUndefined();

    // baseLogger() should also work without throwing.
    expect(baseLogger()).toBeTruthy();
  });
});