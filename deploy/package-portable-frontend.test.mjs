import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  archiveFrontendRuntime, installFrontendProductionDependencies, overlayFrontendOutputs,
  productionInstallArgs, sourceFiles, validateFrontendRuntime,
} from './package-portable-frontend.mjs';

const sha = 'a'.repeat(40);
function fixture(t) {
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'portable-frontend-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const put = (local, data = '{}') => {
    mkdirSync(join(repo, local, '..'), { recursive: true });
    writeFileSync(join(repo, local), data);
  };
  put('package.json', JSON.stringify({ private: true, packageManager: 'pnpm@11.25.0',
    scripts: { postinstall: 'must-not-run' }, devDependencies: { rootdev: '1.0.0' } }));
  put('pnpm-workspace.yaml', 'packages:\n  - packages/*\nblockExoticSubdeps: true\noverrides:\n  express: 5.3.0\nallowBuilds:\n  express: true\n');
  put('pnpm-lock.yaml', `lockfileVersion: '9.0'\noverrides:\n  express: 5.3.0\nimporters:\n  .:\n    devDependencies:\n      rootdev: {specifier: 1.0.0, version: 1.0.0}\n  packages/storefront:\n    dependencies:\n      express: {specifier: 5.3.0, version: 5.3.0}\n      '@sellright/storefront-client': {specifier: 'workspace:*', version: 'link:../storefront-client'}\n  packages/storefront-client:\n    dependencies:\n      openapi-fetch: {specifier: 0.17.0, version: 0.17.0}\n  packages/sample-plugin:\n    devDependencies:\n      '@sellright/api': {specifier: 'workspace:*', version: 'link:../api'}\n`);
  put('packages/storefront/package.json', JSON.stringify({ name: '@sellright/storefront', type: 'module',
    dependencies: { express: '5.3.0', '@sellright/storefront-client': 'workspace:*' },
    devDependencies: { devonly: '1.0.0' }, scripts: { prepare: 'must-not-run' } }));
  put('packages/storefront-client/package.json', JSON.stringify({ name: '@sellright/storefront-client', type: 'module',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    dependencies: { 'openapi-fetch': '0.17.0' }, devDependencies: { clientdev: '1.0.0' } }));
  put('packages/sample-plugin/package.json', JSON.stringify({ name: '@sellright/sample-plugin',
    peerDependencies: { '@sellright/api': '0.1.0' }, devDependencies: { '@sellright/api': 'workspace:*' } }));
  put('packages/storefront/src/private.ts', 'must-not-ship');
  put('packages/storefront/scripts/build.mjs', 'must-not-run');
  put('packages/storefront/adapters/express/vite.config.mts', 'must-not-ship');
  for (const local of ['packages/storefront/server-demo/entry.express.js', 'packages/storefront/dist-demo/q-manifest.json',
    'packages/storefront/dist-demo/build/q-123.js', 'packages/storefront-client/dist/index.js',
    'packages/storefront-client/dist/index.d.ts', 'packages/admin/dist-demo/admin-static/index-123.js']) put(local, 'compiled-bytes');
  put('packages/admin/dist-demo/index.html', '<script type="module" src="/admin/admin-static/index-123.js"></script>');
  put('packages/admin/dist-demo/BUILD-INFO.json', JSON.stringify({ sha, dirty: false }));
  put('deploy/demo/run-storefront.mjs', 'export const launcher = "verified-demo";\n');
  return { dir, repo, put, workspace: join(dir, 'workspace'), runtime: join(dir, 'runtime') };
}
function fakeInstall(workspace) {
  const put = (local, data) => {
    mkdirSync(join(workspace, local, '..'), { recursive: true });
    writeFileSync(join(workspace, local), data);
  };
  put('node_modules/.pnpm/express@5.3.0/node_modules/express/package.json', '{"name":"express","version":"5.3.0"}');
  put('node_modules/.pnpm/openapi-fetch@0.17.0/node_modules/openapi-fetch/package.json', '{"name":"openapi-fetch","version":"0.17.0"}');
  mkdirSync(join(workspace, 'packages/storefront/node_modules/@sellright'), { recursive: true });
  mkdirSync(join(workspace, 'packages/storefront-client/node_modules'), { recursive: true });
  symlinkSync('../../../node_modules/.pnpm/express@5.3.0/node_modules/express', join(workspace, 'packages/storefront/node_modules/express'));
  symlinkSync('../../../storefront-client', join(workspace, 'packages/storefront/node_modules/@sellright/storefront-client'));
  symlinkSync('../../../node_modules/.pnpm/openapi-fetch@0.17.0/node_modules/openapi-fetch', join(workspace, 'packages/storefront-client/node_modules/openapi-fetch'));
}
function assembled(t) {
  const f = fixture(t);
  installFrontendProductionDependencies(f.repo, f.workspace, f.runtime, (_command, _args, options) => fakeInstall(options.cwd));
  overlayFrontendOutputs(f.repo, f.runtime, sha);
  const putRuntime = (local, data = '{}') => {
    mkdirSync(join(f.runtime, local, '..'), { recursive: true });
    writeFileSync(join(f.runtime, local), data);
  };
  return { ...f, putRuntime };
}

