/**
 * Migration run lock (DB-H1) and DDL lock timeout (DB-L2).
 *
 * drizzle's migrator picks pending files by comparing timestamps and takes no lock, so two overlapping runs (two
 * deploy scripts, a retry while the first still runs) could both start the same file. BOTH runners (sdk/migrations.ts
 * runMigrations and scripts/migrate.ts) therefore hold ONE session-level advisory lock, on a dedicated connection,
 * for the whole run and release it in `finally`. A second run polls `pg_try_advisory_lock` (never a blocking
 * `pg_advisory_lock`: a blocked advisory wait is itself cut off by lock_timeout / statement_timeout) and logs that it
 * is waiting, then proceeds once the first run is done. Session-level, so a crashed runner frees it when its
 * connection dies.
 *
 * DDL inside the run gets lock_timeout = 5 s (set as a startup option on the migration pool), so a migration that
 * cannot get its table lock fails fast with a clear message instead of queueing behind a long transaction and
 * blocking every request that queues behind it. statement_timeout is deliberately left as the operator set it (the
 * ops wrapper sets it to 0; this module never touches it).
 */

/** Fixed key shared by every migration runner: ASCII "SRMIGR" as a bigint. */
export const MIGRATION_ADVISORY_LOCK_KEY = 0x53524d494752n;
export const MIGRATION_LOCK_TIMEOUT_MS = 5_000;
/** Postgres startup option for the migration pool's connections. */
export const MIGRATION_SESSION_OPTIONS = `-c lock_timeout=${MIGRATION_LOCK_TIMEOUT_MS}`;
export const MIGRATION_LOCK_POLL_MS = 2_000;
export const MIGRATION_LOCK_MAX_WAIT_MS = 15 * 60_000;
const LOCK_NOT_AVAILABLE = '55P03';

export interface LockClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface MigrationLockOptions {
  log?: (message: string) => void;
  pollMs?: number;
  /** Give up waiting for another run after this long (default 15 min). */
  maxWaitMs?: number;
  /** Test hooks. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Run `fn` while this connection holds the migration advisory lock; released in `finally`. */
export async function withMigrationLock<T>(client: LockClientLike, fn: () => Promise<T>, opts: MigrationLockOptions = {}): Promise<T> {
  const log = opts.log ?? (() => undefined);
  const pollMs = opts.pollMs ?? MIGRATION_LOCK_POLL_MS;
  const maxWaitMs = opts.maxWaitMs ?? MIGRATION_LOCK_MAX_WAIT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const key = MIGRATION_ADVISORY_LOCK_KEY.toString();

  const started = now();
  let announced = false;
  for (;;) {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key]);
    if (rows[0]?.locked === true) break;
    if (!announced) {
      log('[migrate] another migration run holds the migration lock; waiting for it to finish');
      announced = true;
    }
    if (now() - started >= maxWaitMs) {
      throw new Error(`timed out after ${Math.round(maxWaitMs / 1000)}s waiting for another migration run to release the migration lock (advisory key ${key})`);
    }
    await sleep(pollMs);
  }
  if (announced) log(`[migrate] migration lock acquired after ${now() - started}ms`);
  try {
    return await fn();
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
    } catch (e) {
      // The caller closes this connection next, which releases a session lock anyway.
      log(`[migrate] could not release the migration lock explicitly (${(e as Error).message}); closing the connection releases it`);
    }
  }
}

/** Turn a lock_timeout failure (SQLSTATE 55P03) into an actionable message; every other error is returned as is. */
export function explainMigrationError(e: unknown): unknown {
  const code = (e as { code?: string } | null)?.code;
  if (code !== LOCK_NOT_AVAILABLE) return e;
  const err = new Error(
    `migration DDL could not get its lock within ${MIGRATION_LOCK_TIMEOUT_MS / 1000}s (lock_timeout): another session holds a conflicting lock on the table. ` +
    `Nothing was half-applied by this statement; find the blocker (pg_stat_activity / pg_locks), let it finish, and re-run the migration. Cause: ${(e as Error).message}`,
    { cause: e },
  );
  err.name = 'MigrationLockTimeoutError';
  return err;
}
