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
    process.emit('unhandledRejection', reason);
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
});