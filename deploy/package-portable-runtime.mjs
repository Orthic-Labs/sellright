// Assemble only in Core CI, after its frozen install, build, tests & package validation.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoots = new Set([
  'dist', 'drizzle', 'exports', 'package.json', 'BUILD-INFO.json',
  'README.md', 'LICENSE', 'LICENSE.md', 'LICENSE.txt',
]);
const required = [
  'package.json', 'BUILD-INFO.json', 'dist/index.js', 'dist/sdk/index.js',
  'dist/sdk/index.d.ts', 'dist/scripts/migrate.js', 'dist/scripts/bootstrap.js',
  'drizzle/meta/_journal.json', 'exports/contract.json',
];
const sourceFiles = ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', 'packages/api/package.json'];
const productionInstallArgs = [
  '--filter', '@sellright/api', 'install', '--prod', '--frozen-lockfile', '--offline', '--ignore-scripts',
  '--virtual-store-dir=packages/api/node_modules/.pnpm', '--config.enable-global-virtual-store=false',
  '--config.hoist-workspace-packages=false',
];
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const within = (root, path) => path === root || path.startsWith(`${root}${sep}`);
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertIdentity(info, sha) {
  invariant(/^[a-f0-9]{40}$/.test(sha ?? ''), 'expected full source commit SHA');
  invariant(info.sha === sha && info.dirty === false, 'runtime build identity mismatch');
}

export function assertFirstPartyPath(path) {
  const parts = path.split('/');
  invariant(parts.every((part) => part && part !== '..' && !part.startsWith('.') &&
    !['node_modules', 'test', 'tests', 'fixtures', '__tests__', '__mocks__'].includes(part)),
  `non-runtime first-party path: ${path}`);
  invariant(!/(?:\.test\.|\.spec\.|rls-test-utils\.|test-database-url\.|jws-fixture\.)/.test(path),
    `test code in first-party runtime: ${path}`);
}

// Python's stdlib tar reader is already used by this CI packaging step. Validate
// every member before writing; never let tar extraction interpret paths or links.
export function overlayPackedApi(apiTgz, runtime, sha) {
  execFileSync('python3', ['-c', String.raw`
import json, pathlib, sys, tarfile
archive, target, sha = sys.argv[1:]
root = pathlib.Path(target)
allowed = {'dist', 'drizzle', 'exports', 'package.json', 'BUILD-INFO.json', 'README.md', 'LICENSE', 'LICENSE.md', 'LICENSE.txt'}
with tarfile.open(archive, 'r:gz') as tar:
    members, seen = [], set()
    for member in tar.getmembers():
        name = member.name.rstrip('/')
        parts = name.split('/')
        assert parts[0] == 'package' and all(p and p not in {'.', '..'} for p in parts), 'unsafe package path'
        assert not any('\\' in p or ':' in p or '\x00' in p for p in parts), 'unsafe package path'
        assert member.isfile() or member.isdir(), 'unsafe package entry type'
        assert name not in seen, 'duplicate package member'
        seen.add(name)
        if len(parts) == 1:
            assert member.isdir(), 'unsafe package root'
            continue
        assert parts[1] in allowed, 'unexpected package content'
        members.append((member, parts[1:]))
    receipt = json.load(tar.extractfile('package/BUILD-INFO.json'))
    assert receipt.get('sha') == sha and receipt.get('dirty') is False, 'runtime build identity mismatch'
    for member, parts in members:
        dest = root.joinpath(*parts)
        assert not any(p.is_symlink() for p in [dest, *dest.parents]), 'unsafe extraction parent'
        if member.isdir():
            dest.mkdir(parents=True, exist_ok=True)
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            with dest.open('xb') as out:
                out.write(tar.extractfile(member).read())
            dest.chmod(0o755 if member.mode & 0o111 else 0o644)
`, resolve(apiTgz), resolve(runtime), sha], { stdio: ['ignore', 'pipe', 'pipe'] });
}

// lstat traversal never follows dependency directory links. realpath resolves
// complete link chains, including indirect escapes, dangling links & cycles.
export function validateRuntime(runtime, sha) {
  const root = realpathSync(runtime);
  const files = new Map();
  function visit(dir) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const local = relative(root, path).split(sep).join('/');
      const stat = lstatSync(path);
      const dependency = local === 'node_modules' || local.startsWith('node_modules/');
      if (!dependency && !local.startsWith('provenance/')) {
        invariant(packageRoots.has(local.split('/')[0]) || local === 'provenance', `unexpected runtime content: ${local}`);
        if (local !== 'provenance') assertFirstPartyPath(local);
      }
      if (stat.isSymbolicLink()) {
        invariant(dependency, `first-party symlink: ${local}`);
        const link = readlinkSync(path);
        invariant(!isAbsolute(link) && within(root, resolve(dirname(path), link)), `escaping dependency link: ${local}`);
        invariant(within(root, realpathSync(path)), `escaping dependency link chain: ${local}`);
        files.set(local, { symlink: link });
      } else if (stat.isDirectory()) visit(path);
      else {
        invariant(stat.isFile(), `unsafe runtime entry type: ${local}`);
        files.set(local, { sha256: sha256(path) });
      }
    }
  }
  visit(root);
  for (const path of required) invariant(files.has(path) && files.get(path).sha256, `missing runtime file: ${path}`);
  assertIdentity(json(join(root, 'BUILD-INFO.json')), sha);
  const pkg = json(join(root, 'package.json'));
  invariant(pkg.name === '@sellright/api', 'unexpected API package identity');
  invariant(lstatSync(join(root, 'node_modules')).isDirectory(), 'missing production dependency tree');
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    invariant(existsSync(join(root, 'node_modules', name, 'package.json')), `missing production dependency: ${name}`);
  }
  for (const name of Object.keys(pkg.devDependencies ?? {})) {
    invariant(name in (pkg.dependencies ?? {}) || !existsSync(join(root, 'node_modules', name)), `direct development dependency: ${name}`);
  }
  return files;
}

