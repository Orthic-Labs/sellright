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
): void {
  process.on('unhandledRejection', (reason) => {
    logger('[api:unhandledRejection]', reason);
    // Node's default for unhandledRejection (since v15) is to throw and crash;
    // make the immediate exit explicit so the supervisor restart is intentional.
    exit(1);
  });

  process.on('uncaughtException', (err) => {
    logger('[api:uncaughtException]', err);
    // State may be corrupt after an uncaught throw — exit immediately.
    exit(1);
  });
}