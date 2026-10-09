/**
 * `createApp` — the engine SDK entry (plan 2.1).
 *
 *   createApp({ plugins, env, migrationsTable }) → EngineApp
 *
 * Lifecycle: configure → preRoute → routes → schema → migrations → services
 * (all inside `createApp`) → jobs (`start`) → shutdown (`shutdown`).
 *
 * The env is parsed and the pool is created HERE, not at import: importing any
 * engine module opens no connection and reads no env (sdk/import-purity.test.ts).
 * One engine per process; a second `createApp` before `shutdown()` is refused.
 *
 * Shutdown order is fixed: stop admitting → cancel jobs/timers → drain HTTP →
 * (plugin shutdown hooks, owned resources) → close the pool.
 */
import { serve } from '@hono/node-server';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import type { Server } from 'node:http';
import { buildHttpApp } from '../app.js';
import { SELLRIGHT_VERSION } from '../version.js';
import { closeEnv, envOrigin, extendEnv, initEnv, type Env } from '../env.js';
import { assertRuntimeRoleUnprivileged, closePools, initPools, poolsInitialised } from '../db/client.js';
import * as engineSchema from '../db/schema.js';
import { closeEngineResources, markEngineClosed } from '../resources.js';
import { startJobScheduler, type JobScheduler, type PluginJob } from '../jobs/scheduler.js';
import { startStoreCacheInvalidationListener, stopStoreCacheInvalidationListener } from '../store-context.js';
import { log, err as logError, resetLogger } from '../lib/logger.js';
import { fingerprint } from './fingerprint.js';
import { clearAasaOverlays, registerAasaOverlay } from '../routes/well-known.js';
import { setEngineState } from './engine-state.js';
import { assertMigrationsCurrent, resolveTracks } from './migrations.js';
import {
  type CreateAppOptions, type EngineApp, type EngineContext, type EnginePlugin, type LifecyclePhase,
  type ShutdownStep, type StartOptions,
} from './types.js';

const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

let active: symbol | null = null;

export class EngineSetupError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'EngineSetupError';
  }
}

function validatePlugins(plugins: readonly EnginePlugin[]): void {
  const seen = new Set<string>();
  for (const p of plugins) {
    if (!PLUGIN_NAME.test(p.name)) throw new EngineSetupError(`invalid plugin name ${JSON.stringify(p.name)} (lower-case letters, digits, '-')`, 'PLUGIN_NAME');
    if (seen.has(p.name)) throw new EngineSetupError(`plugin "${p.name}" is registered twice`, 'PLUGIN_DUPLICATE');
    seen.add(p.name);
    if (p.engineVersion !== undefined && p.engineVersion !== SELLRIGHT_VERSION) {
      throw new EngineSetupError(`plugin "${p.name}" was built for @sellright/api ${p.engineVersion}, running ${SELLRIGHT_VERSION}`, 'PLUGIN_ENGINE_VERSION');
    }
  }
}

/** Table identities (`schema.name`) of the engine's own drizzle tables. */
function tableKeys(tables: Record<string, unknown>): string[] {
  const keys: string[] = [];
  for (const v of Object.values(tables)) {
    if (is(v, PgTable)) {
      const cfg = getTableConfig(v);
      keys.push(`${cfg.schema ?? 'public'}.${cfg.name}`);
    }
  }
  return keys;
}

function collectSchema(plugins: readonly EnginePlugin[], ctx: EngineContext): void {
  const owners = new Map<string, string>();
  for (const k of tableKeys(engineSchema as unknown as Record<string, unknown>)) owners.set(k, 'engine');
  for (const p of plugins) {
    if (!p.schema) continue;
    const tables = typeof p.schema === 'function' ? p.schema(ctx) : p.schema;
    for (const k of tableKeys(tables)) {
      const owner = owners.get(k);
      if (owner) throw new EngineSetupError(`plugin "${p.name}" declares table ${k} which is already owned by ${owner}`, 'SCHEMA_COLLISION');
      owners.set(k, p.name);
    }
  }
}

async function teardownRuntime(): Promise<void> {
  await closeEngineResources();
  await closePools();
  closeEnv();
  setEngineState(null);
}

