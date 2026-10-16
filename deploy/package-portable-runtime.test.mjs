import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { archiveRuntime, assertFirstPartyPath, assertIdentity, installProductionDependencies, overlayPackedApi, validateRuntime } from './package-portable-runtime.mjs';

const sha = 'a'.repeat(40);
function temporaryDirectory(t) {
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'portable-api-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fixture(t) {
  const dir = temporaryDirectory(t);
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

function workspaceFixture(t) {
  const dir = temporaryDirectory(t);
  const repo = join(dir, 'repo');
  const put = (path, data) => {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), data);
  };
  put('package.json', JSON.stringify({
    name: 'workspace', private: true, packageManager: 'pnpm@11.25.0',
    devDependencies: { devonly: '1.0.0' }, scripts: { postinstall: 'must-not-run' },
  }));
  put('pnpm-workspace.yaml', 'packages:\n  - packages/*\nblockExoticSubdeps: true\noverrides:\n  fixture: 1.0.0\nallowBuilds:\n  fixture: true\n');
  put('pnpm-lock.yaml', `lockfileVersion: '9.0'\noverrides:\n  fixture: 1.0.0\nimporters:\n  .:\n    devDependencies:\n      devonly: {specifier: 1.0.0, version: 1.0.0}\n  packages/api:\n    dependencies:\n      fixture: {specifier: 1.0.0, version: 1.0.0}\n  packages/sample-plugin:\n    devDependencies:\n      '@sellright/api': {specifier: 'workspace:*', version: 'link:../api'}\n`);
  put('packages/api/package.json', JSON.stringify({
    name: '@sellright/api', version: '0.1.0', dependencies: { fixture: '1.0.0' },
    devDependencies: { devonly: '1.0.0' }, scripts: { prepare: 'must-not-run' },
  }));
  // This unrelated dev consumer triggered legacy deploy's registry self-fetch.
  put('packages/sample-plugin/package.json', JSON.stringify({
    name: '@sellright/sample-plugin', peerDependencies: { '@sellright/api': '0.1.0' },
    devDependencies: { '@sellright/api': 'workspace:*' },
  }));
  put('packages/api/dist/index.js', 'must-use-packed-bytes-instead');
  return { dir, repo, workspace: join(dir, 'workspace'), runtime: join(dir, 'runtime') };
}

test('production install isolates API while retaining exact frozen workspace policy & relocatable links', (t) => {
  const { repo, workspace, runtime } = workspaceFixture(t);
  let calls = 0;
  installProductionDependencies(repo, workspace, runtime, (command, args, options) => {
    calls++;
    assert.equal(command, 'pnpm');
    assert.deepEqual(args, [
      '--filter', '@sellright/api', 'install', '--prod', '--frozen-lockfile', '--offline', '--ignore-scripts',
      '--virtual-store-dir=packages/api/node_modules/.pnpm', '--config.enable-global-virtual-store=false',
      '--config.hoist-workspace-packages=false',
    ]);
    assert.equal(options.cwd, workspace);
    for (const path of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'packages/api/package.json']) {
      assert.deepEqual(readFileSync(join(workspace, path)), readFileSync(join(repo, path)));
    }
    assert.deepEqual(readdirSync(join(workspace, 'packages')), ['api']);
    assert.deepEqual(readdirSync(join(workspace, 'packages/api')), ['package.json']);
    const modules = join(workspace, 'packages/api/node_modules');
    const put = (path, data) => {
      mkdirSync(join(modules, path, '..'), { recursive: true });
      writeFileSync(join(modules, path), data);
    };
    put('.pnpm/fixture@1.0.0/node_modules/fixture/package.json', '{"name":"fixture","version":"1.0.0"}');
    put('.pnpm/transitive@1.0.0/node_modules/transitive/package.json', '{"name":"transitive","version":"1.0.0"}');
    symlinkSync('../../transitive@1.0.0/node_modules/transitive', join(modules, '.pnpm/fixture@1.0.0/node_modules/transitive'));
    symlinkSync('.pnpm/fixture@1.0.0/node_modules/fixture', join(modules, 'fixture'));
  });
  assert.equal(calls, 1);
  rmSync(workspace, { recursive: true });
  assert.equal(realpathSync(join(runtime, 'node_modules/fixture')), join(runtime, 'node_modules/.pnpm/fixture@1.0.0/node_modules/fixture'));
  assert.equal(realpathSync(join(runtime, 'node_modules/.pnpm/fixture@1.0.0/node_modules/transitive')), join(runtime, 'node_modules/.pnpm/transitive@1.0.0/node_modules/transitive'));
  assert.deepEqual(readdirSync(runtime), ['node_modules']);
  assert.equal(existsSync(join(runtime, 'node_modules/devonly')), false);
  assert.equal(existsSync(join(repo, 'node_modules')), false);
});

test('production install propagates missing pinned dependency failure without fallback', (t) => {
  const { repo, workspace, runtime } = workspaceFixture(t);
  const failure = new Error('ERR_PNPM_NO_OFFLINE_TARBALL: missing pinned fixture');
  let calls = 0;
  assert.throws(() => installProductionDependencies(repo, workspace, runtime, () => {
    calls++;
    throw failure;
  }), (error) => error === failure);
  assert.equal(calls, 1);
  assert.equal(existsSync(runtime), false);
});

for (const [label, target] of [['staged', 'workspace'], ['source', 'repo']]) {
  test(`reject ${label} provenance change during production install`, (t) => {
    const fixture = workspaceFixture(t);
    assert.throws(() => installProductionDependencies(fixture.repo, fixture.workspace, fixture.runtime, () => {
      writeFileSync(join(fixture[target], 'pnpm-lock.yaml'), 'modified lockfile');
    }), new RegExp(`${label} provenance changed: pnpm-lock.yaml`));
    assert.equal(existsSync(fixture.runtime), false);
  });
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

for (const directory of ['dist/scripts', 'dist/nested', 'drizzle', 'exports']) {
  for (const basename of ['seed-e2e-catalog', 'entitlement-policy.fork-reference.testkit']) {
    for (const extension of ['js', 'js.map', 'd.ts']) {
      const path = `${directory}/${basename}.${extension}`;
      test(`reject compiled fixture ${path} in first-party runtime`, (t) => {
        const { runtime, put } = fixture(t);
        assert.throws(() => assertFirstPartyPath(path), /test code/);
        put(path, 'throw Error("must not ship")');
        assert.throws(() => validateRuntime(runtime, sha), /test code/);
      });
    }
  }
}

test('allow production runtime scripts', () => {
  for (const script of ['migrate', 'bootstrap', 'functional-check', 'seed-demo']) {
    assert.doesNotThrow(() => assertFirstPartyPath(`dist/scripts/${script}.js`));
  }
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
