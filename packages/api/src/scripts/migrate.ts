import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { getEnv } from '../env.js';
import { explainMigrationError, MIGRATION_SESSION_OPTIONS, withMigrationLock } from '../db/migration-lock.js';

/**
 * Production migration entrypoint that uses drizzle-orm itself, not drizzle-kit
 * or tsx. It is compiled with the API and therefore needs only production
 * dependencies at runtime. The deployment image/service must ship the drizzle/
 * directory beside dist/.
 *
 * Holds the shared migration advisory lock on a dedicated connection for the whole run (DB-H1; a concurrent run
 * waits and logs) and runs DDL under lock_timeout=5s (DB-L2). Own two-connection pool: it must not depend on the
 * request pool's 30 s statement_timeout or its sizing. Same helper as sdk/migrations.ts runMigrations.
 */
async function main(): Promise<void> {
  const migrationsFolder = process.env.MIGRATIONS_DIR
    ?? fileURLToPath(new URL('../../drizzle', import.meta.url));

  console.log(`[migrate] applying migrations from ${migrationsFolder}`);
  const pool = new Pool({ connectionString: getEnv().DATABASE_URL, max: 2, application_name: 'sellright-migrate', options: MIGRATION_SESSION_OPTIONS });
  const lockClient = await pool.connect();
  try {
    await withMigrationLock(lockClient, () => migrate(drizzle(pool), { migrationsFolder }), { log: (m) => console.log(m) });
  } catch (e) {
    throw explainMigrationError(e);
  } finally {
    lockClient.release();
    await pool.end().catch(() => undefined);
  }
  console.log('[migrate] database is up to date');
}

main()
  .catch((error) => {
    console.error('[migrate] failed', error);
    process.exitCode = 1;
  });
