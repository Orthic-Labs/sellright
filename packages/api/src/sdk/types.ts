/**
 * Public SDK contract (plan 2.1). A plugin is a plain object whose optional
 * hooks run in this fixed order inside `createApp`:
 *
 *   configure → preRoute → routes → schema → migrations → services → jobs → shutdown
 *
 * `jobs` runs in `engine.start()`, `shutdown` in `engine.shutdown()`; the rest run
 * during `createApp()` itself. Plugins never import `env` or the pool as module
 * singletons: everything they need arrives on the contexts below.
 */
import type { OpenAPIHono, z } from '@hono/zod-openapi';
import type { Pool } from 'pg';
import type { Env, EnvSource, extendEnv } from '../env.js';
import type { log, err } from '../lib/logger.js';
import type { FingerprintHelpers, SaltedFingerprints } from './fingerprint.js';
import type { PluginJob } from '../jobs/scheduler.js';

export type { Env, EnvSource, PluginJob };

/** Phase names, in execution order. */
export const LIFECYCLE_PHASES = ['configure', 'preRoute', 'routes', 'schema', 'migrations', 'services', 'jobs', 'shutdown'] as const;
export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number];

/** `configure` context: the only place env may be extended. */
export interface ConfigureContext {
  readonly engineVersion: string;
  /** The parsed engine env (read-only view). */
  readonly env: Readonly<Env>;
  /**
   * Parse extra, plugin-specific variables from the SAME resolved source as the engine env
   * (file-backed secrets already resolved). Returns the engine env merged with the typed extras.
   */
  readonly extendEnv: typeof extendEnv;
}

/** Context for every phase after `configure`. */
export interface EngineContext {
  readonly engineVersion: string;
  readonly env: Readonly<Env>;
  /** The runtime-role pool createApp created (NOSUPERUSER, NOBYPASSRLS; checked before any hook runs). */
  readonly pool: Pool;
  readonly log: typeof log;
  readonly logError: typeof err;
  readonly fingerprint: FingerprintHelpers;
  /** Add to the Apple App Site Association document (`/.well-known/apple-app-site-association`). Call from `services`. */
  readonly registerAasaOverlay: (overlay: () => Record<string, unknown>) => void;
  /** Names of every plugin in this composition, in order. */
  readonly pluginNames: readonly string[];
}

/** A plugin's own migration track (applied after the engine track by the migrate step). */
export interface PluginMigrations {
  /** Directory holding drizzle `meta/_journal.json` + SQL files. */
  folder: string;
  /** Journal table. Defaults to `__drizzle_migrations_<plugin>` (sanitised). Must differ from the engine's. */
  table?: string;
  /** Journal schema. Defaults to `drizzle`. */
  schema?: string;
}

/** Plugin contribution to `GET /v1/admin/system/effective-config` (`config/v1`). */
export interface PluginEffectiveConfig {
  /** Content that must be identical between runtimes (7.1 compares equality). Secrets only as fingerprints. */
  intended?: Record<string, unknown>;
  /** Operational facts that may legitimately differ (7.1 compares against an approved value table). */
  deployment?: Record<string, unknown>;
}

export interface EnginePlugin {
  /** Unique name (diagnostics, journal table default, job lock key). Lower-case [a-z0-9-]. */
  name: string;
  /** Exact `@sellright/api` version this plugin was built against; createApp refuses a mismatch. */
  engineVersion?: string;
  configure?(ctx: ConfigureContext): void | Promise<void>;
  /** Middleware / error policies that must wrap every route (runs after request-id + access log, before CORS). */
  preRoute?(app: OpenAPIHono, ctx: EngineContext): void;
  /** Routes mounted at `/` after every built-in route, so a plugin never shadows a built-in exact path. */
  routes?: OpenAPIHono | ((ctx: EngineContext) => OpenAPIHono);
  /** Drizzle tables the plugin owns. Names must not collide with the engine's or another plugin's. */
  schema?: Record<string, unknown> | ((ctx: EngineContext) => Record<string, unknown>);
  migrations?: PluginMigrations;
  /** Register entitlement providers, tier catalogs, device policies, … (never at import time). */
  services?(ctx: EngineContext): void | Promise<void>;
  /** Interval jobs; run only when the engine's jobs are enabled (JOBS_ENABLED=1), leader-locked per name. */
  jobs?(ctx: EngineContext): PluginJob[];
  /** `fp` carries the salted symmetric-secret fingerprint (`fp.symmetric`); `ctx.fingerprint` has only the salt-free ones. */
  effectiveConfig?(ctx: EngineContext, fp: SaltedFingerprints): PluginEffectiveConfig | Promise<PluginEffectiveConfig>;
  /** After HTTP has drained, before the pool closes. */
  shutdown?(ctx: EngineContext): void | Promise<void>;
}

export interface MigrationTableRef {
  schema?: string;
  table: string;
}

export interface CreateAppOptions {
  plugins?: readonly EnginePlugin[];
  /** Environment source; defaults to `process.env`. Parsed and validated inside createApp. */
  env?: EnvSource;
  /** Engine-track journal table. Default `drizzle.__drizzle_migrations`. */
  migrationsTable?: string | MigrationTableRef;
  /** Directory with the engine's drizzle journal. Default: the one packaged with `@sellright/api`. */
  migrationsDir?: string;
  /**
   * `verify` (default): fail boot if any track has unapplied migrations. `skip`: do not look.
   * The serving process never applies DDL; use the migrate step (`@sellright/api/ops` runMigrations).
   */
  migrations?: 'verify' | 'skip';
  /**
   * Test-only escape hatch for the privilege check. Honoured ONLY when NODE_ENV is `test`;
   * anywhere else passing it makes createApp throw.
   */
  allowPrivilegedRuntimeRole?: boolean;
}

export interface StartOptions {
  /** `false` skips binding a port (jobs + listener only). Port 0 picks a free port. */
  listen?: false | { port?: number; hostname?: string };
  /** Install SIGTERM/SIGINT handlers that run `shutdown()` then exit (the executable's behaviour). */
  handleSignals?: boolean;
  /** Shutdown watchdog for signal-driven exits. Default 10 000 ms. */
  shutdownTimeoutMs?: number;
}

export interface ShutdownStep {
  step: 'stop-admitting' | 'cancel-jobs' | 'drain-http' | 'plugin-shutdown' | 'close-resources' | 'close-pool';
  at: number;
}

export interface EngineApp {
  readonly app: OpenAPIHono;
  readonly ctx: EngineContext;
  readonly env: Readonly<Env>;
  readonly phase: 'created' | 'started' | 'stopping' | 'closed';
  /** Lifecycle phases executed so far, in order (`jobs` appears after `start`, `shutdown` after `shutdown`). */
  readonly executedPhases: readonly LifecyclePhase[];
  /** Ordered record of shutdown steps (for diagnostics and tests). */
  readonly shutdownSteps: readonly ShutdownStep[];
  /** Bound port after `start` (null before / when `listen:false`). */
  readonly port: number | null;
  start(options?: StartOptions): Promise<void>;
  shutdown(options?: { timeoutMs?: number }): Promise<void>;
}

export type { z };
