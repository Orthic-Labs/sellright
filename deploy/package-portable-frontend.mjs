// Assemble only after Core CI's frozen install, build & tests have passed.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFirstPartyPath, assertIdentity } from './package-portable-runtime.mjs';

export const sourceFiles = [
  'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml',
  'packages/storefront/package.json', 'packages/storefront-client/package.json',
];
export const productionInstallArgs = [
  '--filter', '@sellright/storefront...', 'install', '--prod', '--frozen-lockfile', '--offline', '--ignore-scripts',
  '--virtual-store-dir=node_modules/.pnpm', '--config.enable-global-virtual-store=false',
  '--config.hoist-workspace-packages=false',
];
const moduleRoots = ['node_modules', 'packages/storefront/node_modules', 'packages/storefront-client/node_modules'];
const compiledRoots = ['packages/storefront/dist-demo', 'packages/storefront/server-demo',
  'packages/storefront-client/dist', 'packages/admin/dist-demo'];
const requiredFiles = ['BUILD-INFO.json', ...sourceFiles, 'deploy/demo/run-storefront.mjs',
  'packages/storefront/server-demo/entry.express.js', 'packages/storefront/dist-demo/q-manifest.json',
  'packages/storefront-client/dist/index.js', 'packages/storefront-client/dist/index.d.ts',
  'packages/admin/dist-demo/index.html', 'packages/admin/dist-demo/BUILD-INFO.json'];
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const within = (root, path) => path === root || path.startsWith(`${root}${sep}`);
const dependencyPath = (path) => moduleRoots.some((root) => path === root || path.startsWith(`${root}/`));
function invariant(condition, message) { if (!condition) throw new Error(message); }

function sourcePath(repo, local) {
  let path = resolve(repo);
  for (const part of local.split('/')) {
    path = join(path, part);
    invariant(!lstatSync(path).isSymbolicLink(), `first-party source symlink: ${local}`);
  }
  return path;
}
function hashSources(repo) {
  return Object.fromEntries(sourceFiles.map((local) => {
    const path = sourcePath(repo, local);
    invariant(lstatSync(path).isFile(), `invalid source provenance: ${local}`);
    return [local, sha256(path)];
  }));
}
function assertProvenance(repo, workspace, hashes) {
  for (const local of sourceFiles) {
    invariant(sha256(sourcePath(repo, local)) === hashes[local], `source provenance changed: ${local}`);
    invariant(sha256(sourcePath(workspace, local)) === hashes[local], `staged provenance changed: ${local}`);
  }
}
function copyFile(source, target) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target, constants.COPYFILE_EXCL);
}

export function installFrontendProductionDependencies(repo, workspace, runtime, run = execFileSync) {
  const hashes = hashSources(repo);
  mkdirSync(workspace);
  for (const local of sourceFiles) copyFile(join(repo, local), join(workspace, local));
  assertProvenance(repo, workspace, hashes);
  // Only these two workspace importers are discovered. Preserve every lock &
  // policy byte; never use legacy deploy or resolve unrelated workspace peers.
  run('pnpm', productionInstallArgs, { cwd: workspace, stdio: 'inherit' });
  assertProvenance(repo, workspace, hashes);
  for (const local of moduleRoots) {
    const stat = lstatSync(join(workspace, local));
    invariant(stat.isDirectory() && !stat.isSymbolicLink(), `missing production dependency tree: ${local}`);
  }
  mkdirSync(runtime);
  for (const local of sourceFiles) copyFile(join(workspace, local), join(runtime, local));
  // Move all three trees together, retaining pnpm's exact relative symlinks,
  // including storefront -> real packages/storefront-client workspace links.
  for (const local of moduleRoots) renameSync(join(workspace, local), join(runtime, local));
  assertProvenance(repo, runtime, hashes);
  return hashes;
}

