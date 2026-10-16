// Startup migration gate shared by both demo servers (interactive-server.mjs and the --read-only server.mjs). They build
// the legacy app (dist/app.js), which never verifies migrations itself, so without this a demo would start, listen and
// report healthy against an old schema. Same check and message as the stock entrypoint (packages/api/src/index.ts): the
// SDK's assertMigrationsCurrent over the engine track, read through the least-privilege journal probe, refusing with
// PendingMigrationsError. There is no skip: `node deploy/demo/run.mjs --migrate` (owner credential) is the only way to migrate.
export async function verifyDemoMigrations(pool, sdk) {
  const { assertMigrationsCurrent, resolveTracks } = sdk ?? await import('../../packages/api/dist/sdk/migrations.js');
  try {
    await assertMigrationsCurrent(pool, resolveTracks([]));
  } catch (error) {
    if (error?.name === 'PendingMigrationsError') console.error('Demo not started. Apply migrations first: node deploy/demo/run.mjs --migrate');
    throw error;
  }
}
