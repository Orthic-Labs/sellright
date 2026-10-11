// node --test tools/compose/compose.test.mjs   (cwd: packages/storefront)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CHECKERS_DIR, apply, dryRun, plan, renderWorkspace, restoreInputs, selfCheck } from './compose.mjs';
import { checkClosure } from './closure-check.mjs';
import { layerOf, parseLayers } from './lib/layers.mjs';
import { buildInventory } from './lib/inventory.mjs';
import { openBase } from './lib/base.mjs';
import { listEntries, markBuilt } from './lib/history.mjs';
import { Problems, safeRemoveFile, safeWrite, sha256 } from './lib/util.mjs';
import { BASE_FIXTURE, PIN, PIN2, allFiles, editBase, equalSnapshots, makeWorld, snapshot } from './fixtures/support.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const readJ = (p) => JSON.parse(readFileSync(p, 'utf8'));
const asRoot = process.getuid?.() === 0;

/** Rejects with a ComposeError carrying `code` (directly or among its validation problems). */
async function failsWith(promise, code) {
	let err;
	try {
		await promise;
	} catch (e) {
		err = e;
	}
	assert.ok(err, `expected a failure with ${code}`);
	const codes = err.code === 'validation' ? err.details.map((d) => d.code) : [err.code];
	assert.ok(codes.includes(code), `expected ${code}, got ${codes.join(', ')}: ${err.message}`);
	return err;
}

const editManifest = (w, fn) => {
	const f = w.layerPath('overlay.manifest.json');
	const m = readJ(f);
	fn(m);
	writeFileSync(f, JSON.stringify(m, null, 2));
};
const editBrand = (w, fn) => {
	const f = w.layerPath('brand.json');
	const b = readJ(f);
	fn(b);
	writeFileSync(f, JSON.stringify(b, null, 2));
};

// ---------------------------------------------------------------- happy path and read-only base

test('happy path from a read-only base fixture', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	const before = snapshot(w.base);
	const r = await apply(w.opts());
	assert.ok(equalSnapshots(before, snapshot(w.base)), 'the base fixture was not modified');

	const pkg = readFileSync(w.outPath('package.json'), 'utf8');
	assert.ok(pkg.startsWith('{\n\t"name"'), 'indentation of the base package.json is kept');
	const scripts = JSON.parse(pkg).scripts;
	assert.equal(scripts.build, 'bash scripts/build-production.sh');
	assert.equal('prebuild' in scripts, false, 'prebuild is removed by the patch');
	assert.equal(scripts.clean, 'node scripts/clean.mjs');

	const ws = readFileSync(w.outPath('pnpm-workspace.yaml'), 'utf8');
	assert.ok(ws.startsWith('packages:\n  - "."\n  - "vendor/storefront-client"\n'));
	assert.ok(ws.includes('blockExoticSubdeps: true') && ws.includes('postcss: ^8.5.18'));
	assert.ok(!ws.includes('packages/*') && !ws.includes('!packages/admin') && !ws.includes('admin installs'));

	assert.equal(readFileSync(w.outPath('src/components/Button.tsx'), 'utf8'), readFileSync(w.layerPath('overlay/src/components/Button.tsx'), 'utf8'));
	assert.equal(readFileSync(w.outPath('src/brand/tokens.css'), 'utf8'), readFileSync(w.layerPath('overlay/src/brand/tokens.css'), 'utf8'));
	assert.ok(existsSync(w.outPath('public/sezzle-color.svg')), 'asset exception file lands at its exact path');
	assert.ok(existsSync(w.outPath('vendor/storefront-client/package.json')));
	assert.ok(existsSync(w.outPath('tsconfig.base.json')));
	assert.equal(existsSync(w.outPath('tools')), false, 'tools/ is not composed');
	assert.equal(statSync(w.outPath('.env.production')).mode & 0o777, 0o600);
	assert.ok(readFileSync(w.outPath('.env.production'), 'utf8').includes('VITE_STORE_NAME="Fixture Store"'));
	assert.ok(statSync(w.outPath('scripts/build-production.sh')).mode & 0o100, 'exec bit kept');

	const managed = readJ(w.outPath('.compose-managed.json'));
	const origin = Object.fromEntries(managed.files.map((f) => [f.path, f.origin]));
	assert.equal(origin['src/components/Button.tsx'], 'eject');
	assert.equal(origin['src/brand/tokens.css'], 'overlay');
	assert.equal(origin['src/components/Card.tsx'], 'base');
	assert.equal(origin['package.json'], 'generated');
	assert.equal(origin['pnpm-lock.yaml'], 'overlay');
	assert.equal(origin['.env.production'], 'generated');
	assert.equal('.compose-managed.json' in origin, false);
	assert.equal(managed.files.find((f) => f.path === 'package.json').sha256, sha256(readFileSync(w.outPath('package.json'))));

	const list = readFileSync(w.outPath('.compose-overlay-files.txt'), 'utf8').split('\n').filter(Boolean);
	assert.ok(list.includes('src/components/Button.tsx') && list.includes('src/brand-slots/Hello.tsx'));
	assert.ok(!list.includes('src/components/Card.tsx') && !list.includes('pnpm-lock.yaml'));

	const report = readJ(w.outPath('compose-report.json'));
	assert.equal(report.hashes.pin, PIN);
	assert.deepEqual(report.patchedScriptKeys, ['build', 'prebuild']);
	assert.equal(report.optionalInputs['.npmrc'].present, false);
	assert.deepEqual(report.closure.usedExternals, ['../scripts/node-heap-options.mjs', '/opt/fixture-ops/cf-purge.mjs']);
	assert.equal(report.importCheck.status, 'passed', 'the import checker ran against the complete layers schema');
	assert.equal(report.shapeCheck.status, 'passed', 'the code-shape checker ran too');
	assert.ok(report.importCheck.checked >= 3, 'the deploy file, the ejected component and the slot were all checked');
	assert.ok(list.includes('ecosystem.config.cjs'), 'the declared deploy file is an overlay code file that sits in no layer');
	assert.deepEqual(report.closure.generatedArtifacts, ['server/entry.express.js'], 'a generated runtime artifact is not a missing input');
	assert.deepEqual(report.closure.excludedTooling, ['tools/compose/compose.test.mjs'], 'composition-excluded tooling is not a missing input');
	assert.equal(report.hashes.overlayTree.length, 64);

	const h = path.join(w.repo, '.compose-history', r.historyId);
	assert.equal(readJ(path.join(h, 'meta.json')).status, 'applied');
	assert.ok(existsSync(path.join(h, 'layer/brand.json')) && existsSync(path.join(h, 'compose-managed.json')));
});

test('dry run writes nothing, not even the history directory', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	const r = await dryRun(w.opts());
	assert.equal(existsSync(w.out), false);
	assert.equal(existsSync(path.join(w.repo, '.compose-history')), false);
	assert.ok(r.changes.length > 20 && r.changes.every((c) => c.action === 'add'));
});

