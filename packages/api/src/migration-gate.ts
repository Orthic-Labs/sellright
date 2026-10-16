/**
 * Startup migration gate for the stock server entrypoint (src/index.ts).
 *
 * The serving process refuses to boot while any migration track has unapplied entries (`verify`). The only way to
 * skip that check is the explicit literal below, meant solely for a migration-runner process that has to boot the app
 * against a schema it is about to migrate. A typo, `1`, or `true` does NOT skip it. Never set it on a serving process.
 */
export const SKIP_MIGRATION_VERIFY_ENV = 'SELLRIGHT_SKIP_MIGRATION_VERIFY';
export const SKIP_MIGRATION_VERIFY_VALUE = 'migration-runner';

export function migrationModeFromEnv(source: Record<string, string | undefined>): 'verify' | 'skip' {
  return source[SKIP_MIGRATION_VERIFY_ENV] === SKIP_MIGRATION_VERIFY_VALUE ? 'skip' : 'verify';
}
