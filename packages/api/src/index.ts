import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { env } from './env.js';
import { startJobScheduler } from './jobs/scheduler.js';
import { log } from './lib/logger.js';

const app = createApp();

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  // OBS-1: structured startup logs so log collectors index port + env as fields.
  log.info('api listening', { url: `http://localhost:${info.port}`, env: env.NODE_ENV, port: info.port });
  log.info('openapi published', { url: `http://localhost:${info.port}/v1/openapi.json` });
  startJobScheduler();
});
