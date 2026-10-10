/**
 * Migration tracks (plan 2.1 `migrations` phase, 2.4 migrate step).
 *
 * The serving process NEVER applies DDL: it runs as the NOSUPERUSER/NOBYPASSRLS
 * runtime role (2.6). createApp therefore only VERIFIES that every track
 * (engine, then each plugin) is fully applied; applying is `runMigrations`
 * (exported from `@sellright/api/ops`), which takes the separate owner credential.
 *
 * drizzle's migrator applies every journal entry whose `when` is greater than the
 * newest `created_at` in the track's journal table; "pending" is computed the same way.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import type { EnginePlugin, MigrationTableRef } from './types.js';

export interface MigrationTrack {
  /** `engine` or the plugin name. */
  name: string;
  folder: string;
  schema: string;
  table: string;
}

export interface TrackStatus {
  track: MigrationTrack;
  journalEntries: number;
  /** Tags of journal entries newer than the last applied one, in order. */
  pending: string[];
  /** `created_at` of the newest applied migration, or null when the journal table is absent/empty. */
  lastApplied: number | null;
}

interface QueryLike {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export const DEFAULT_MIGRATIONS_SCHEMA = 'drizzle';
export const DEFAULT_ENGINE_MIGRATIONS_TABLE = '__drizzle_migrations';

/** The drizzle folder packaged with @sellright/api (works from src/ and dist/). */
export const PACKAGED_MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function ident(kind: string, v: string): string {
  if (!IDENT.test(v)) throw new Error(`invalid ${kind} identifier: ${JSON.stringify(v)}`);
  return v;
}

export function normaliseTableRef(ref: string | MigrationTableRef | undefined): { schema: string; table: string } {
  if (!ref) return { schema: DEFAULT_MIGRATIONS_SCHEMA, table: DEFAULT_ENGINE_MIGRATIONS_TABLE };
  if (typeof ref === 'string') return { schema: DEFAULT_MIGRATIONS_SCHEMA, table: ident('migrations table', ref) };
  return { schema: ident('migrations schema', ref.schema ?? DEFAULT_MIGRATIONS_SCHEMA), table: ident('migrations table', ref.table) };
}

/** Plugin journal table default: `__drizzle_migrations_<name>` with non-identifier characters folded to `_`. */
export function defaultPluginTable(pluginName: string): string {
  const folded = pluginName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  // Trim edge underscores without a backtracking regex (CodeQL js/polynomial-redos).
  let start = 0;
  let end = folded.length;
  while (start < end && folded[start] === '_') start++;
  while (end > start && folded[end - 1] === '_') end--;
  return `__drizzle_migrations_${folded.slice(start, end)}`.slice(0, 63);
}

export function resolveTracks(
  plugins: readonly EnginePlugin[],
  engine: { folder?: string; table?: string | MigrationTableRef } = {},
): MigrationTrack[] {
  const e = normaliseTableRef(engine.table);
  const tracks: MigrationTrack[] = [{ name: 'engine', folder: engine.folder ?? PACKAGED_MIGRATIONS_DIR, ...e }];
  for (const p of plugins) {
    if (!p.migrations) continue;
    const schema = ident('migrations schema', p.migrations.schema ?? DEFAULT_MIGRATIONS_SCHEMA);
    const table = ident('migrations table', p.migrations.table ?? defaultPluginTable(p.name));
    tracks.push({ name: p.name, folder: p.migrations.folder, schema, table });
  }
  const seen = new Map<string, string>();
  for (const t of tracks) {
    const key = `${t.schema}.${t.table}`;
    const owner = seen.get(key);
    if (owner) throw new Error(`migration tracks "${owner}" and "${t.name}" share the journal table ${key}; each track needs its own`);
    seen.set(key, t.name);
  }
  return tracks;
}

interface JournalEntry { tag: string; when: number }

export function readJournal(folder: string): JournalEntry[] {
  const path = join(folder, 'meta', '_journal.json');
  if (!existsSync(path)) throw new Error(`migration journal not found: ${path}`);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { entries?: JournalEntry[] };
  return parsed.entries ?? [];
}

export async function trackStatus(db: QueryLike, track: MigrationTrack): Promise<TrackStatus> {
  const entries = readJournal(track.folder);
  const exists = await db.query('SELECT to_regclass($1) AS reg', [`"${track.schema}"."${track.table}"`]);
  let lastApplied: number | null = null;
  if (exists.rows[0]?.reg) {
    const { rows } = await db.query(`SELECT created_at FROM "${track.schema}"."${track.table}" ORDER BY created_at DESC LIMIT 1`);
    const v = rows[0]?.created_at;
    lastApplied = v == null ? null : Number(v);
  }
  const pending = entries.filter((e) => lastApplied === null || lastApplied < e.when).map((e) => e.tag);
  return { track, journalEntries: entries.length, pending, lastApplied };
}

export class PendingMigrationsError extends Error {
  constructor(readonly statuses: TrackStatus[]) {
    super(
      `Refusing to serve: unapplied migrations — ${statuses.map((s) => `${s.track.name}: ${s.pending.join(', ')}`).join('; ')}. ` +
      `Run the migrate step (runMigrations from @sellright/api/ops) with the owner credential first.`,
    );
    this.name = 'PendingMigrationsError';
  }
}

/** Throws PendingMigrationsError when any track has unapplied migrations. Returns every track's status otherwise. */
export async function assertMigrationsCurrent(db: QueryLike, tracks: readonly MigrationTrack[]): Promise<TrackStatus[]> {
  const statuses: TrackStatus[] = [];
  for (const t of tracks) statuses.push(await trackStatus(db, t));
  const behind = statuses.filter((s) => s.pending.length > 0);
  if (behind.length > 0) throw new PendingMigrationsError(behind);
  return statuses;
}

export interface RunMigrationsOptions {
  /** OWNER credential (DDL rights). Never the runtime role. */
  databaseUrl: string;
  plugins?: readonly EnginePlugin[];
  engineFolder?: string;
  engineTable?: string | MigrationTableRef;
}

/** The migrate step: engine track first, then each plugin track, in plugin order. Returns what was applied. */
export async function runMigrations(options: RunMigrationsOptions): Promise<TrackStatus[]> {
  const tracks = resolveTracks(options.plugins ?? [], { folder: options.engineFolder, table: options.engineTable });
  const pool = new Pool({ connectionString: options.databaseUrl, max: 1, application_name: 'sellright-migrate' });
  const applied: TrackStatus[] = [];
  try {
    const db = drizzle(pool);
    for (const t of tracks) {
      const before = await trackStatus(pool, t);
      await migrate(db, { migrationsFolder: t.folder, migrationsSchema: t.schema, migrationsTable: t.table });
      applied.push(before);
    }
  } finally {
    await pool.end();
  }
  return applied;
}