export function excludedClientPath(path) {
  return /(?:^|[/._-])(?:tests?|specs?|testkits?|mocks?|fixtures?)(?=[/._-]|$)/i.test(path) ||
    /(?:rls-test-utils|test-database-url|jws-fixture|fork-reference-policy\.kit|gateway-e2e-safety|seed-e2e-catalog)/.test(path) ||
    path.split('/').some((part) => ['src', 'scripts', 'adapters'].includes(part));
}
function assertFrontendPath(local) {
  const allowed = sourceFiles.includes(local) || local === 'BUILD-INFO.json' || local === 'deploy/demo/run-storefront.mjs' ||
    compiledRoots.some((root) => local === root || local.startsWith(`${root}/`)) ||
    [...sourceFiles, 'deploy/demo/run-storefront.mjs', ...compiledRoots].some((path) => path.startsWith(`${local}/`));
  invariant(allowed, `unexpected frontend runtime content: ${local}`);
  // Vite copies this public security asset verbatim. Keep its dot-directory
  // exception exact; every other dot-path still uses shared runtime guards.
  if (local !== 'packages/storefront/dist-demo/.well-known' &&
      local !== 'packages/storefront/dist-demo/.well-known/security.txt') assertFirstPartyPath(local);
  for (const root of compiledRoots) {
    if (local.startsWith(`${root}/`)) invariant(!excludedClientPath(local.slice(root.length + 1)), `test code in frontend runtime: ${local}`);
  }
}
function copyCompiledTree(repo, runtime, local, filterClient = false) {
  const source = sourcePath(repo, local);
  invariant(lstatSync(source).isDirectory(), `missing compiled directory: ${local}`);
  function visit(path, suffix = '') {
    const stat = lstatSync(path);
    invariant(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()), `unsafe compiled entry: ${local}/${suffix}`);
    if (filterClient && suffix && excludedClientPath(suffix)) return;
    const targetLocal = suffix ? `${local}/${suffix}` : local;
    assertFrontendPath(targetLocal);
    if (stat.isDirectory()) {
      mkdirSync(join(runtime, targetLocal), { recursive: true });
      for (const name of readdirSync(path).sort()) visit(join(path, name), suffix ? `${suffix}/${name}` : name);
    } else copyFile(path, join(runtime, targetLocal));
  }
  visit(source);
}

export function overlayFrontendOutputs(repo, runtime, sha) {
  for (const local of compiledRoots) copyCompiledTree(repo, runtime, local, local === 'packages/storefront-client/dist');
  const entry = sourcePath(repo, 'deploy/demo/run-storefront.mjs');
  invariant(lstatSync(entry).isFile(), 'missing demo storefront launcher');
  copyFile(entry, join(runtime, 'deploy/demo/run-storefront.mjs'));
  const info = join(runtime, 'packages/admin/dist-demo/BUILD-INFO.json');
  assertIdentity(json(info), sha);
  copyFile(info, join(runtime, 'BUILD-INFO.json'));
}