test('--require-out-pair rejects an output that is not <layer parent>/<buildDir>', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	await failsWith(apply({ ...w.opts(), outDir: path.join(w.root, 'elsewhere'), requireOutPair: true }), 'out-mismatch');
	assert.equal(existsSync(path.join(w.root, 'elsewhere')), false);
});

test('review 13: --require-out-pair accepts the stage the deploy entry composes into (<buildDir>.next with --live <buildDir>) and nothing looser', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	mkdirSync(w.out);
	const stage = `${w.out}.next`;
	const pair = { ...w.opts(), requireOutPair: true };
	// the real composer, applied into the stage the way the entry does it
	const r = await apply({ ...pair, outDir: stage, liveDir: w.out });
	assert.ok(r.historyId, 'the staged composition ran');
	assert.ok(existsSync(path.join(stage, '.compose-managed.json')));
	assert.deepEqual(readdirSync(w.out), [], 'the live tree was not written');
	// a stage without --live, with another live tree, or an unrelated sibling is still refused
	await failsWith(dryRun({ ...pair, outDir: stage }), 'out-mismatch');
	mkdirSync(path.join(w.root, 'other'));
	await failsWith(dryRun({ ...pair, outDir: stage, liveDir: path.join(w.root, 'other') }), 'out-mismatch');
	await failsWith(dryRun({ ...pair, outDir: `${w.out}.other`, liveDir: w.out }), 'out-mismatch');
	// the canonical path itself still passes
	await dryRun({ ...pair, outDir: w.out });
});

test('source and output must not overlap', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	await failsWith(dryRun({ ...w.opts(), outDir: path.join(w.layer, 'inside') }), 'overlap');
	await failsWith(dryRun({ ...w.opts(), outDir: path.join(w.base, 'inside') }), 'overlap');
});

// ---------------------------------------------------------------- symlinks and traversal

test('symlink rejection: overlay, base, output target, output ancestor', async (t) => {
	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	// overlay
	symlinkSync('/etc/hostname', w.layerPath('overlay/src/brand/link.css'));
	await failsWith(apply(w.opts()), 'symlink');
	rmSync(w.layerPath('overlay/src/brand/link.css'));
	// base
	symlinkSync('/etc/hostname', w.basePath('src/link.ts'));
	await failsWith(apply(w.opts()), 'symlink');
	rmSync(w.basePath('src/link.ts'));
	assert.equal(existsSync(w.out), false, 'nothing was written by the failed runs');

	await apply(w.opts());
	// output target replaced by a symlink to a file outside the build directory
	const outside = path.join(w.root, 'outside.txt');
	writeFileSync(outside, 'untouched');
	rmSync(w.outPath('src/components/Card.tsx'));
	symlinkSync(outside, w.outPath('src/components/Card.tsx'));
	await failsWith(apply(w.opts()), 'symlink');
	assert.equal(readFileSync(outside, 'utf8'), 'untouched');
	rmSync(w.outPath('src/components/Card.tsx'));
	writeFileSync(w.outPath('src/components/Card.tsx'), readFileSync(w.basePath('src/components/Card.tsx')));

	// output ancestor replaced by a symlink to a directory outside the build directory
	const outsideDir = path.join(w.root, 'outside-dir');
	mkdirSync(outsideDir);
	renameSync(w.outPath('src'), w.outPath('src-real'));
	symlinkSync(outsideDir, w.outPath('src'));
	await failsWith(apply(w.opts()), 'symlink');
	assert.deepEqual(readdirSync(outsideDir), [], 'nothing was written through the symlinked directory');
});

test('traversal: manifest path, deploy file, absolute path and safeWrite', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	editManifest(w, (m) => m.entries.push({ path: '../escape.txt', layer: 'L3' }));
	await failsWith(dryRun(w.opts()), 'unsafe-path');
	editManifest(w, (m) => m.entries.pop());
	editBrand(w, (b) => b.deployFiles.push('/etc/cron.d/x'));
	await failsWith(dryRun(w.opts()), 'unsafe-path');
	editBrand(w, (b) => b.deployFiles.pop());
	editBrand(w, (b) => b.deployFiles.push('a/../../b'));
	await failsWith(dryRun(w.opts()), 'unsafe-path');

	const dir = mkdtempSync(path.join(tmpdir(), 'compose-sw-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	for (const bad of ['../escape.txt', '/abs.txt', 'a/../../escape.txt', 'a//b', 'a\\b']) {
		assert.throws(() => safeWrite(dir, bad, 'x'), /unsafe-path/, bad);
	}
	assert.equal(existsSync(path.join(dir, '..', 'escape.txt')), false);
});

test('a managed file listing an unsafe path stops the apply before any write', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	await apply(w.opts());
	const outside = path.join(w.repo, 'outside.txt');
	writeFileSync(outside, 'keep');
	const m = readJ(w.outPath('.compose-managed.json'));
	m.files.push({ path: '../outside.txt', sha256: 'x', origin: 'overlay' });
	writeFileSync(w.outPath('.compose-managed.json'), JSON.stringify(m));
	await failsWith(apply(w.opts()), 'bad-managed');
	assert.equal(readFileSync(outside, 'utf8'), 'keep');
});

test('removing an obsolete managed file never follows a symlinked ancestor out of the build directory', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	await apply(w.opts());
	// the overlay drops Hello.tsx, so nothing composed lives in src/brand-slots any more
	rmSync(w.layerPath('overlay/src/brand-slots/Hello.tsx'));
	editManifest(w, (m) => (m.entries = m.entries.filter((e) => e.path !== 'src/brand-slots/Hello.tsx')));
	// ...and that managed directory is swapped for a symlink to a directory outside, holding a same-named file
	const outsideDir = path.join(w.root, 'outside-dir');
	w.write(path.join(outsideDir, 'Hello.tsx'), 'precious');
	renameSync(w.outPath('src/brand-slots'), w.outPath('src/brand-slots-real'));
	symlinkSync(outsideDir, w.outPath('src/brand-slots'));
	const historyBefore = listEntries(w.layer).length;
	const before = snapshot(w.out);
	await failsWith(dryRun(w.opts()), 'symlink');
	await failsWith(apply(w.opts()), 'symlink');
	assert.equal(readFileSync(path.join(outsideDir, 'Hello.tsx'), 'utf8'), 'precious', 'the file behind the symlink was not deleted');
	assert.equal(listEntries(w.layer).length, historyBefore, 'rejected while planning: no history entry was written');
	assert.ok(equalSnapshots(before, snapshot(w.out)), 'nothing in the build directory changed');
});

