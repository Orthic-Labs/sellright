import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerProcessErrorHandlers } from './process-error-handlers.js';

type ExitFn = (code: number) => void;
type LoggerFn = (label: string, err: unknown) => void;

describe('registerProcessErrorHandlers (REL-2)', () => {
  afterEach(() => {
    // Strip any listeners registered during the test so we don't leak them
    // into vitest's own process (and so each test starts clean).
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
  });

  it('registers an unhandledRejection listener', () => {
    registerProcessErrorHandlers(
      vi.fn() as unknown as ExitFn,
      vi.fn() as unknown as LoggerFn,
    );
    const listeners = process.listeners('unhandledRejection');
    expect(listeners.length).toBeGreaterThan(0);
  });

  it('registers an uncaughtException listener', () => {
    registerProcessErrorHandlers(
      vi.fn() as unknown as ExitFn,
      vi.fn() as unknown as LoggerFn,
    );
    const listeners = process.listeners('uncaughtException');
    expect(listeners.length).toBeGreaterThan(0);
  });

  it('logs the full reason and exits with code 1 on unhandledRejection', () => {
    const exitSpy = vi.fn();
    const loggerSpy = vi.fn();
    registerProcessErrorHandlers(
      exitSpy as unknown as ExitFn,
      loggerSpy as unknown as LoggerFn,
    );
    const reason = new Error('boom');
    process.emit('unhandledRejection', reason, Promise.resolve());
    expect(loggerSpy).toHaveBeenCalledWith('[api:unhandledRejection]', reason);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('logs the error and exits with code 1 on uncaughtException', () => {
    const exitSpy = vi.fn();
    const loggerSpy = vi.fn();
    registerProcessErrorHandlers(
      exitSpy as unknown as ExitFn,
      loggerSpy as unknown as LoggerFn,
    );
    const err = new Error('sync boom');
    process.emit('uncaughtException', err);
    expect(loggerSpy).toHaveBeenCalledWith('[api:uncaughtException]', err);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('logs but does not exit on a late uncaught exception after the engine finished shutdown (review F4)', () => {
    const exitSpy = vi.fn();
    const loggerSpy = vi.fn();
    registerProcessErrorHandlers(exitSpy as unknown as ExitFn, loggerSpy as unknown as LoggerFn, () => true);
    process.emit('uncaughtException', new Error('late timer'));
    expect(loggerSpy).toHaveBeenCalledWith('[api:uncaughtExceptionAfterShutdown]', expect.any(Error));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('logs but does not exit on a late rejection after the engine finished shutdown (review F4)', () => {
    const exitSpy = vi.fn();
    const loggerSpy = vi.fn();
    registerProcessErrorHandlers(exitSpy as unknown as ExitFn, loggerSpy as unknown as LoggerFn, () => true);
    process.emit('unhandledRejection', new Error('late'), Promise.resolve());
    expect(loggerSpy).toHaveBeenCalledWith('[api:lateRejectionAfterShutdown]', expect.any(Error));
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('default logger', () => {
  afterEach(() => {
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
  });

  it('logs through the structured logger and still exits 1 on an unhandled rejection', async () => {
    const logger = await import('./logger.js');
    const spy = vi.spyOn(logger.err, 'error').mockImplementation(() => undefined);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.fn();
    registerProcessErrorHandlers(exit as unknown as ExitFn, undefined, () => false);
    const boom = new Error('boom');
    for (const l of process.listeners('unhandledRejection')) (l as (r: unknown, p: unknown) => void)(boom, Promise.resolve());
    expect(spy).toHaveBeenCalledWith('[api:unhandledRejection]', boom);
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    spy.mockRestore();
    consoleSpy.mockRestore();
  });
});
