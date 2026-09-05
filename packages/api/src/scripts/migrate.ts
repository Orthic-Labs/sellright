import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { pool, unsafeUnscopedDb } from '../db/client.js';

/**
 * Production migration entrypoint that uses drizzle-orm itself, not drizzle-kit
 * or tsx. It is compiled with the API and therefore needs only production
 * dependencies at runtime. The deployment image/service must ship the drizzle/
 * directory beside dist/.
 */
async function main(): Promise<void> {
  const migrationsFolder = process.env.MIGRATIONS_DIR
    ?? fileURLToPath(new URL('../../drizzle', import.meta.url));

  console.log(`[migrate] applying migrations from ${migrationsFolder}`);
  await migrate(unsafeUnscopedDb, { migrationsFolder });
  console.log('[migrate] database is up to date');
}

main()
  .catch((error) => {
    console.error('[migrate] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