test('safeRemoveFile and safeWrite refuse a symlinked ancestor, a symlinked root and a non-directory ancestor', (t) => {
	const dir = mkdtempSync(path.join(tmpdir(), 'compose-sr-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const root = path.join(dir, 'root');
	const outside = path.join(dir, 'outside');
	mkdirSync(root);
	mkdirSync(outside);
	writeFileSync(path.join(outside, 'f.txt'), 'keep');
	symlinkSync(outside, path.join(root, 'link'));
	assert.throws(() => safeRemoveFile(root, 'link/f.txt'), /symlink/);
	assert.throws(() => safeWrite(root, 'link/g.txt', 'x'), /symlink/);
	const linkRoot = path.join(dir, 'link-root');
	symlinkSync(outside, linkRoot);
	assert.throws(() => safeRemoveFile(linkRoot, 'f.txt'), /symlink/);
	assert.throws(() => safeWrite(linkRoot, 'g.txt', 'x'), /symlink/);
	assert.deepEqual(readdirSync(outside), ['f.txt'], 'nothing was removed from or written to the outside directory');
	writeFileSync(path.join(root, 'file'), 'x');
	assert.throws(() => safeRemoveFile(root, 'file/inner'), /not-a-dir/);
	assert.equal(safeRemoveFile(root, 'missing/x'), false, 'a missing ancestor means there is nothing to remove');
	writeFileSync(path.join(root, 'plain.txt'), 'x');
	assert.equal(safeRemoveFile(root, 'plain.txt'), true);
});

// ---------------------------------------------------------------- layer spoofing, globs, ejects

test('spoofed layer, overlay in L1, undeclared eject, unlayered overlay', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	editManifest(w, (m) => (m.entries.find((e) => e.path === 'src/brand/tokens.css').layer = 'L2'));
	await failsWith(dryRun(w.opts()), 'spoofed-layer');
	editManifest(w, (m) => (m.entries.find((e) => e.path === 'src/brand/tokens.css').layer = 'L3'));
	editManifest(w, (m) => (m.entries.find((e) => e.path === 'src/components/Button.tsx').layer = 'L3'));
	await failsWith(dryRun(w.opts()), 'spoofed-layer');
	editManifest(w, (m) => (m.entries.find((e) => e.path === 'src/components/Button.tsx').layer = 'L2'));
	editManifest(w, (m) => (m.entries.find((e) => e.key === 'build').layer = 'L3'));
	await failsWith(dryRun(w.opts()), 'spoofed-layer');
	editManifest(w, (m) => (m.entries.find((e) => e.key === 'build').layer = 'L2'));

	w.write(w.layerPath('overlay/src/platform/loader.ts'), 'export {};\n');
	await failsWith(dryRun(w.opts()), 'overlay-in-l1');
	rmSync(w.layerPath('overlay/src/platform'), { recursive: true });
	w.write(w.layerPath('overlay/src/components/Card.tsx'), 'export {};\n');
	await failsWith(dryRun(w.opts()), 'undeclared-eject');
	rmSync(w.layerPath('overlay/src/components/Card.tsx'));
	w.write(w.layerPath('overlay/src/other.ts'), 'export {};\n');
	await failsWith(dryRun(w.opts()), 'unlayered-overlay');
	rmSync(w.layerPath('overlay/src/other.ts'));
	await dryRun(w.opts());
});

test('reserved and runtime overlay paths are rejected', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	for (const rel of ['.env', '.env.production', 'dist/x.js', 'server/x.js', 'node_modules/x/y.js', 'package.json', 'vendor/storefront-client/x.ts', '.compose-managed.json']) {
		w.write(w.layerPath(`overlay/${rel}`), 'x');
		await failsWith(dryRun(w.opts()), 'reserved-path');
		rmSync(w.layerPath(`overlay/${rel.split('/')[0]}`), { recursive: true, force: true });
	}
	await dryRun(w.opts());
});

test('glob boundary: per-segment matching, exact assets, exclude, literal brackets', () => {
	const layers = parseLayers(readJ(path.join(BASE_FIXTURE, 'packages/storefront/layers.json')));
	assert.equal(layerOf(layers, 'src/routes/products/ProductPageView.tsx'), 'L3');
	assert.equal(layerOf(layers, 'src/routes/products/a/b/ProductPageView.tsx'), 'L3');
	assert.equal(layerOf(layers, 'src/routes/products/UnexpectedProductPageView.tsx'), null);
	assert.equal(layerOf(layers, 'src/components/x/y/z.tsx'), 'L2');
	assert.equal(layerOf(layers, 'src/platform/loader.ts'), 'L1');
	assert.equal(layerOf(layers, 'src/platformer/x.ts'), null);
	assert.equal(layerOf(layers, 'public/sezzle-color.svg'), 'L3');
	assert.equal(layerOf(layers, 'public/sezzle-white.svg'), null);
	const star = parseLayers({ version: 1, layers: { L1: { include: ['src/*/x.ts'] }, L2: { include: ['a/**'], exclude: ['a/b/**'] }, L3: { include: ['src/routes/[...slug]/**'] } } });
	assert.equal(layerOf(star, 'src/a/x.ts'), 'L1');
	assert.equal(layerOf(star, 'src/a/b/x.ts'), null);
	assert.equal(layerOf(star, 'a/c.ts'), 'L2');
	assert.equal(layerOf(star, 'a/b/c.ts'), null, 'exclude removes a path from its layer and assigns it nowhere');
	assert.equal(layerOf(star, 'src/routes/[...slug]/index.tsx'), 'L3');
	assert.equal(layerOf(star, 'src/routes/x/index.tsx'), null);
	assert.throws(() => parseLayers({ version: 1, layers: { L1: { include: ['src/**x'] }, L2: { include: ['a'] }, L3: { include: ['b'] } } }), /bad-layers/);
	assert.throws(() => parseLayers({ version: 1, layers: { L1: { include: ['../x'] }, L2: { include: ['a'] }, L3: { include: ['b'] } } }), /bad-layers/);
});

test('ambiguous glob: a path in two layers throws, in the unit and in compose', async (t) => {
	const ambiguous = parseLayers({ version: 1, layers: { L1: { include: ['src/routes/**'] }, L2: { include: ['src/c/**'] }, L3: { include: ['src/routes/products/**/ProductPageView.tsx'] } } });
	assert.throws(() => layerOf(ambiguous, 'src/routes/products/ProductPageView.tsx'), /ambiguous-layer/);
	assert.equal(layerOf(ambiguous, 'src/routes/other.tsx'), 'L1');
	const withException = parseLayers({ version: 1, layers: { L1: { include: ['public/**'] }, L2: { include: ['src/c/**'] }, L3: { include: ['src/b/**'] } }, assetExceptions: [{ path: 'public/sezzle-color.svg', layer: 'L3' }] });
	assert.throws(() => layerOf(withException, 'public/sezzle-color.svg'), /ambiguous-layer/, 'an assetException of another layer is a second claim');
	assert.equal(layerOf(withException, 'public/other.svg'), 'L1');

	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	editBase(w, 'layers.json', (s) => s.replace('"src/routes/layout.tsx"', '"src/routes/**"'));
	w.write(w.layerPath('overlay/src/routes/products/ProductPageView.tsx'), 'export {};\n');
	await failsWith(dryRun(w.opts()), 'ambiguous-layer');
});