test('isolated frozen offline install retains five source files & relocatable workspace client', (t) => {
  const f = fixture(t);
  let calls = 0;
  const hashes = installFrontendProductionDependencies(f.repo, f.workspace, f.runtime, (command, args, options) => {
    calls++;
    assert.equal(command, 'pnpm');
    assert.deepEqual(args, ['--filter', '@sellright/storefront...', 'install', '--prod', '--frozen-lockfile', '--offline', '--ignore-scripts',
      '--virtual-store-dir=node_modules/.pnpm', '--config.enable-global-virtual-store=false', '--config.hoist-workspace-packages=false']);
    assert.deepEqual(args, productionInstallArgs);
    assert.equal(options.cwd, f.workspace);
    assert.deepEqual(readdirSync(join(f.workspace, 'packages')).sort(), ['storefront', 'storefront-client']);
    for (const local of sourceFiles) assert.deepEqual(readFileSync(join(f.workspace, local)), readFileSync(join(f.repo, local)));
    assert.deepEqual(readdirSync(join(f.workspace, 'packages/storefront')), ['package.json']);
    assert.deepEqual(readdirSync(join(f.workspace, 'packages/storefront-client')), ['package.json']);
    fakeInstall(options.cwd);
  });
  assert.equal(calls, 1);
  assert.equal(Object.keys(hashes).length, 5);
  for (const local of sourceFiles) assert.deepEqual(readFileSync(join(f.runtime, local)), readFileSync(join(f.repo, local)));
  const relocated = join(f.dir, 'relocated');
  renameSync(f.runtime, relocated);
  rmSync(f.workspace, { recursive: true });
  rmSync(f.repo, { recursive: true });
  assert.equal(realpathSync(join(relocated, 'packages/storefront/node_modules/express')), join(relocated, 'node_modules/.pnpm/express@5.3.0/node_modules/express'));
  assert.equal(realpathSync(join(relocated, 'packages/storefront/node_modules/@sellright/storefront-client')), join(relocated, 'packages/storefront-client'));
  assert.equal(realpathSync(join(relocated, 'packages/storefront-client/node_modules/openapi-fetch')), join(relocated, 'node_modules/.pnpm/openapi-fetch@0.17.0/node_modules/openapi-fetch'));
});

test('missing offline dependency fails once without deploy or mutable fallback', (t) => {
  const f = fixture(t);
  const failure = new Error('ERR_PNPM_NO_OFFLINE_TARBALL');
  let calls = 0;
  assert.throws(() => installFrontendProductionDependencies(f.repo, f.workspace, f.runtime, () => { calls++; throw failure; }), (error) => error === failure);
  assert.equal(calls, 1);
  assert.equal(existsSync(f.runtime), false);
});
for (const local of sourceFiles) {
  for (const [label, target] of [['source', 'repo'], ['staged', 'workspace']]) {
    test(`reject ${label} provenance mutation: ${local}`, (t) => {
      const f = fixture(t);
      assert.throws(() => installFrontendProductionDependencies(f.repo, f.workspace, f.runtime, () => {
        writeFileSync(join(f[target], local), 'mutated');
      }), new RegExp(`${label} provenance changed: ${local.replaceAll('.', '\\.').replaceAll('/', '\\/')}`));
      assert.equal(existsSync(f.runtime), false);
    });
  }
}

