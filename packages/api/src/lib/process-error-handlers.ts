import { isEngineClosed } from '../resources.js';

// REL-2: catch stray async / sync failures at the process boundary so a
// supervisor (pm2 / systemd / docker restart) restarts us cleanly instead of
// leaving the process wedged. Logs the full stack via console.error to match
// the existing console-error pattern across the API (app.ts, jobs/, etc.).

type ProcessErrorLogger = (label: string, err: unknown) => void;

const defaultLogger: ProcessErrorLogger = (label, err) => {
  // eslint-disable-next-line no-console
  console.error(label, err);
};

export function registerProcessErrorHandlers(
  exit: (code: number) => void = (code) => process.exit(code),
  logger: ProcessErrorLogger = defaultLogger,
  engineClosed: () => boolean = isEngineClosed,
): void {
  process.on('unhandledRejection', (reason) => {
    // A straggler (fire-and-forget promise) failing AFTER the engine finished its ordered
    // shutdown must not turn a clean stop into exit(1): the signal path exits 0 right after.
    if (engineClosed()) {
      logger('[api:lateRejectionAfterShutdown]', reason);
      return;
    }
    logger('[api:unhandledRejection]', reason);
    // Node's default for unhandledRejection (since v15) is to throw and crash;
    // make the immediate exit explicit so the supervisor restart is intentional.
    exit(1);
  });

  process.on('uncaughtException', (err) => {
    // A straggler throwing from a timer/callback after the ordered shutdown (env already closed)
    // must not turn a clean stop into exit(1) (review F4); the signal path exits 0 right after.
    if (engineClosed()) {
      logger('[api:uncaughtExceptionAfterShutdown]', err);
      return;
    }
    logger('[api:uncaughtException]', err);
    // State may be corrupt after an uncaught throw — exit immediately.
    exit(1);
  });
}