test('orphaned eject: the base file is gone at the pin', async (t) => {
	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	rmSync(w.basePath('src/components/Button.tsx'));
	await failsWith(apply(w.opts()), 'orphaned-eject');
	assert.equal(existsSync(w.out), false);
	assert.equal(existsSync(path.join(w.repo, '.compose-history')), false);
});

test('changed upstream hash with every other field valid fails compose', async (t) => {
	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	editBase(w, 'src/components/Button.tsx', (s) => `${s}// upstream change\n`);
	const err = await failsWith(apply(w.opts()), 'drift-unresolved');
	assert.ok(err.details.some((d) => d.file === 'src/components/Button.tsx'));
	assert.equal(existsSync(w.out), false);
});

test('patched script key drift: the base value of a patched script changed', async (t) => {
	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	editBase(w, 'package.json', (s) => s.replace('pnpm run build.client"', 'pnpm run build.client && pnpm run build.server"'));
	const err = await failsWith(apply(w.opts()), 'drift-unresolved');
	assert.ok(err.details.some((d) => d.file === 'package.json#scripts.build'));
});

test('package script patches must be allowlisted and declared both ways', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	editBrand(w, (b) => (b.packageScripts.postinstall = 'echo hi'));
	await failsWith(dryRun(w.opts()), 'script-not-allowed');
	editBrand(w, (b) => delete b.packageScripts.postinstall);
	editBrand(w, (b) => delete b.packageScripts.prebuild);
	await failsWith(dryRun(w.opts()), 'script-entry-orphan');
	editBrand(w, (b) => (b.packageScripts.prebuild = null));
	editManifest(w, (m) => (m.entries = m.entries.filter((e) => e.key !== 'build')));
	await failsWith(dryRun(w.opts()), 'script-undeclared');
});

// ---------------------------------------------------------------- runtime state, bookkeeping

test('.env, .env.local, node_modules, dist, server, tmp and .cache are untouched and never read for secrets', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	const fixtures = {
		'.env': 'VITE_STORE_NAME=Fixture Store\nSTRIPE_SECRET=sk_not_a_real_secret\n',
		'.env.local': 'LOCAL_ONLY=1\n',
		'node_modules/pkg/index.js': 'module.exports = 1;\n',
		'dist/a.js': 'a',
		'dist-e2e/b.js': 'b',
		'server/entry.express.js': 'c',
		'server-e2e/entry.express.js': 'd',
		'tmp/t.txt': 't',
		'.cache/x': 'x',
	};
	for (const [rel, text] of Object.entries(fixtures)) w.write(w.outPath(rel), text);
	const before = snapshot(w.out);
	const r = await apply(w.opts());
	const after = snapshot(w.out);
	for (const rel of Object.keys(fixtures)) assert.equal(after.get(rel), before.get(rel), `${rel} untouched`);
	assert.ok(!JSON.stringify(r).includes('sk_not_a_real_secret'));
	assert.ok(!readFileSync(w.outPath('compose-report.json'), 'utf8').includes('sk_not_a_real_secret'));
	const managed = readJ(w.outPath('.compose-managed.json')).files.map((f) => f.path);
	for (const rel of Object.keys(fixtures)) assert.equal(managed.includes(rel), false, `${rel} is not managed`);
});

test('a legacy .env public value that conflicts with brand.json stops compose; names only in the message', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	w.write(w.outPath('.env'), 'VITE_STORE_NAME=Somebody Else\n');
	const err = await failsWith(apply(w.opts()), 'env-legacy-conflict');
	assert.ok(!err.message.includes('Somebody Else'));
	assert.equal(existsSync(w.outPath('package.json')), false);
});

test('managed-file bookkeeping: delete only what was recorded, keep unmanaged files and runtime names', async (t) => {
	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	w.write(w.outPath('.env'), 'VITE_STORE_NAME=Fixture Store\n');
	const first = await apply(w.opts());
	assert.ok(first.changes.length > 20);
	const m1 = readFileSync(w.outPath('.compose-managed.json'), 'utf8');

	// idempotent
	const again = await apply(w.opts());
	assert.deepEqual(again.changes, []);
	assert.equal(readFileSync(w.outPath('.compose-managed.json'), 'utf8'), m1);

	// unmanaged files, one in a directory compose also writes to
	w.write(w.outPath('notes.txt'), 'mine');
	w.write(w.outPath('src/brand-slots/keep.txt'), 'mine too');
	// the overlay drops Hello.tsx, the base drops Card.tsx
	rmSync(w.layerPath('overlay/src/brand-slots/Hello.tsx'));
	editManifest(w, (m) => (m.entries = m.entries.filter((e) => e.path !== 'src/brand-slots/Hello.tsx')));
	rmSync(w.basePath('src/components/Card.tsx'));
	// a tampered managed list naming runtime state must not make compose delete it
	const m = readJ(w.outPath('.compose-managed.json'));
	m.files.push({ path: '.env', sha256: 'x', origin: 'overlay' }, { path: 'node_modules/ghost.js', sha256: 'x', origin: 'overlay' });
	writeFileSync(w.outPath('.compose-managed.json'), JSON.stringify(m));
	w.write(w.outPath('node_modules/ghost.js'), 'g');

	const r = await apply(w.opts());
	assert.deepEqual(r.removed.sort(), ['src/brand-slots/Hello.tsx', 'src/components/Card.tsx']);
	assert.equal(existsSync(w.outPath('src/brand-slots/Hello.tsx')), false);
	assert.equal(existsSync(w.outPath('src/components/Card.tsx')), false);
	assert.equal(readFileSync(w.outPath('notes.txt'), 'utf8'), 'mine');
	assert.equal(readFileSync(w.outPath('src/brand-slots/keep.txt'), 'utf8'), 'mine too');
	assert.equal(existsSync(w.outPath('.env')), true);
	assert.equal(existsSync(w.outPath('node_modules/ghost.js')), true);
	const paths = readJ(w.outPath('.compose-managed.json')).files.map((f) => f.path);
	assert.ok(!paths.includes('src/components/Card.tsx') && !paths.includes('.env'));
});

test('a new composed path that collides with an unmanaged file is refused and the file is kept', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	await apply(w.opts());
	w.write(w.layerPath('overlay/src/brand-slots/New.tsx'), 'export {};\n');
	w.write(w.outPath('src/brand-slots/New.tsx'), 'hand written');
	await failsWith(apply(w.opts()), 'unmanaged-collision');
	assert.equal(readFileSync(w.outPath('src/brand-slots/New.tsx'), 'utf8'), 'hand written');
});

// ---------------------------------------------------------------- history

function layerSnapshot(dir) {
	const m = snapshot(dir);
	return m;
}