test('overlay copies exact compiled bytes, excludes client tests & ships only runtime roots', (t) => {
  const f = fixture(t);
  const excluded = ['index.test.js', 'request.spec.d.ts', 'helpers.testkit.js', 'fixtures/payload.js', '__mocks__/fetch.js', 'mock/request.js',
    ...['gateway-e2e-safety', 'fork-reference-policy.kit'].flatMap((basename) => ['js', 'js.map', 'd.ts'].map((extension) => `${basename}.${extension}`))];
  for (const local of excluded) {
    f.put(`packages/storefront-client/dist/${local}`, 'must-not-ship');
  }
  installFrontendProductionDependencies(f.repo, f.workspace, f.runtime, (_command, _args, options) => fakeInstall(options.cwd));
  overlayFrontendOutputs(f.repo, f.runtime, sha);
  const files = validateFrontendRuntime(f.runtime, sha);
  for (const local of excluded) {
    assert.equal(files.has(`packages/storefront-client/dist/${local}`), false);
  }
  for (const local of ['packages/storefront/server-demo/entry.express.js', 'packages/storefront-client/dist/index.js',
    'packages/storefront-client/dist/index.d.ts', 'packages/admin/dist-demo/index.html', 'deploy/demo/run-storefront.mjs']) {
    assert.deepEqual(readFileSync(join(f.runtime, local)), readFileSync(join(f.repo, local)));
  }
  assert.deepEqual(readdirSync(join(f.runtime, 'packages/storefront')).sort(), ['dist-demo', 'node_modules', 'package.json', 'server-demo']);
});

test('overlay preserves exact public security.txt bytes through its narrow dot-directory exception', (t) => {
  const f = fixture(t);
  const local = 'packages/storefront/dist-demo/.well-known/security.txt';
  const bytes = Buffer.from('Contact: mailto:security@example.invalid\r\nExpires: 2027-10-01T00:00:00Z\n');
  f.put(local, bytes);
  installFrontendProductionDependencies(f.repo, f.workspace, f.runtime, (_command, _args, options) => fakeInstall(options.cwd));
  overlayFrontendOutputs(f.repo, f.runtime, sha);
  assert.deepEqual(readFileSync(join(f.runtime, local)), bytes);
  assert.ok(validateFrontendRuntime(f.runtime, sha).get(local)?.sha256);
});
for (const local of ['packages/storefront/dist-demo/.well-known/unexpected.txt',
  'packages/storefront/dist-demo/.well-known/.env', 'packages/storefront/dist-demo/.env',
  'packages/storefront/dist-demo/.other/security.txt', 'packages/storefront/server-demo/.well-known/security.txt']) {
  test(`reject unapproved public dot-path during copy & output validation: ${local}`, (t) => {
    const f = fixture(t);
    f.put(local, 'must-not-ship');
    installFrontendProductionDependencies(f.repo, f.workspace, f.runtime, (_command, _args, options) => fakeInstall(options.cwd));
    assert.throws(() => overlayFrontendOutputs(f.repo, f.runtime, sha), /non-runtime first-party path/);
    const valid = assembled(t);
    valid.putRuntime(local, 'must-not-ship');
    assert.throws(() => validateFrontendRuntime(valid.runtime, sha), /non-runtime first-party path/);
  });
}
for (const local of ['packages/storefront/dist-demo/.well-known', 'packages/storefront/dist-demo/.well-known/security.txt']) {
  test(`public security asset exception rejects symlinks during copy & validation: ${local}`, (t) => {
    const f = fixture(t);
    mkdirSync(join(f.repo, local, '..'), { recursive: true });
    symlinkSync(join(f.repo, 'packages/storefront/package.json'), join(f.repo, local));
    installFrontendProductionDependencies(f.repo, f.workspace, f.runtime, (_command, _args, options) => fakeInstall(options.cwd));
    assert.throws(() => overlayFrontendOutputs(f.repo, f.runtime, sha), /unsafe compiled entry/);
    const valid = assembled(t);
    mkdirSync(join(valid.runtime, local, '..'), { recursive: true });
    symlinkSync(join(valid.runtime, 'packages/storefront/package.json'), join(valid.runtime, local));
    assert.throws(() => validateFrontendRuntime(valid.runtime, sha), /first-party symlink/);
  });
}

