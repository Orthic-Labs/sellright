import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { archiveRuntime, assertFirstPartyPath, assertIdentity, overlayPackedApi, validateRuntime } from './package-portable-runtime.mjs';

const sha = 'a'.repeat(40);
function fixture(t) {
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'portable-api-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = join(dir, 'api');
  mkdirSync(runtime);
  const put = (path, data) => {
    mkdirSync(join(runtime, path, '..'), { recursive: true });
    writeFileSync(join(runtime, path), data);
  };
  for (const path of ['dist/index.js', 'dist/sdk/index.js', 'dist/sdk/index.d.ts',
    'dist/scripts/migrate.js', 'dist/scripts/bootstrap.js', 'drizzle/meta/_journal.json', 'exports/contract.json']) put(path, '{}');
  put('BUILD-INFO.json', JSON.stringify({ sha, dirty: false }));
  put('package.json', JSON.stringify({ name: '@sellright/api', dependencies: { fixture: '1.0.0' }, devDependencies: { devonly: '1.0.0' } }));
  put('node_modules/.pnpm/fixture@1.0.0/node_modules/fixture/package.json', JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  symlinkSync('.pnpm/fixture@1.0.0/node_modules/fixture', join(runtime, 'node_modules/fixture'));
  return { dir, runtime, put };
}

test('valid production graph & archive preserve internal dependency symlinks', (t) => {
  const { dir, runtime } = fixture(t);
  const files = validateRuntime(runtime, sha);
  assert.equal(files.get('node_modules/fixture').symlink, '.pnpm/fixture@1.0.0/node_modules/fixture');
  const archive = join(dir, 'api.tar.gz');
  archiveRuntime(runtime, archive);
  const link = execFileSync('python3', ['-c',
    "import sys,tarfile; t=tarfile.open(sys.argv[1]); print(t.getmember('./node_modules/fixture').linkname)", archive], { encoding: 'utf8' }).trim();
  assert.equal(link, '.pnpm/fixture@1.0.0/node_modules/fixture');
  assert.throws(() => archiveRuntime(runtime, archive), /EEXIST/);
});

for (const [label, target] of [['escape', '../../outside'], ['absolute', '/tmp'], ['broken', '.pnpm/missing'], ['cycle', 'bad']]) {
  test(`reject ${label} dependency symlink`, (t) => {
    const { runtime } = fixture(t);
    symlinkSync(target, join(runtime, 'node_modules/bad'));
    assert.throws(() => validateRuntime(runtime, sha));
  });
}

test('reject indirect symlink escape', (t) => {
  const { runtime } = fixture(t);
  symlinkSync('../../../outside', join(runtime, 'node_modules/.pnpm/bad'));
  symlinkSync('.pnpm/bad', join(runtime, 'node_modules/bad'));
  assert.throws(() => validateRuntime(runtime, sha));
});

test('reject first-party test, mock & development helper code', (t) => {
  const { runtime, put } = fixture(t);
  for (const path of ['dist/sdk/index.test.js', 'dist/__mocks__/db.js', 'dist/db/rls-test-utils.js',
    'dist/db/test-database-url.js', 'dist/licensing/storekit/jws-fixture.js']) {
    assert.throws(() => assertFirstPartyPath(path), /test code|non-runtime/);
  }
  put('dist/sdk/index.test.js', 'throw Error("must not ship")');
  assert.throws(() => validateRuntime(runtime, sha), /test code/);
});

test('reject source identity mismatch, dirty build & direct dev dependency', (t) => {
  const { runtime, put } = fixture(t);
  assert.throws(() => assertIdentity({ sha: 'b'.repeat(40), dirty: false }, sha), /identity mismatch/);
  put('BUILD-INFO.json', JSON.stringify({ sha, dirty: true }));
  assert.throws(() => validateRuntime(runtime, sha), /identity mismatch/);
  put('BUILD-INFO.json', JSON.stringify({ sha, dirty: false }));
  put('node_modules/devonly/package.json', '{}');
  assert.throws(() => validateRuntime(runtime, sha), /development dependency/);
});

function packedFixture(dir, member = 'package/dist/index.js', kind = 'file', identity = sha) {
  const archive = join(dir, 'packed.tgz');
  execFileSync('python3', ['-c', String.raw`
import io, json, sys, tarfile
archive, name, kind, sha = sys.argv[1:]
with tarfile.open(archive, 'w:gz') as tar:
    for path, data in [('package/BUILD-INFO.json', json.dumps({'sha': sha, 'dirty': False}).encode()), (name, b'export const exact = 42;\n')]:
        entry = tarfile.TarInfo(path)
        if kind == 'link' and path == name:
            entry.type = tarfile.SYMTYPE
            entry.linkname = '../../escape'
            tar.addfile(entry)
        else:
            entry.size = len(data)
            tar.addfile(entry, io.BytesIO(data))
`, archive, member, kind, identity]);
  return archive;
}

test('overlay preserves exact API package bytes', (t) => {
  const { dir } = fixture(t);
  const overlay = join(dir, 'overlay');
  mkdirSync(overlay);
  overlayPackedApi(packedFixture(dir), overlay, sha);
  assert.equal(readFileSync(join(overlay, 'dist/index.js'), 'utf8'), 'export const exact = 42;\n');
});

for (const [label, member, kind, identity] of [
  ['traversal', 'package/../../escape', 'file', sha],
  ['absolute', '/package/escape', 'file', sha],
  ['symlink', 'package/dist/index.js', 'link', sha],
  ['identity', 'package/dist/index.js', 'file', 'b'.repeat(40)],
]) {
  test(`reject ${label} in packed API before extraction`, (t) => {
    const { dir } = fixture(t);
    const overlay = join(dir, 'overlay');
    mkdirSync(overlay);
    assert.throws(() => overlayPackedApi(packedFixture(dir, member, kind, identity), overlay, sha));
    assert.throws(() => readFileSync(join(overlay, 'BUILD-INFO.json')), /ENOENT/);
  });
}