test('inputs history: complete layer copy, written before any output change, hash-checked restore', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	const layer1 = layerSnapshot(w.layer);
	const a1 = await apply(w.opts());
	const h1 = path.join(w.repo, '.compose-history', a1.historyId);
	assert.ok(equalSnapshots(layer1, snapshot(path.join(h1, 'layer'))), 'history holds every file of the input set, byte for byte');
	const meta1 = readJ(path.join(h1, 'meta.json'));
	for (const k of ['pin', 'overlayTree', 'manifest', 'lock', 'brandPublicConfig', 'publicConfig', 'tool']) assert.ok(meta1.hashes[k], k);
	assert.equal(meta1.hashes.pin, PIN);
	assert.equal(readFileSync(path.join(h1, 'compose-managed.json'), 'utf8'), readFileSync(w.outPath('.compose-managed.json'), 'utf8'));

	// change every kind of input, apply again
	writeFileSync(w.layerPath('overlay/src/brand/tokens.css'), ':root { --brand-color-accent: #000; }\n');
	writeFileSync(w.layerPath('pnpm-lock.yaml'), "lockfileVersion: '9.0'\n# changed\n");
	editBrand(w, (b) => (b.publicConfig.VITE_STORE_NAME = 'Fixture Store Two'));
	w.write(w.layerPath('e2e/extra.spec.ts'), '// extra\n');
	const layer2 = layerSnapshot(w.layer);
	const a2 = await apply(w.opts());
	assert.notEqual(a1.historyId, a2.historyId);
	assert.equal(listEntries(w.layer).length, 2);
	assert.ok(equalSnapshots(layer2, snapshot(path.join(w.repo, '.compose-history', a2.historyId, 'layer'))));
	assert.equal(markBuilt({ layerDir: w.layer, outDir: w.out, now: new Date() }), a2.historyId);
	assert.equal(listEntries(w.layer).find((e) => e.id === a2.historyId).meta.status, 'built');

	// restore the first inputs: the whole layer equals entry 1, extras removed, nothing composed
	const outBefore = snapshot(w.out);
	const res = restoreInputs({ layerDir: w.layer, historyId: a1.historyId });
	assert.ok(equalSnapshots(layer1, snapshot(w.layer)), 'brand layer equals the history copy');
	assert.equal(existsSync(w.layerPath('e2e/extra.spec.ts')), false);
	assert.equal(res.hashes.lock, meta1.hashes.lock);
	assert.ok(equalSnapshots(outBefore, snapshot(w.out)), 'restore-inputs writes no output tree');
	// the next apply composes the restored inputs
	await apply(w.opts());
	assert.ok(readFileSync(w.outPath('.env.production'), 'utf8').includes('"Fixture Store"'));
	assert.equal(readFileSync(w.outPath('src/brand/tokens.css'), 'utf8'), readFileSync(w.layerPath('overlay/src/brand/tokens.css'), 'utf8'));
});

test('restore-inputs fails on a tampered copy and on a hash mismatch, before touching the layer', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	const a1 = await apply(w.opts());
	const copy = path.join(w.repo, '.compose-history', a1.historyId, 'layer/overlay/src/brand/tokens.css');
	writeFileSync(w.layerPath('overlay/src/brand/tokens.css'), 'current, different\n');
	const current = snapshot(w.layer);
	const original = readFileSync(copy);
	writeFileSync(copy, Buffer.concat([original, Buffer.from(' ')]));
	assert.throws(() => restoreInputs({ layerDir: w.layer, historyId: a1.historyId }), /history-tampered/);
	assert.ok(equalSnapshots(current, snapshot(w.layer)), 'the layer was not touched');
	writeFileSync(copy, original);
	const metaFile = path.join(w.repo, '.compose-history', a1.historyId, 'meta.json');
	const meta = readJ(metaFile);
	meta.hashes.lock = '0'.repeat(64);
	writeFileSync(metaFile, JSON.stringify(meta));
	assert.throws(() => restoreInputs({ layerDir: w.layer, historyId: a1.historyId }), /history-tampered/);
	assert.ok(equalSnapshots(current, snapshot(w.layer)));
	assert.throws(() => restoreInputs({ layerDir: w.layer, historyId: '../../etc' }), /bad-history-id/);
});

test('history entry exists before any output file changes (apply that fails while writing)', { skip: asRoot }, async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	mkdirSync(w.out);
	chmodSync(w.out, 0o555);
	await assert.rejects(apply(w.opts()));
	chmodSync(w.out, 0o755);
	const entries = listEntries(w.layer);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].meta.status, 'applied');
	assert.deepEqual(allFiles(w.out), [], 'no output file was written');
});

test('mark-built keeps the newest N built entries and nothing else is deleted', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	for (let i = 0; i < 4; i++) {
		writeFileSync(w.layerPath('overlay/src/brand/tokens.css'), `:root { --brand-color-accent: #00000${i}; }\n`);
		await apply(w.opts());
		markBuilt({ layerDir: w.layer, outDir: w.out, now: new Date(), keepBuilt: 3 });
	}
	const left = listEntries(w.layer);
	assert.equal(left.filter((e) => e.meta.status === 'built').length, 3);
	assert.equal(left.length, 3);
	assert.ok(existsSync(w.layerPath('brand.json')));
});

test('a symlinked history root is rejected before anything is created, written or pruned', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	const outsideDir = path.join(w.root, 'outside-history');
	mkdirSync(outsideDir);
	symlinkSync(outsideDir, path.join(w.repo, '.compose-history'));
	await failsWith(apply(w.opts()), 'symlink');
	assert.deepEqual(readdirSync(outsideDir), [], 'no snapshot was written through the history root symlink');
	assert.equal(existsSync(w.out), false, 'the build directory was not even created');
	rmSync(path.join(w.repo, '.compose-history'));
	writeFileSync(path.join(w.repo, '.compose-history'), 'a file, not a directory');
	await failsWith(apply(w.opts()), 'not-a-dir');
	rmSync(path.join(w.repo, '.compose-history'));

	// a root swapped for a symlink after entries exist: listing, mark-built and restore all refuse
	const a = await apply(w.opts());
	const real = path.join(w.repo, '.compose-history');
	renameSync(real, path.join(w.repo, 'history-real'));
	symlinkSync(path.join(w.repo, 'history-real'), real);
	assert.throws(() => listEntries(w.layer), /symlink/);
	assert.throws(() => markBuilt({ layerDir: w.layer, outDir: w.out, now: new Date() }), /symlink/);
	assert.throws(() => restoreInputs({ layerDir: w.layer, historyId: a.historyId }), /symlink/);
});

