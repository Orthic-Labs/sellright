import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { env } from './env.js';
import { startJobScheduler } from './jobs/scheduler.js';

const app = createApp();

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[api] listening on http://localhost:${info.port}  (env=${env.NODE_ENV})`);
  console.log(`[api] OpenAPI:  http://localhost:${info.port}/v1/openapi.json`);
  startJobScheduler();
});
