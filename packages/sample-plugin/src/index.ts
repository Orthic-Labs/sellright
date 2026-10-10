/**
 * Reference plugin. Every import below is a PUBLIC `@sellright/api` export;
 * a deep import (`@sellright/api/dist/...`) would fail Node resolution.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { LEGACY_FLAG, legacyErrorResponses, legacyErrorShape, type EnginePlugin } from '@sellright/api';
import { withStore } from '@sellright/api/db';
import { HttpError, J, errBody, guard, resolveStoreFromCtx } from '@sellright/api/http';
import { bearerToken } from '@sellright/api/licensing';
import { schema } from '@sellright/api/schema';
import { sampleNote } from './schema.js';

export { sampleNote };
export { policyRegistrars, type PolicyTypeProof } from './policy-exports.js';

export const SAMPLE_PLUGIN_NAME = 'sample';

export interface SampleState {
  greeting: string;
  servicesRan: boolean;
  shutdownRan: boolean;
  jobRuns: number;
}

export function createSamplePlugin(state: SampleState = { greeting: '', servicesRan: false, shutdownRan: false, jobRuns: 0 }): EnginePlugin {
  let greeting = 'hello';
  const routes = new OpenAPIHono();

  routes.openapi(
    createRoute({
      method: 'get',
      path: '/v1/sample/ping',
      summary: 'Sample documented route',
      responses: {
        200: { description: 'OK', content: J(z.object({ ok: z.literal(true), greeting: z.string(), store: z.string(), engineTables: z.number() })) },
        404: { description: 'Unknown store', ...errBody },
      },
    }),
    async (c) => guard(c, async () => {
      const st = await resolveStoreFromCtx(c);
      const notes = await withStore(st.id, (tx) => tx.select({ id: sampleNote.id }).from(sampleNote).where(eq(sampleNote.storeId, st.id)));
      void notes;
      return c.json({ ok: true as const, greeting, store: st.slug, engineTables: Object.keys(schema).length }, 200);
    }),
  );
  // Plain handlers never reach the OpenAPI document; the route inventory (plan 2.5) must still list them.
  routes.get('/v1/sample/plain', (c) => c.json({ bearer: bearerToken(c.req.header('authorization')) ?? null }));
  routes.on('PUT', '/v1/sample/on', () => { throw new HttpError(409, 'sample conflict'); });
  // Legacy wire shape (plan 2.5): the 409 body is `{error: "sample conflict", code}`; the documented
  // example must equal the live body (asserted by the packed smoke).
  routes.openapi(
    createRoute({
      method: 'get',
      path: '/v1/sample/legacy',
      summary: 'Legacy-shape conflict (documented example)',
      [LEGACY_FLAG]: true,
      responses: { 200: { description: 'OK' }, ...legacyErrorResponses({ 409: { error: 'sample conflict', code: 'sample_conflict' } }) },
    }),
    () => { throw new HttpError(409, 'sample conflict', 'sample_conflict'); },
  );

  return {
    name: SAMPLE_PLUGIN_NAME,
    configure(ctx) {
      const merged = ctx.extendEnv({ SAMPLE_GREETING: z.string().default('hello') });
      greeting = merged.SAMPLE_GREETING;
      state.greeting = greeting;
    },
    preRoute(app) {
      app.use('*', async (c, next) => { await next(); c.header('x-sample-preroute', '1'); });
      app.use('/v1/sample/*', legacyErrorShape());
    },
    routes,
    schema: { sampleNote },
    migrations: { folder: fileURLToPath(new URL('../drizzle', import.meta.url)) },
    services(ctx) {
      state.servicesRan = true;
      // AASA overlay (well-known.ts): adds an applinks detail for this plugin's app path.
      ctx.registerAasaOverlay(() => ({ applinks: { apps: [], details: [{ appID: 'SAMPL3PLUG.com.example.sample', paths: ['/sample/*'] }] } }));
      ctx.log.info('sample plugin services ready');
    },
    jobs: () => [{ name: 'tick', intervalMs: 60_000, run: async () => { state.jobRuns += 1; } }],
    effectiveConfig: (ctx) => ({
      intended: { greeting, tokenFingerprint: ctx.fingerprint.sha256Prefix('sample-credential').fingerprint },
      deployment: { note: 'sample' },
    }),
    shutdown() {
      state.shutdownRan = true;
    },
  };
}

export const samplePlugin = createSamplePlugin();