test('history made with a --pin override restores; the effective pin is recorded apart from brand.json and reported', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	const layer1 = snapshot(w.layer);
	const a = await apply({ ...w.opts(), pin: PIN2 });
	const metaFile = path.join(w.repo, '.compose-history', a.historyId, 'meta.json');
	const meta = readJ(metaFile);
	assert.equal(meta.hashes.pin, PIN2, 'the effective pin');
	assert.equal(meta.hashes.brandPin, PIN, "brand.json's own pin, which the layer copy carries");
	assert.equal(readJ(w.outPath('compose-report.json')).hashes.pin, PIN2);

	writeFileSync(w.layerPath('overlay/src/brand/tokens.css'), ':root { --brand-color-accent: #111; }\n');
	const res = restoreInputs({ layerDir: w.layer, historyId: a.historyId });
	assert.equal(res.pin, PIN2, 'restore reports the pin the saved output was composed at');
	assert.equal(res.pinOverride, true);
	assert.equal(res.hashes.brandPin, PIN);
	assert.ok(equalSnapshots(layer1, snapshot(w.layer)), 'the layer equals the history copy');
	const again = await apply({ ...w.opts(), pin: res.pin });
	assert.deepEqual(again.changes, [], 'recomposing at the recorded pin reproduces the saved output');

	// an entry written before brandPin existed recorded the brand.json pin as `pin` and still restores
	const legacyMeta = readJ(metaFile);
	delete legacyMeta.hashes.brandPin;
	legacyMeta.hashes.pin = PIN;
	writeFileSync(metaFile, JSON.stringify(legacyMeta));
	writeFileSync(w.layerPath('overlay/src/brand/tokens.css'), ':root { --brand-color-accent: #222; }\n');
	const old = restoreInputs({ layerDir: w.layer, historyId: a.historyId });
	assert.equal(old.pin, PIN);
	assert.equal(old.pinOverride, false);

	// a tampered brandPin is still caught
	const bad = readJ(metaFile);
	bad.hashes.brandPin = PIN2;
	writeFileSync(metaFile, JSON.stringify(bad));
	assert.throws(() => restoreInputs({ layerDir: w.layer, historyId: a.historyId }), /history-tampered/);
});

// ---------------------------------------------------------------- adoption guard / legacy source

async function composedShas(w) {
	const ctx = await plan({ ...w.opts(), mode: 'inventory' });
	try {
		return new Map([...ctx.outputs].map(([k, v]) => [k, sha256(v.buf)]));
	} finally {
		ctx.base.cleanup();
	}
}

function legacyTree(w) {
	w.write(w.outPath('package.json'), '{ "name": "legacy" }\n');
	w.write(w.outPath('src/old/legacy.ts'), 'export const legacy = 1;\n');
	w.write(w.outPath('src/components/Card.tsx'), readFileSync(w.basePath('src/components/Card.tsx'), 'utf8'));
	w.write(w.outPath('README.md'), 'hand notes\n');
	w.write(w.outPath('.env'), 'VITE_STORE_NAME=Fixture Store\n');
	w.write(w.outPath('node_modules/pkg/index.js'), 'm');
	w.write(w.outPath('dist/index.html'), '<html>');
}
const dispositions = {
	'package.json': { class: 'superseded', reason: 'replaced by the composed package.json' },
	'src/old/legacy.ts': { class: 'dropped', reason: 'removed upstream' },
	'README.md': { class: 'brand-l3', reason: 'brand note kept by hand' },
};
const tracked = new Set(['package.json', 'src/old/legacy.ts', 'src/components/Card.tsx']);
const legacyTreePaths = ['package.json', 'src/old/legacy.ts', 'src/components/Card.tsx'];

test('adoption guard and legacy-source bypass: plain apply over an unadopted tree refuses and writes nothing', async (t) => {
	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	legacyTree(w);
	const before = snapshot(w.out);
	await failsWith(apply(w.opts()), 'adoption-required');
	assert.ok(equalSnapshots(before, snapshot(w.out)), 'nothing written to the build directory');
	assert.equal(existsSync(path.join(w.repo, '.compose-history')), false, 'no history entry either');
	const dry = await dryRun(w.opts());
	assert.equal(dry.legacy, true);
	assert.ok(dry.notes.some((n) => n.includes('adoption required')));
	assert.ok(equalSnapshots(before, snapshot(w.out)));

	// --adopt with a stale inventory refuses
	const composed = await composedShas(w);
	const inv = buildInventory({ outDir: w.out, composed, dispositions, tracked, legacyTreePaths, legacyTag: 'pre-compose-test', legacyCommit: 'c'.repeat(40) });
	assert.equal(inv.rows.filter((r) => r.class === 'unexplained').length, 0);
	assert.deepEqual(inv.retire, ['src/old/legacy.ts']);
	const invFile = path.join(w.root, 'inv.json');
	writeFileSync(invFile, JSON.stringify(inv));
	writeFileSync(w.outPath('README.md'), 'hand notes, edited after the inventory\n');
	await failsWith(apply({ ...w.opts(), adoptFile: invFile }), 'inventory-stale');
	writeFileSync(w.outPath('README.md'), 'hand notes\n');
	w.write(w.outPath('src/stray.ts'), 'planted\n');
	await failsWith(apply({ ...w.opts(), adoptFile: invFile }), 'inventory-stale');
	rmSync(w.outPath('src/stray.ts'));

	// an unexplained row refuses
	const bad = buildInventory({ outDir: w.out, composed, dispositions: { ...dispositions, 'README.md': undefined }, tracked, legacyTreePaths });
	writeFileSync(invFile, JSON.stringify(bad));
	await failsWith(apply({ ...w.opts(), adoptFile: invFile }), 'inventory-unexplained');

	// a retire list naming an untracked file refuses
	const evil = { ...inv, retire: [...inv.retire, 'README.md'] };
	writeFileSync(invFile, JSON.stringify(evil));
	await failsWith(apply({ ...w.opts(), adoptFile: invFile }), 'retire-invalid');
	assert.equal(readFileSync(w.outPath('README.md'), 'utf8'), 'hand notes\n');

	// the valid adoption
	writeFileSync(invFile, JSON.stringify(inv));
	const r = await apply({ ...w.opts(), adoptFile: invFile });
	assert.deepEqual(r.retired, ['src/old/legacy.ts']);
	assert.equal(existsSync(w.outPath('src/old/legacy.ts')), false);
	assert.equal(readFileSync(w.outPath('README.md'), 'utf8'), 'hand notes\n', 'untracked files are never retired');
	assert.equal(readFileSync(w.outPath('.env'), 'utf8'), 'VITE_STORE_NAME=Fixture Store\n');
	assert.equal(readFileSync(w.outPath('node_modules/pkg/index.js'), 'utf8'), 'm');
	assert.equal(readFileSync(w.outPath('dist/index.html'), 'utf8'), '<html>');
	const adoption = readJ(w.outPath('.compose-adoption.json'));
	assert.equal(adoption.legacyTag, 'pre-compose-test');
	assert.deepEqual(adoption.retired, ['src/old/legacy.ts']);
	assert.ok(adoption.additions.includes('vendor/storefront-client/package.json'));
	assert.ok(adoption.additions.includes('.env.production') && adoption.additions.includes('.compose-managed.json'));
	assert.ok(!adoption.additions.includes('package.json') && !adoption.additions.includes('src/components/Card.tsx'));
	assert.ok(existsSync(path.join(w.repo, '.compose-history', 'compose-adoption.json')));

	// a second apply needs no --adopt; additions are recomputed and include files a later pin adds
	w.write(w.basePath('src/components/NewThing.tsx'), 'export {};\n');
	await apply(w.opts());
	assert.ok(readJ(w.outPath('.compose-adoption.json')).additions.includes('src/components/NewThing.tsx'));

	// returned to legacy by the legacy rollback (compose bookkeeping removed): plain apply refuses again
	rmSync(w.outPath('.compose-managed.json'));
	rmSync(w.outPath('.compose-adoption.json'));
	await failsWith(apply(w.opts()), 'adoption-required');
});