export function archiveRuntime(runtime, output) {
  const fd = openSync(output, 'wx', 0o644);
  try {
    // GNU tar on the Ubuntu Core runner: keep relative symlinks, turn inode
    // sharing into regular files, never emit device or external hard links.
    execFileSync('tar', ['--hard-dereference', '--owner=0', '--group=0', '-czf', '-', '-C', runtime, '.'],
      { stdio: ['ignore', fd, 'pipe'] });
  } finally { closeSync(fd); }
  execFileSync('python3', ['-c', String.raw`
import posixpath, sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as tar:
    for member in tar.getmembers():
        parts = member.name.split('/')
        assert not member.name.startswith('/') and '..' not in parts, 'unsafe runtime archive path'
        assert member.isfile() or member.isdir() or member.issym(), 'unsafe runtime archive type'
        if member.issym():
            target = posixpath.normpath(posixpath.join(posixpath.dirname(member.name), member.linkname))
            assert not member.linkname.startswith('/') and target != '..' and not target.startswith('../'), 'escaping runtime archive link'
`, resolve(output)], { stdio: ['ignore', 'pipe', 'pipe'] });
}

export function installProductionDependencies(repo, workspace, runtime, run = execFileSync) {
  const hashes = Object.fromEntries(sourceFiles.map((path) => [path, sha256(join(repo, path))]));
  mkdirSync(workspace);
  mkdirSync(join(workspace, 'packages/api'), { recursive: true });
  for (const path of sourceFiles) copyFileSync(join(repo, path), join(workspace, path), constants.COPYFILE_EXCL);
  // Legacy deploy disables frozen resolution & visits unrelated workspace peers.
  // Discover only API here, preserving the original importer paths, lock & policy.
  // Core's prior install owns allowed dependency builds; assembly runs no hooks.
  run('pnpm', productionInstallArgs, { cwd: workspace, stdio: 'inherit' });
  for (const path of sourceFiles) {
    invariant(sha256(join(repo, path)) === hashes[path], `source provenance changed: ${path}`);
    invariant(sha256(join(workspace, path)) === hashes[path], `staged provenance changed: ${path}`);
  }
  // Keep the virtual store inside API's node_modules & omit workspace self-links
  // so dependency links retain their relative targets when this directory moves.
  const modules = join(workspace, 'packages/api/node_modules');
  invariant(lstatSync(modules).isDirectory(), 'missing isolated production dependency tree');
  mkdirSync(runtime);
  renameSync(modules, join(runtime, 'node_modules'));
}

export function packagePortableRuntime(apiTgz, bundle, repo, sha) {
  assertIdentity({ sha, dirty: false }, sha);
  const sourceHashes = Object.fromEntries(sourceFiles.map((path) => [path, sha256(join(repo, path))]));
  const workspace = json(join(repo, 'package.json'));
  const pnpm = execFileSync('pnpm', ['--version'], { cwd: repo, encoding: 'utf8' }).trim();
  invariant(workspace.packageManager === `pnpm@${pnpm}`, 'pnpm toolchain identity mismatch');
  const apiHash = sha256(apiTgz);
  const output = join(bundle, 'api-runtime.tar.gz');
  const manifest = join(bundle, 'api-runtime-manifest.json');
  const demoOutput = join(bundle, 'demo-run.mjs');
  invariant(![output, manifest, demoOutput].some(existsSync), 'runtime artifact target already exists');
  const stage = mkdtempSync(join(dirname(resolve(bundle)), 'sellright-portable-'));
  const runtime = join(stage, 'api');
  try {
    installProductionDependencies(repo, join(stage, 'workspace'), runtime);
    for (const path of sourceFiles) invariant(sha256(join(repo, path)) === sourceHashes[path], `source provenance changed: ${path}`);
    overlayPackedApi(apiTgz, runtime, sha);
    invariant(sha256(apiTgz) === apiHash, 'validated API archive changed');
    mkdirSync(join(runtime, 'provenance'));
    copyFileSync(join(repo, 'pnpm-lock.yaml'), join(runtime, 'provenance', 'pnpm-lock.yaml'));
    copyFileSync(join(repo, 'pnpm-workspace.yaml'), join(runtime, 'provenance', 'pnpm-workspace.yaml'));
    const files = validateRuntime(runtime, sha);
    archiveRuntime(runtime, output);
    copyFileSync(join(repo, 'deploy/demo/run.mjs'), demoOutput, constants.COPYFILE_EXCL);
    writeFileSync(manifest, `${JSON.stringify({
      schema: 1, sha, dirty: false, node: process.version, pnpm,
      platform: process.platform, arch: process.arch,
      deployment: `isolated workspace: pnpm ${productionInstallArgs.join(' ')}`,
      sourceHashes, apiPackage: { file: 'sellright-api-0.1.0.tgz', sha256: apiHash },
      runtime: { file: 'api-runtime.tar.gz', sha256: sha256(output), entries: files.size },
      demoEntrypoint: { file: 'demo-run.mjs', sha256: sha256(demoOutput), restoreTo: 'deploy/demo/run.mjs' },
    }, null, 2)}\n`, { flag: 'wx' });
    console.log(`Packaged portable API runtime for ${sha} (${files.size} entries)`);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  invariant(process.argv.length === 4, 'usage: node deploy/package-portable-runtime.mjs API_TGZ BUNDLE_DIR');
  packagePortableRuntime(resolve(process.argv[2]), resolve(process.argv[3]), process.cwd(), process.env.GITHUB_SHA);
}