export function validateFrontendRuntime(runtime, sha) {
  const root = realpathSync(runtime);
  const files = new Map();
  function visit(dir) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const local = relative(root, path).split(sep).join('/');
      const stat = lstatSync(path);
      invariant(!local.includes('\\') && !local.includes(':'), `unsafe frontend path: ${local}`);
      if (!dependencyPath(local)) assertFrontendPath(local);
      if (stat.isSymbolicLink()) {
        invariant(dependencyPath(local), `first-party symlink: ${local}`);
        const link = readlinkSync(path);
        invariant(!isAbsolute(link) && !link.includes('\\') && !link.includes(':') && within(root, resolve(dirname(path), link)),
          `escaping dependency link: ${local}`);
        const target = realpathSync(path);
        invariant(within(root, target), `escaping dependency link chain: ${local}`);
        invariant(!within(target, dirname(path)), `cyclic dependency directory link: ${local}`);
        files.set(local, { symlink: link });
      } else if (stat.isDirectory()) visit(path);
      else {
        invariant(stat.isFile(), `unsafe frontend entry type: ${local}`);
        files.set(local, { sha256: sha256(path) });
      }
    }
  }
  visit(root);
  for (const local of requiredFiles) invariant(files.get(local)?.sha256, `missing frontend runtime file: ${local}`);
  for (const local of moduleRoots) invariant(lstatSync(join(root, local)).isDirectory(), `missing production dependency tree: ${local}`);
  for (const local of ['BUILD-INFO.json', 'packages/admin/dist-demo/BUILD-INFO.json']) assertIdentity(json(join(root, local)), sha);
  for (const [local, name] of [['packages/storefront', '@sellright/storefront'], ['packages/storefront-client', '@sellright/storefront-client'], ['', null]]) {
    const pkg = json(join(root, local, 'package.json'));
    const production = { ...pkg.dependencies, ...pkg.optionalDependencies };
    if (name) invariant(pkg.name === name, `unexpected frontend package identity: ${local}`);
    for (const dependency of Object.keys(pkg.dependencies ?? {})) {
      invariant(existsSync(join(root, local, 'node_modules', dependency, 'package.json')), `missing production dependency: ${local}/${dependency}`);
    }
    for (const dependency of Object.keys(pkg.devDependencies ?? {})) {
      // Node also searches root's modules from each package import root.
      const roots = local ? [join(root, local, 'node_modules'), join(root, 'node_modules')] : [join(root, 'node_modules')];
      invariant(dependency in production || !roots.some((modules) => existsSync(join(modules, dependency))),
        `direct development dependency: ${local}/${dependency}`);
    }
  }
  invariant([...files.keys()].some((path) => path.startsWith('packages/storefront/dist-demo/build/') && /\.js$/.test(path)), 'missing storefront client build assets');
  invariant([...files.keys()].some((path) => path.startsWith('packages/admin/dist-demo/admin-static/') && /\.js$/.test(path)), 'missing admin build assets');
  const html = readFileSync(join(root, 'packages/admin/dist-demo/index.html'), 'utf8');
  const assets = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]).filter((path) => path.includes('admin-static'));
  invariant(assets.length && assets.every((path) => path.startsWith('/admin/admin-static/')), 'admin HTML must use /admin/admin-static/ assets');
  return files;
}