// ---------------------------------------------------------------- closure

const pkgFiles = (scripts, extra = {}) => new Map([['package.json', JSON.stringify({ scripts })], ...Object.entries(extra)]);

test('closure: missing script, undeclared and declared externals, missing dir and pnpm script', () => {
	const p = new Problems();
	checkClosure({ files: pkgFiles({ a: 'node scripts/nope.mjs', b: 'bash scripts/here.sh', c: 'node ../scripts/x.mjs', d: 'node /opt/y.mjs', e: 'pnpm run missing', f: 'pnpm --dir vendor/none run build' }, { 'scripts/here.sh': '' }), brand: {}, problems: p });
	assert.deepEqual(p.codes().sort(), ['closure-external-undeclared', 'closure-missing-dir', 'closure-missing-pnpm-script', 'closure-missing-script']);

	const ok = new Problems();
	const r = checkClosure({ files: pkgFiles({ c: 'node ../scripts/x.mjs', d: 'node /opt/y.mjs' }), brand: { externals: ['../scripts/x.mjs', '/opt/y.mjs'] }, problems: ok, externalExists: () => false });
	assert.equal(ok.any, false);
	assert.deepEqual(r.usedExternals, ['../scripts/x.mjs', '/opt/y.mjs']);
	assert.deepEqual(r.externalsMissing, ['../scripts/x.mjs', '/opt/y.mjs'], 'a missing external is reported, not failed');
});

test('closure: node -e, --eval and -p are rejected; a script argument is not a node flag', () => {
	for (const cmd of ['node -e "1"', 'node --eval=1', 'node -p 2', 'node --max-old-space-size=4096 -e x', 'echo a && node -pe 1']) {
		const p = new Problems();
		checkClosure({ files: pkgFiles({ x: cmd }), brand: {}, problems: p });
		assert.ok(p.codes().includes('node-eval'), cmd);
	}
	const p = new Problems();
	checkClosure({ files: pkgFiles({ x: 'node scripts/a.mjs -p' }, { 'scripts/a.mjs': '' }), brand: {}, problems: p });
	assert.equal(p.any, false);
});

test('closure: the vendored client scripts and the brand build script are scanned', () => {
	const files = pkgFiles({ build: 'echo ok' }, { 'vendor/storefront-client/package.json': JSON.stringify({ scripts: { build: 'node -e "1"' } }), 'scripts/b.sh': 'node -p 1\n' });
	const p = new Problems();
	const r = checkClosure({ files, brand: { buildScript: 'scripts/b.sh' }, problems: p });
	assert.equal(p.list.filter((x) => x.code === 'node-eval').length, 2);
	assert.ok(r.scanned.includes('scripts/b.sh'));
});

test('a patched script that brings back node -e fails compose', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	editBrand(w, (b) => (b.packageScripts.build = 'node -e "console.log(1)"'));
	await failsWith(apply(w.opts()), 'node-eval');
	assert.equal(existsSync(w.out), false);
});

test('a base script file that the build calls but the tree lacks fails the closure', async (t) => {
	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	rmSync(w.basePath('scripts/clean.mjs'));
	await failsWith(apply(w.opts()), 'closure-missing-script');
	assert.equal(existsSync(w.out), false);
});

test('closure: generated runtime artifacts and composition-excluded tooling are not missing inputs, and only that', () => {
	const scripts = { serve: 'node server/entry.express.js', 'test:tools': 'node --test tools/compose/compose.test.mjs', other: 'node dist/x.js', gone: 'node scripts/gone.mjs' };
	const p = new Problems();
	const r = checkClosure({ files: pkgFiles(scripts), brand: {}, problems: p });
	assert.deepEqual(p.list.map((x) => x.message.split(' ')[0]), ['package.json#scripts.gone'], 'a genuinely missing script is still reported');
	assert.deepEqual(r.generatedArtifacts, ['dist/x.js', 'server/entry.express.js']);
	assert.deepEqual(r.excludedTooling, ['tools/compose/compose.test.mjs']);

	// a brand that ships tools/ (baseExclude: []) gets them checked
	const shipped = new Problems();
	checkClosure({ files: pkgFiles({ 'test:tools': scripts['test:tools'] }), brand: { baseExclude: [] }, problems: shipped });
	assert.deepEqual(shipped.codes(), ['closure-missing-script']);
	// a script the brand patches in must run in the built tree: no exemption for excluded tooling
	const patched = new Problems();
	checkClosure({ files: pkgFiles({ 'test:tools': scripts['test:tools'] }), brand: { packageScripts: { 'test:tools': scripts['test:tools'] } }, problems: patched });
	assert.deepEqual(patched.codes(), ['closure-missing-script']);
	// ...nor for the brand build script
	const build = new Problems();
	checkClosure({ files: pkgFiles({}, { 'scripts/b.sh': 'node tools/x.mjs\n' }), brand: { buildScript: 'scripts/b.sh' }, problems: build });
	assert.deepEqual(build.codes(), ['closure-missing-script']);
});

test('closure: the REAL storefront package.json script set closes over the REAL composed file set', (t) => {
	const base = openBase({ baseDir: REPO_ROOT, pin: PIN });
	t.after(() => base.cleanup());
	const keep = new Set(['package.json', 'vendor/storefront-client/package.json']);
	const files = new Map([...base.files.keys()].map((rel) => [rel, keep.has(rel) ? base.read(rel) : Buffer.alloc(0)]));
	assert.ok(JSON.parse(String(files.get('package.json'))).scripts.serve, 'the real script set is what is under test');
	const p = new Problems();
	const r = checkClosure({ files, brand: {}, problems: p });
	assert.deepEqual(p.list, []);
	assert.ok(r.scanned.includes('package.json#scripts.serve') && r.scanned.includes('package.json#scripts.test:tools'));
	assert.ok(r.generatedArtifacts.includes('server/entry.express.js'));
	assert.ok(r.excludedTooling.includes('tools/compose/compose.test.mjs'));
});

// ---------------------------------------------------------------- overlay checkers

