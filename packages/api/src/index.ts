import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { env } from './env.js';
import { registerProcessErrorHandlers } from './lib/process-error-handlers.js';
import { pool } from './db/client.js';
import { startJobScheduler } from './jobs/scheduler.js';
import { log } from './lib/logger.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

// REL-2: install process-level error handlers BEFORE the server starts so
// nothing in `serve()` / `startJobScheduler()` can crash the process
// without a logged, intentional exit.
registerProcessErrorHandlers();

const app = createApp();

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  // OBS-1: structured startup logs so log collectors index port + env as fields.
  log.info('api listening', { url: `http://localhost:${info.port}`, env: env.NODE_ENV, port: info.port });
  log.info('openapi published', { url: `http://localhost:${info.port}/v1/openapi.json` });
  startJobScheduler();
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    // eslint-disable-next-line no-console
    console.warn(`[api] received ${signal} during shutdown — ignoring`);
    return;
  }
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log(`[api] ${signal} received — draining (timeout ${SHUTDOWN_TIMEOUT_MS}ms)`);

  // Force-exit watchdog so a hung connection can't block the deploy forever.
  const forceExit = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error(`[api] shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit(1)`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    // Stop accepting new connections; drain in-flight Node requests.
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    // eslint-disable-next-line no-console
    console.log('[api] http server closed — draining DB pool');

    // Drain the pool — closes all idle clients, waits for in-flight queries.
    await pool.end();
    // eslint-disable-next-line no-console
    console.log('[api] shutdown complete');
    clearTimeout(forceExit);
    process.exit(0);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[api] shutdown error:', err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