export function archiveFrontendRuntime(runtime, output) {
  const fd = openSync(output, 'wx', 0o644);
  try {
    execFileSync('tar', ['--hard-dereference', '--owner=0', '--group=0', '-czf', '-', '-C', runtime, '.'],
      { stdio: ['ignore', fd, 'pipe'] });
  } finally { closeSync(fd); }
  // Validate every archive member & link chain without extraction. Also compare
  // each payload with its staged bytes, so archive identity describes this tree.
  execFileSync('python3', ['-c', String.raw`
import hashlib, os, pathlib, posixpath, stat, sys, tarfile
archive, root = sys.argv[1:]
root = pathlib.Path(root)
def confined(path):
    assert path != '..' and not path.startswith('../') and not path.startswith('/'), 'escaping frontend archive link'
def dependency(path):
    return any(path == p or path.startswith(p + '/') for p in ('node_modules', 'packages/storefront/node_modules', 'packages/storefront-client/node_modules'))
with tarfile.open(archive, 'r:gz') as tar:
    members = {}
    for member in tar.getmembers():
        name = member.name[2:] if member.name.startswith('./') else member.name
        assert name == '.' or all(p and p not in ('.', '..') for p in name.split('/')), 'unsafe frontend archive path'
        assert not name.startswith('/') and not any(c in name for c in ('\\', ':', '\x00')), 'unsafe frontend archive path'
        assert name not in members, 'duplicate frontend archive member'
        assert member.isfile() or member.isdir() or member.issym(), 'unsafe frontend archive type'
        assert member.uid == 0 and member.gid == 0, 'unexpected frontend archive ownership'
        members[name] = member
        path = root / name
        mode = path.lstat().st_mode
        if member.issym():
            assert dependency(name) and stat.S_ISLNK(mode), 'unsafe frontend archive symlink'
            assert member.linkname == os.readlink(path), 'frontend archive link differs from staged link'
            assert not any(c in member.linkname for c in ('\\', ':', '\x00')), 'unsafe frontend archive link'
        elif member.isdir():
            assert stat.S_ISDIR(mode), 'frontend archive directory differs from stage'
        else:
            assert stat.S_ISREG(mode), 'frontend archive file differs from stage'
            assert hashlib.sha256(tar.extractfile(member).read()).digest() == hashlib.sha256(path.read_bytes()).digest(), 'frontend archive bytes differ from stage'
    for name, member in members.items():
        if not member.issym(): continue
        target = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname))
        assert not member.linkname.startswith('/'), 'absolute frontend archive link'
        confined(target)
        assert target != '.' and not name.startswith(target + '/'), 'cyclic frontend archive directory link'
        seen = {name}
        while True:
            parts, changed = target.split('/'), False
            for i in range(1, len(parts) + 1):
                prefix = '/'.join(parts[:i])
                assert prefix in members, 'dangling frontend archive link'
                link = members[prefix]
                if link.issym():
                    assert prefix not in seen, 'cyclic frontend archive link'
                    seen.add(prefix)
                    target = posixpath.normpath(posixpath.join(posixpath.dirname(prefix), link.linkname, *parts[i:]))
                    confined(target)
                    changed = True
                    break
            if not changed: break
`, resolve(output), resolve(runtime)], { stdio: ['ignore', 'pipe', 'pipe'] });
}

export function packagePortableFrontend(bundle, repo, sha) {
  assertIdentity({ sha, dirty: false }, sha);
  const sourceHashes = hashSources(repo);
  const pnpm = execFileSync('pnpm', ['--version'], { cwd: repo, encoding: 'utf8' }).trim();
  invariant(json(join(repo, 'package.json')).packageManager === `pnpm@${pnpm}`, 'pnpm toolchain identity mismatch');
  const output = join(bundle, 'frontend-runtime.tar.gz');
  const manifest = join(bundle, 'frontend-runtime-manifest.json');
  invariant(![output, manifest].some(existsSync), 'frontend artifact target already exists');
  const stage = mkdtempSync(join(dirname(resolve(bundle)), 'sellright-frontend-'));
  const runtime = join(stage, 'frontend');
  try {
    installFrontendProductionDependencies(repo, join(stage, 'workspace'), runtime);
    assertProvenance(repo, runtime, sourceHashes);
    overlayFrontendOutputs(repo, runtime, sha);
    const files = validateFrontendRuntime(runtime, sha);
    archiveFrontendRuntime(runtime, output);
    assertProvenance(repo, runtime, sourceHashes);
    writeFileSync(manifest, `${JSON.stringify({
      schema: 1, sha, dirty: false, node: process.version, pnpm, platform: process.platform, arch: process.arch,
      deployment: `isolated workspace: pnpm ${productionInstallArgs.join(' ')}`, sourceHashes,
      runtime: { file: 'frontend-runtime.tar.gz', sha256: sha256(output), entries: files.size },
      demoEntrypoint: { file: 'deploy/demo/run-storefront.mjs', sha256: sha256(join(runtime, 'deploy/demo/run-storefront.mjs')) },
    }, null, 2)}\n`, { flag: 'wx' });
    console.log(`Packaged portable demo frontend for ${sha} (${files.size} entries)`);
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  invariant(process.argv.length === 3, 'usage: node deploy/package-portable-frontend.mjs BUNDLE_DIR');
  packagePortableFrontend(resolve(process.argv[2]), process.cwd(), process.env.GITHUB_SHA);
}