export async function createApp(options: CreateAppOptions = {}): Promise<EngineApp> {
  if (active) throw new EngineSetupError('createApp was already called in this process; call shutdown() on the first engine before creating another', 'ENGINE_ACTIVE');
  if (envOrigin() === 'implicit' || poolsInitialised()) {
    throw new EngineSetupError(
      'the engine env or database pool was initialised before createApp ran (a module touched `env`/`pool` at import time); ' +
      'createApp must parse the env and create the pool itself',
      'RUNTIME_PREINITIALISED',
    );
  }
  const plugins = options.plugins ?? [];
  validatePlugins(plugins);
  const token = Symbol('engine');
  active = token;
  const phases: LifecyclePhase[] = [];
  const mark = (p: LifecyclePhase) => { phases.push(p); };

  try {
    // ── env parsed + pool created inside createApp ────────────────────────────
    markEngineClosed(false);
    const env: Env = initEnv(options.env ?? process.env);
    resetLogger(env.NODE_ENV);
    if (options.allowPrivilegedRuntimeRole && env.NODE_ENV !== 'test') {
      throw new EngineSetupError('allowPrivilegedRuntimeRole is a test-only override and is refused unless NODE_ENV=test', 'PRIVILEGE_OVERRIDE');
    }
    const pool = initPools(env);

    // ── privilege check (2.6): runtime role must be NOSUPERUSER + NOBYPASSRLS ─
    if (options.allowPrivilegedRuntimeRole) {
      log.warn('privileged runtime role allowed by explicit test override');
    } else {
      await assertRuntimeRoleUnprivileged(pool);
    }

    const ctx: EngineContext = {
      engineVersion: SELLRIGHT_VERSION,
      env,
      pool,
      log,
      logError,
      fingerprint,
      registerAasaOverlay,
      pluginNames: plugins.map((p) => p.name),
    };

    // ── configure ────────────────────────────────────────────────────────────
    mark('configure');
    for (const p of plugins) await p.configure?.({ engineVersion: SELLRIGHT_VERSION, env, extendEnv });

    // ── preRoute + routes (built together: preRoute hooks run before any route mounts) ─
    let admitting = true;
    const app: OpenAPIHono = buildHttpApp({ plugins, ctx, admit: () => admitting });
    mark('preRoute');
    mark('routes');

    // ── schema ───────────────────────────────────────────────────────────────
    mark('schema');
    collectSchema(plugins, ctx);

    // ── migrations (verify only; the serving role never applies DDL) ─────────
    mark('migrations');
    const migrationMode = options.migrations ?? 'verify';
    const tracks = resolveTracks(plugins, { folder: options.migrationsDir, table: options.migrationsTable });
    if (migrationMode === 'verify') {
      try {
        await assertMigrationsCurrent(pool, tracks);
      } catch (e) {
        if ((e as { code?: string }).code === '42501') {
          throw new EngineSetupError('the runtime role cannot read the migration journal tables; grant SELECT on them or pass migrations: "skip"', 'MIGRATIONS_UNREADABLE');
        }
        throw e;
      }
    }

    // ── services ─────────────────────────────────────────────────────────────
    mark('services');
    for (const p of plugins) await p.services?.(ctx);

    // ── runtime state shared with the system endpoints ───────────────────────
    let server: Server | null = null;
    let scheduler: JobScheduler | null = null;
    let phase: EngineApp['phase'] = 'created';
    const shutdownSteps: ShutdownStep[] = [];
    const startedAt = new Date();
    const signalHandlers: Array<[NodeJS.Signals, () => void]> = [];

    setEngineState({
      version: SELLRIGHT_VERSION,
      ctx,
      plugins,
      startedAt,
      port: () => { const a = server?.address(); return a && typeof a === 'object' ? a.port : null; },
      jobs: () => ({ enabled: scheduler?.enabled ?? false, names: scheduler?.jobs ?? [] }),
      migrations: () => ({
        engineTable: `${tracks[0]!.schema}.${tracks[0]!.table}`,
        pluginTables: Object.fromEntries(tracks.slice(1).map((t) => [t.name, `${t.schema}.${t.table}`])),
        mode: migrationMode,
      }),
    });

    const step = (name: ShutdownStep['step']) => { shutdownSteps.push({ step: name, at: Date.now() }); };

    let shutdownPromise: Promise<void> | null = null;
    const shutdown: EngineApp['shutdown'] = (opts) => {
      shutdownPromise ??= (async () => {
        const timeoutMs = opts?.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
        phase = 'stopping';
        // 1. stop admitting
        admitting = false;
        step('stop-admitting');
        // 2 + 3. cancel jobs / timers, and drain HTTP CONCURRENTLY: timers are cleared
        // synchronously inside stop(); only the wait for in-flight job passes overlaps the
        // HTTP drain, so the whole budget is `timeoutMs`, not stop-wait + drain (review F2).
        const jobWait = Math.min(5_000, Math.floor(timeoutMs / 2));
        const jobsStopped = Promise.all([scheduler?.stop(jobWait), stopStoreCacheInvalidationListener()]);
        step('cancel-jobs');
        const drained = server ? new Promise<void>((resolve, reject) => {
          const s = server!;
          const force = setTimeout(() => s.closeAllConnections?.(), timeoutMs);
          force.unref?.();
          s.close((e) => { clearTimeout(force); if (e && (e as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(e); else resolve(); });
          s.closeIdleConnections?.();
        }) : Promise.resolve();
        await Promise.all([jobsStopped, drained]);
        step('drain-http');
        // plugin shutdown hooks, reverse order; a failing hook never blocks the pool close
        for (const p of [...plugins].reverse()) {
          try { await p.shutdown?.(ctx); } catch (e) { logError.error('plugin shutdown hook failed', e, { plugin: p.name }); }
        }
        step('plugin-shutdown');
        const failures = await closeEngineResources();
        for (const f of failures) logError.error('engine resource failed to close', f.error, { resource: f.name });
        clearAasaOverlays();
        step('close-resources');
        // 4. close the pool
        await closePools();
        markEngineClosed(true);
        step('close-pool');
        closeEnv();
        setEngineState(null);
        // signal handlers stay installed until here so a second signal during shutdown is ignored, not fatal
        for (const [sig, h] of signalHandlers) process.off(sig, h);
        mark('shutdown');
        phase = 'closed';
        if (active === token) active = null;
      })();
      return shutdownPromise;
    };

    const engine: EngineApp = {
      app,
      ctx,
      env,
      get phase() { return phase; },
      get executedPhases() { return phases; },
      get shutdownSteps() { return shutdownSteps; },
      get port() { const a = server?.address(); return a && typeof a === 'object' ? a.port : null; },
      shutdown,
      async start(startOptions: StartOptions = {}) {
        if (phase !== 'created') throw new EngineSetupError(`start() called in phase ${phase}`, 'ENGINE_PHASE');
        // listen first (the legacy executable started jobs from the listening callback)
        if (startOptions.listen !== false) {
          const port = startOptions.listen?.port ?? env.PORT;
          const hostname = startOptions.listen?.hostname ?? env.HOST;
          server = await new Promise<Server>((resolve, reject) => {
            const s = serve({ fetch: app.fetch, port, hostname }, (info) => {
              // OBS-1: structured startup logs so log collectors index port + env as fields.
              log.info('api listening', { url: `http://localhost:${info.port}`, env: env.NODE_ENV, port: info.port });
              log.info('openapi published', { url: `http://localhost:${info.port}/v1/openapi.json` });
              resolve(s as Server);
            }) as Server;
            s.once('error', reject);
          });
        }
        // jobs
        mark('jobs');
        const pluginJobs: Array<PluginJob & { plugin: string }> = [];
        for (const p of plugins) {
          const jobs = p.jobs?.(ctx) ?? [];
          const names = new Set<string>();
          for (const j of jobs) {
            if (names.has(j.name)) throw new EngineSetupError(`plugin "${p.name}" declares job "${j.name}" twice`, 'JOB_DUPLICATE');
            names.add(j.name);
            pluginJobs.push({ ...j, plugin: p.name });
          }
        }
        scheduler = startJobScheduler(pluginJobs);
        // SELLRIGHT-ISSUES P2: cross-process store-config cache invalidation (LISTEN side).
        // Best-effort: a failure leaves the 60s TTL as the fallback, so it never blocks startup.
        startStoreCacheInvalidationListener().catch((e) => log.info('store cache invalidation listener failed to start (60s TTL is the fallback)', { err: String(e) }));
        phase = 'started';
        if (startOptions.handleSignals) {
          const timeoutMs = startOptions.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
          let signalled = false;
          const onSignal = (signal: NodeJS.Signals) => {
            if (signalled) { console.warn(`[api] received ${signal} during shutdown — ignoring`); return; }
            signalled = true;
            console.log(`[api] ${signal} received — draining (timeout ${timeoutMs}ms)`);
            // Force-exit watchdog so a hung connection can't block the deploy forever.
            const forceExit = setTimeout(() => {
              console.error(`[api] shutdown exceeded ${timeoutMs}ms — forcing exit(1)`);
              process.exit(1);
            }, timeoutMs);
            forceExit.unref();
            // force-close lingering connections a little before the exit watchdog fires
            shutdown({ timeoutMs: Math.floor(timeoutMs * 0.8) }).then(
              () => { console.log('[api] shutdown complete'); clearTimeout(forceExit); process.exit(0); },
              (e) => { console.error('[api] shutdown error:', e); process.exit(1); },
            );
          };
          for (const sig of ['SIGTERM', 'SIGINT'] as const) {
            const h = () => onSignal(sig);
            signalHandlers.push([sig, h]);
            process.on(sig, h);
          }
        }
      },
    };
    return engine;
  } catch (e) {
    await teardownRuntime();
    if (active === token) active = null;
    throw e;
  }
}
