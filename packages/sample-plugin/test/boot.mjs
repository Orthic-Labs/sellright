// Runs INSIDE the temp consumer install (node_modules contains only the two packed tarballs
// and their dependencies). Prints one JSON object on the last stdout line.
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createApp, routeInventory, legacyExampleViolations, LEGACY_FLAG } from '@sellright/api';
import { createSamplePlugin } from '@sellright/sample-plugin';
import { runMigrations } from '@sellright/api/ops';
import { SAMPLE_PLUGIN_NAME, sampleNote } from '@sellright/sample-plugin';

const out = {};
const dbUrl = process.env.DATABASE_URL;
const privUrl = process.env.PRIV_DATABASE_URL;
const plugin = () => createSamplePlugin();

// ── single-instance: resolve each shared package from the engine's and the plugin's own location ──
const apiDir = realpathSync(new URL('./node_modules/@sellright/api/', import.meta.url));
const pluginDir = realpathSync(new URL('./node_modules/@sellright/sample-plugin/', import.meta.url));
const resolveFrom = (dir, spec) => realpathSync(createRequire(pathToFileURL(dir + '/package.json')).resolve(spec));
out.instances = {};
for (const spec of ['drizzle-orm', 'pg', '@hono/zod-openapi']) {
  out.instances[spec] = [...new Set([resolveFrom(apiDir, spec), resolveFrom(pluginDir, spec)])].length;
}
out.instances['@sellright/api'] = [...new Set([
  realpathSync(createRequire(pathToFileURL(pluginDir + '/package.json')).resolve('@sellright/api')),
  realpathSync(createRequire(pathToFileURL(apiDir + '/package.json')).resolve('@sellright/api')),
])].length;

// ── deep imports must fail Node resolution ──
out.deep = {};
for (const spec of ['@sellright/api/dist/db/client.js', '@sellright/api/dist/env.js', '@sellright/api/db/client', '@sellright/api/src/index.ts']) {
  try { await import(spec); out.deep[spec] = 'LOADED'; } catch (e) { out.deep[spec] = e.code ?? e.message; }
}

// ── artifact contents surface ──
const fs = await import('node:fs');
out.artifact = {
  buildInfo: JSON.parse(fs.readFileSync(`${apiDir}/BUILD-INFO.json`, 'utf8')),
  hasDrizzle: fs.existsSync(`${apiDir}/drizzle/meta/_journal.json`),
  hasContract: fs.existsSync(`${apiDir}/exports/contract.json`),
  hasDist: fs.existsSync(`${apiDir}/dist/sdk/index.js`),
  testsShipped: fs.existsSync(`${apiDir}/dist/sdk/create-app.db.test.js`),
};

const baseEnv = (extra = {}) => ({ ...process.env, NODE_ENV: 'test', DATABASE_URL: dbUrl, SAMPLE_GREETING: 'packed', ...extra });
// base AASA app id (engine reads process.env.AASA_APP_IDS); the plugin overlay adds applinks on top
process.env.AASA_APP_IDS = 'BASEID1234.com.example.base';

// ── migrate step: engine track then plugin track, owner credential ──
const applied = await runMigrations({ databaseUrl: dbUrl, plugins: [plugin()] });
out.migrated = applied.map((s) => ({ track: s.track.name, table: `${s.track.schema}.${s.track.table}` }));

// ── privileged role rejected ──
out.privileged = { skipped: !privUrl };
if (privUrl) {
  try { await createApp({ env: baseEnv({ DATABASE_URL: privUrl }), plugins: [plugin()] }); out.privileged.result = 'ACCEPTED'; }
  catch (e) { out.privileged.result = /privileged Postgres role/.test(String(e.message)) ? 'REJECTED' : `OTHER: ${e.message}`; }
}

// ── composed boot: plugin routes, migrations verified (both tracks), shutdown ──
const state = { greeting: '', servicesRan: false, shutdownRan: false, jobRuns: 0 };
const engine = await createApp({ env: baseEnv(), plugins: [createSamplePlugin(state)] });
out.phases = [...engine.executedPhases];
const ping = await engine.app.request('/v1/sample/ping', { headers: { 'x-store-slug': process.env.STORE_SLUG } });
out.ping = { status: ping.status, body: await ping.json(), pre: ping.headers.get('x-sample-preroute') };
const plain = await engine.app.request('/v1/sample/plain', { headers: { authorization: 'Bearer tok-1' } });
out.plain = await plain.json();
const conflict = await engine.app.request('/v1/sample/on', { method: 'PUT' });
out.on = { status: conflict.status };
// legacy wire shape: documented example in the composed OpenAPI equals the live body (plan 2.5)
const doc = await (await engine.app.request('/v1/openapi.json')).json();
const legacyOp = doc.paths['/v1/sample/legacy'].get;
out.legacy = {
  flagged: legacyOp[LEGACY_FLAG] === true,
  violations: legacyExampleViolations(doc),
  example: legacyOp.responses['409'].content['application/json'].example,
};
const legacyLive = await engine.app.request('/v1/sample/legacy');
const { requestId, ...legacyBody } = await legacyLive.json();
out.legacy.live = { status: legacyLive.status, body: legacyBody, hasRequestId: typeof requestId === 'string' };
// AASA overlay (plan 2.6): applinks from the plugin merged with the base webcredentials
const aasa = await engine.app.request('/.well-known/apple-app-site-association');
out.aasa = { status: aasa.status, body: await aasa.json() };
const inv = await routeInventory(engine.app);
out.inventory = {
  plugin: inv.routes.filter((r) => r.path.startsWith('/v1/sample/')).map((r) => `${r.method} ${r.path}`),
  undocumentedPlugin: inv.undocumented.filter((r) => r.path.startsWith('/v1/sample/')).map((r) => `${r.method} ${r.path}`),
  orphaned: inv.orphanedOpenApi.length,
};
out.table = (await engine.ctx.pool.query("SELECT to_regclass('sample_note') AS t")).rows[0].t;
out.tableDefined = Object.keys({ sampleNote });
await engine.start({ listen: { port: 0, hostname: '127.0.0.1' } });
out.health = (await fetch(`http://127.0.0.1:${engine.port}/v1/health`)).status;
await engine.shutdown();
out.shutdown = { steps: engine.shutdownSteps.map((s) => s.step), phase: engine.phase, state };
out.name = SAMPLE_PLUGIN_NAME;
console.log('RESULT ' + JSON.stringify(out));
