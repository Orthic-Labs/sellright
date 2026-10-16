import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyDemoMigrations } from './migration-gate.mjs';

class PendingMigrationsError extends Error {
  constructor() { super('Refusing to serve: unapplied migrations — engine: 0100_x.'); this.name = 'PendingMigrationsError'; }
}
const sdk = (assertMigrationsCurrent) => ({ assertMigrationsCurrent, resolveTracks: (plugins) => [{ name: 'engine', plugins }] });

test('verifies the engine track with the demo pool and resolves when current', async () => {
  const pool = {};
  const seen = [];
  await verifyDemoMigrations(pool, sdk(async (db, tracks) => { seen.push([db, tracks]); }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], pool);
  assert.deepEqual(seen[0][1], [{ name: 'engine', plugins: [] }]);
});

test('refuses with the SDK message (unchanged) when migrations are pending', async () => {
  await assert.rejects(verifyDemoMigrations({}, sdk(async () => { throw new PendingMigrationsError(); })), (error) => {
    assert.equal(error.name, 'PendingMigrationsError');
    assert.match(error.message, /^Refusing to serve: unapplied migrations/);
    return true;
  });
});

test('any other verification failure (e.g. journal unreadable) also refuses', async () => {
  await assert.rejects(verifyDemoMigrations({}, sdk(async () => { throw Object.assign(new Error('permission denied'), { code: '42501' }); })), /permission denied/);
});

test('both servers await the gate after the pool import and before they write, build the app or listen', () => {
  const firstWrite = { 'interactive-server.mjs': 'ensureDemoSeedAssets(assetDir)', 'server.mjs': 'createApp()' };
  for (const file of ['interactive-server.mjs', 'server.mjs']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const gate = src.indexOf('await verifyDemoMigrations(pool)');
    assert.ok(gate > -1, `${file} must await verifyDemoMigrations(pool)`);
    assert.ok(gate > src.search(/await import\('..\/..\/packages\/api\/dist\/db\/client\.js'\)/), `${file}: gate after the pool import`);
    assert.ok(gate < src.indexOf(firstWrite[file]), `${file}: gate before ${firstWrite[file]}`);
    assert.ok(gate < src.indexOf('createApp()'), `${file}: gate before createApp()`);
    assert.ok(gate < src.indexOf('.listen('), `${file}: gate before listen`);
  }
});

test('run.mjs keeps --migrate as the migration path and starts the servers without skipping the gate', () => {
  const src = readFileSync(new URL('run.mjs', import.meta.url), 'utf8');
  assert.match(src, /--migrate/);
  assert.doesNotMatch(src, /SKIP_MIGRATION_VERIFY/);
});
