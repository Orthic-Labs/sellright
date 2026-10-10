/**
 * `@sellright/api/ops` — operator-only surface: the migrate step and an explicit
 * OWNER-credential database factory. Never import this from request-serving code.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../db/schema.js';

export { runMigrations, resolveTracks, trackStatus, PendingMigrationsError, type RunMigrationsOptions, type MigrationTrack, type TrackStatus } from '../sdk/migrations.js';

export interface OwnerDb {
  db: ReturnType<typeof makeDb>;
  pool: Pool;
  close(): Promise<void>;
}

function makeDb(pool: Pool) {
  // MUST match drizzle.config.ts `casing: 'snake_case'`.
  return drizzle(pool, { schema, casing: 'snake_case' });
}

/**
 * Open an unscoped client with an explicit (owner) credential, for operator scripts
 * (mint licences, provision stores). Deliberately takes the URL as an argument: there is
 * no ambient/default credential, so a script cannot silently run as the runtime role.
 */
export function createOwnerDb(ownerDatabaseUrl: string, applicationName = 'sellright-ops'): OwnerDb {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 2, application_name: applicationName });
  return { db: makeDb(pool), pool, close: () => pool.end() };
}