test('archive retains workspace link after relocation & validates every staged byte', (t) => {
  const f = assembled(t);
  validateFrontendRuntime(f.runtime, sha);
  const archive = join(f.dir, 'frontend.tar.gz');
  archiveFrontendRuntime(f.runtime, archive);
  const link = execFileSync('python3', ['-c', "import sys,tarfile; t=tarfile.open(sys.argv[1]); print(t.getmember('./packages/storefront/node_modules/@sellright/storefront-client').linkname)", archive], { encoding: 'utf8' }).trim();
  assert.equal(link, '../../../storefront-client');
  assert.throws(() => archiveFrontendRuntime(f.runtime, archive), /EEXIST/);
});
test('archive postvalidation rejects escaping link without extraction', (t) => {
  const f = assembled(t);
  symlinkSync('../../outside', join(f.runtime, 'node_modules/bad'));
  assert.throws(() => archiveFrontendRuntime(f.runtime, join(f.dir, 'unsafe.tar.gz')), /escaping frontend archive link/);
});
for (const [label, target] of [['escape', '../../outside'], ['absolute', '/tmp'], ['dangling', '.pnpm/missing'], ['cycle', 'bad'], ['directory cycle', '.']]) {
  test(`reject ${label} dependency link`, (t) => {
    const f = assembled(t);
    symlinkSync(target, join(f.runtime, 'node_modules/bad'));
    assert.throws(() => validateFrontendRuntime(f.runtime, sha));
  });
}
test('reject indirect dependency link escape', (t) => {
  const f = assembled(t);
  symlinkSync('../../../outside', join(f.runtime, 'node_modules/.pnpm/escape'));
  symlinkSync('.pnpm/escape', join(f.runtime, 'node_modules/bad'));
  assert.throws(() => validateFrontendRuntime(f.runtime, sha));
});
test('reject first-party source symlink rather than copying its target', (t) => {
  const f = fixture(t);
  rmSync(join(f.repo, 'packages/storefront-client/dist/index.js'));
  symlinkSync('../package.json', join(f.repo, 'packages/storefront-client/dist/index.js'));
  installFrontendProductionDependencies(f.repo, f.workspace, f.runtime, (_command, _args, options) => fakeInstall(options.cwd));
  assert.throws(() => overlayFrontendOutputs(f.repo, f.runtime, sha), /unsafe compiled entry/);
});
for (const local of ['packages/storefront-client/dist/index.test.js', 'packages/storefront-client/dist/mocks/fetch.js',
  ...['gateway-e2e-safety', 'fork-reference-policy.kit'].flatMap((basename) => ['js', 'js.map', 'd.ts'].map((extension) => `packages/storefront-client/dist/${basename}.${extension}`)),
  'packages/storefront/server-demo/entry.testkit.js', 'packages/storefront/src/private.ts', 'deploy/demo/unexpected.mjs']) {
  test(`reject unexpected output: ${local}`, (t) => {
    const f = assembled(t);
    f.putRuntime(local);
    assert.throws(() => validateFrontendRuntime(f.runtime, sha), /test code|non-runtime|unexpected frontend/);
  });
}
for (const local of ['packages/storefront/server-demo/entry.express.js', 'packages/storefront/dist-demo/q-manifest.json',
  'packages/storefront-client/dist/index.d.ts', 'packages/admin/dist-demo/index.html',
  'packages/storefront/dist-demo/build/q-123.js', 'packages/admin/dist-demo/admin-static/index-123.js']) {
  test(`reject missing compiled output: ${local}`, (t) => {
    const f = assembled(t);
    rmSync(join(f.runtime, local));
    assert.throws(() => validateFrontendRuntime(f.runtime, sha), /missing frontend|missing storefront|missing admin/);
  });
}
test('reject dirty or mismatched identity & admin assets built for wrong base', (t) => {
  const f = assembled(t);
  f.putRuntime('BUILD-INFO.json', JSON.stringify({ sha, dirty: true }));
  assert.throws(() => validateFrontendRuntime(f.runtime, sha), /identity mismatch/);
  f.putRuntime('BUILD-INFO.json', JSON.stringify({ sha: 'b'.repeat(40), dirty: false }));
  assert.throws(() => validateFrontendRuntime(f.runtime, sha), /identity mismatch/);
  f.putRuntime('BUILD-INFO.json', JSON.stringify({ sha, dirty: false }));
  f.putRuntime('packages/admin/dist-demo/index.html', '<script src="/admin-static/wrong.js"></script>');
  assert.throws(() => validateFrontendRuntime(f.runtime, sha), /\/admin\/admin-static/);
});
for (const local of ['node_modules/rootdev/package.json', 'packages/storefront/node_modules/devonly/package.json', 'node_modules/clientdev/package.json']) {
  test(`reject direct development dependency at import root: ${local}`, (t) => {
    const f = assembled(t);
    f.putRuntime(local);
    assert.throws(() => validateFrontendRuntime(f.runtime, sha), /direct development dependency/);
  });
}
test('dependency also declared for production remains permitted at import root', (t) => {
  const f = assembled(t);
  const local = 'packages/storefront/package.json';
  const pkg = JSON.parse(readFileSync(join(f.runtime, local), 'utf8'));
  pkg.devDependencies.express = pkg.dependencies.express;
  f.putRuntime(local, JSON.stringify(pkg));
  assert.doesNotThrow(() => validateFrontendRuntime(f.runtime, sha));
});