test('both checkers are packaged with the tool and match the repo scripts byte for byte', () => {
	assert.equal(CHECKERS_DIR, path.join(HERE, 'checkers'));
	for (const name of ['check-imports.mjs', 'check-code-shape.mjs']) {
		const packaged = path.join(HERE, 'checkers', name);
		assert.ok(existsSync(packaged), `${name} must be packaged in tools/compose/checkers (the cold tool home archives tools/compose only)`);
		assert.equal(readFileSync(packaged, 'utf8'), readFileSync(path.join(HERE, '..', '..', 'scripts', name), 'utf8'), `${name} drifted from scripts/; run: cp scripts/${name} tools/compose/checkers/${name}`);
	}
	assert.ok(!readFileSync(path.join(HERE, 'compose.mjs'), 'utf8').includes("'scripts', 'check-"), 'compose.mjs must not reach outside the tool home for a checker');
});

test('overlay code is checked by BOTH checkers: forbidden imports, L1 bypass and direct network calls block compose', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	const bad = {
		'src/brand-slots/Forbidden.tsx': ["import { c } from '@sellright/storefront-client';\nexport const a = c;\n", 'import-check'],
		'src/brand-slots/Bypass.tsx': ["import { Layout } from '~/routes/layout';\nexport const a = Layout;\n", 'import-check'],
		'src/brand-slots/Net.tsx': ["export const a = () => fetch('/shop-api');\n", 'shape-check'],
		'src/brand-slots/Wrapped.tsx': ["export const a = () => (globalThis).fetch('/shop-api');\n", 'shape-check'],
		'src/brand-slots/Forbidden2.tsx': ["import { c } from '@sellright/storefront-client';\nexport const a = c;\n", 'shape-check'],
	};
	for (const [rel, [text, code]] of Object.entries(bad)) {
		w.write(w.layerPath(`overlay/${rel}`), text);
		await failsWith(dryRun(w.opts()), code);
		await failsWith(apply(w.opts()), code);
		rmSync(w.layerPath(`overlay/${rel}`));
	}
	assert.equal(existsSync(w.out), false, 'nothing was composed');
	const ok = await dryRun(w.opts());
	assert.equal(ok.report.importCheck.status, 'passed');
	assert.equal(ok.report.shapeCheck.status, 'passed');
});

test('a checker that cannot run fails compose; it is never reported as unavailable and passed over', async (t) => {
	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	const empty = mkdtempSync(path.join(tmpdir(), 'compose-nocheckers-'));
	t.after(() => rmSync(empty, { recursive: true, force: true }));
	const missing = await failsWith(dryRun({ ...w.opts(), checkersDir: empty }), 'import-check-unavailable');
	assert.ok(missing.details.some((d) => d.code === 'shape-check-unavailable'));
	await failsWith(apply({ ...w.opts(), checkersDir: empty }), 'import-check-unavailable');
	assert.equal(existsSync(w.out), false);

	const full = readFileSync(w.basePath('layers.json'), 'utf8');
	// the pre-A14 minimal layers.json shape (no platformApi, imports, codeShape)
	editBase(w, 'layers.json', (s) => JSON.stringify({ version: 1, layers: JSON.parse(s).layers }));
	const minimal = await failsWith(dryRun(w.opts()), 'import-check-unavailable');
	assert.ok(minimal.details.some((d) => d.code === 'shape-check-unavailable'));
	// only codeShape missing: the import checker runs, the shape checker cannot
	editBase(w, 'layers.json', () => JSON.stringify({ ...JSON.parse(full), codeShape: undefined }));
	const noShape = await failsWith(dryRun(w.opts()), 'shape-check-unavailable');
	assert.ok(!noShape.details.some((d) => d.code === 'import-check-unavailable'));
	editBase(w, 'layers.json', () => full);
	await dryRun(w.opts());
});

test('a layers.json shipped in the overlay cannot replace the base layers the checkers use', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	editBrand(w, (b) => b.deployFiles.push('layers.json'));
	// a permissive layers.json that puts everything in L3 and forbids nothing
	const permissive = { ...readJ(path.join(BASE_FIXTURE, 'packages/storefront/layers.json')), imports: { forbidden: [], codeExtensions: ['.ts'], assetExtensions: [] } };
	w.write(w.layerPath('overlay/layers.json'), JSON.stringify(permissive));
	w.write(w.layerPath('overlay/src/brand-slots/Forbidden.tsx'), "import { c } from '@sellright/storefront-client';\nexport const a = c;\n");
	await failsWith(dryRun(w.opts()), 'import-check');
});

// ---------------------------------------------------------------- misc units

test('renderWorkspace keeps hardening settings and replaces the packages block', () => {
	const out = renderWorkspace('packages:\n  - "packages/*"\n  # c\n  - "!packages/admin"\n\n# H\nblockExoticSubdeps: true\nallowBuilds:\n  esbuild: true\n');
	assert.equal(out, 'packages:\n  - "."\n  - "vendor/storefront-client"\n\n# H\nblockExoticSubdeps: true\nallowBuilds:\n  esbuild: true\n');
});

test('self-check passes only when typescript and vite resolve inside the tool home', () => {
	const home = mkdtempSync(path.join(tmpdir(), 'compose-home-'));
	const out = mkdtempSync(path.join(tmpdir(), 'compose-out-'));
	try {
		for (const [dir, name] of [[home, 'typescript'], [home, 'vite'], [out, 'vite']]) {
			mkdirSync(path.join(dir, 'node_modules', name), { recursive: true });
			writeFileSync(path.join(dir, 'node_modules', name, 'index.js'), '');
		}
		const url = (d, n) => pathToFileURL(path.join(d, 'node_modules', n, 'index.js')).href;
		assert.equal(selfCheck({ toolHome: home, resolve: (n) => url(home, n) }).ok, true);
		assert.equal(selfCheck({ toolHome: home, resolve: (n) => (n === 'vite' ? url(out, n) : url(home, n)) }).ok, false);
		assert.equal(selfCheck({ toolHome: home, resolve: () => { throw Object.assign(new Error('nope'), { code: 'ERR_MODULE_NOT_FOUND' }); } }).ok, false);
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(out, { recursive: true, force: true });
	}
});

let viteAvailable = true;
try {
	await import('vite');
} catch {
	viteAvailable = false;
}

test('CLI: dry run through compose.mjs with the real Vite loadEnv', { skip: !viteAvailable && 'vite is not resolvable from this directory (missing coverage, not a pass)' }, (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	const r = spawnSync(process.execPath, [path.join(HERE, 'compose.mjs'), w.layer, '--out', w.out, '--base-dir', w.base, '--pin', PIN, '--dry-run', '--require-out-pair'], { encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
	assert.ok(r.stdout.includes('dry run: nothing written'));
	assert.equal(existsSync(w.out), false);
	const bad = spawnSync(process.execPath, [path.join(HERE, 'compose.mjs'), w.layer, '--dry-run'], { encoding: 'utf8' });
	assert.equal(bad.status, 2);
});
