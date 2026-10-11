// node --test tools/compose/drift.test.mjs   (cwd: packages/storefront)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { apply } from './compose.mjs';
import { main as driftMain } from '../drift/drift.mjs';
import { openBase } from './lib/base.mjs';
import { accept, checkDrift, describeDrift, migrate, readopt } from './lib/drift-core.mjs';
import { loadLayer } from './lib/layer.mjs';
import { parseLayers } from './lib/layers.mjs';
import { Problems, sha256 } from './lib/util.mjs';
import { PIN, PIN2, makeWorld } from './fixtures/support.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'drift', 'drift.mjs');
const BTN = 'src/components/Button.tsx';
const readJ = (p) => JSON.parse(readFileSync(p, 'utf8'));

async function failsWith(promise, code) {
	let err;
	try {
		await promise;
	} catch (e) {
		err = e;
	}
	assert.ok(err, `expected ${code}`);
	const codes = err.code === 'validation' ? err.details.map((d) => d.code) : [err.code];
	assert.ok(codes.includes(code), `expected ${code}, got ${codes.join(', ')}`);
	return err;
}

function world(t) {
	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	return w;
}
const open = (w) => ({ layer: loadLayer(w.layer), base: openBase({ baseDir: w.base, pin: PIN }) });
const entryOf = (layer, id) => layer.manifest.entries.find((e) => (e.kind === 'package-script' ? `package.json#scripts.${e.key}` : e.path) === id);
const editManifest = (w, fn) => {
	const f = w.layerPath('overlay.manifest.json');
	const m = readJ(f);
	fn(m);
	writeFileSync(f, JSON.stringify(m, null, 2));
};
/** Re-baseline the Button eject on `text` (base file, snapshot and recorded hashes). */
function baselineButton(w, text) {
	writeFileSync(w.basePath(BTN), text);
	writeFileSync(w.layerPath(`overlay.base/${BTN}`), text);
	editManifest(w, (m) => {
		const e = m.entries.find((x) => x.path === BTN);
		e.baseHash = e.baseSnapshotHash = sha256(text);
	});
}
const tenLines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}\n`);

test('an upstream insertion yields a correct unified hunk and the override diff is against the old base', (t) => {
	const w = world(t);
	baselineButton(w, tenLines.join(''));
	writeFileSync(w.layerPath(`overlay/${BTN}`), tenLines.map((l) => (l === 'line 8\n' ? 'line 8 brand\n' : l)).join(''));
	writeFileSync(w.basePath(BTN), [...tenLines.slice(0, 5), 'inserted upstream\n', ...tenLines.slice(5)].join(''));
	const { layer, base } = open(w);
	const d = describeDrift({ entry: entryOf(layer, BTN), layer, base });
	assert.equal(d.snapshotOk, true);
	assert.equal(d.orphaned, false);
	assert.match(d.upstreamDiff, /^@@ -3,6 \+3,7 @@/m);
	assert.ok(d.upstreamDiff.includes('+inserted upstream\n'));
	assert.ok(d.upstreamDiff.includes(' line 5\n') && d.upstreamDiff.includes(' line 6\n'), 'three lines of context each side');
	assert.ok(d.upstreamDiff.includes(`old/${BTN}`) && d.upstreamDiff.includes(`new/${BTN}`));
	assert.ok(!d.upstreamDiff.includes('line 8 brand'));
	assert.ok(d.overrideDiff.includes('-line 8\n') && d.overrideDiff.includes('+line 8 brand\n'));
	assert.ok(!d.overrideDiff.includes('inserted upstream'));
	assert.notEqual(d.newBaseHash, d.oldBaseHash);
});

test('an unchanged eject reports no drift', (t) => {
	const w = world(t);
	const { layer, base } = open(w);
	const gate = new Problems();
	const recs = checkDrift({ layer, base, pin: PIN, problems: gate });
	assert.equal(gate.any, false);
	assert.deepEqual(recs.map((r) => r.status), ['unchanged', 'unchanged', 'unchanged']);
});

test('a tampered snapshot is rejected by the gate, the report and every action', async (t) => {
	const w = world(t);
	writeFileSync(w.layerPath(`overlay.base/${BTN}`), 'export const Button = "tampered";\n');
	writeFileSync(w.basePath(BTN), `${readFileSync(w.basePath(BTN), 'utf8')}// upstream\n`);
	const { layer, base } = open(w);
	const gate = new Problems();
	checkDrift({ layer, base, pin: PIN, problems: gate });
	assert.ok(gate.codes().includes('snapshot-tampered'));
	const d = describeDrift({ entry: entryOf(layer, BTN), layer, base });
	assert.equal(d.snapshotOk, false);
	assert.equal(d.upstreamDiff, '');
	assert.throws(() => accept({ layerDir: w.layer, base, pin: PIN, id: BTN, text: 'looked fine' }), /snapshot-tampered/);
	assert.throws(() => migrate({ layerDir: w.layer, layers: parseLayers(readJ(w.basePath('layers.json'))), base, pin: PIN, from: BTN, to: 'src/components/Other.tsx' }), /snapshot-tampered|not-orphaned/);
	await failsWith(apply(w.opts()), 'snapshot-tampered');
	assert.equal(existsSync(w.out), false);

	// a snapshot that was re-hashed but disagrees with baseHash is caught too
	writeFileSync(w.layerPath(`overlay.base/${BTN}`), readFileSync(w.basePath(BTN)));
	editManifest(w, (m) => (m.entries.find((e) => e.path === BTN).baseSnapshotHash = sha256(readFileSync(w.basePath(BTN)))));
	await failsWith(apply(w.opts()), 'snapshot-mismatch');
});

test('accept: compose fails on an unresolved changed base and passes after --accept', async (t) => {
	const w = world(t);
	const changed = `${readFileSync(w.basePath(BTN), 'utf8')}export const Extra = 1;\n`;
	writeFileSync(w.basePath(BTN), changed);
	await failsWith(apply(w.opts()), 'drift-unresolved');
	{
		const { base } = open(w);
		assert.throws(() => accept({ layerDir: w.layer, base, pin: PIN, id: BTN, text: '   ' }), /resolution-required/);
		const r = accept({ layerDir: w.layer, base, pin: PIN, id: BTN, text: 'reviewed: extra export does not affect the brand button', now: new Date('2026-10-10T00:00:00Z') });
		assert.equal(r.baseHash, sha256(changed));
		assert.throws(() => accept({ layerDir: w.layer, base, pin: PIN, id: BTN, text: 'again' }), /nothing-to-accept/);
	}
	const e = readJ(w.layerPath('overlay.manifest.json')).entries.find((x) => x.path === BTN);
	assert.equal(e.baseHash, sha256(changed));
	assert.equal(e.baseSnapshotHash, sha256(changed));
	assert.equal(e.fromPin, PIN);
	assert.equal(e.resolution.action, 'accept');
	assert.equal(e.resolution.text, 'reviewed: extra export does not affect the brand button');
	assert.equal(e.resolution.at, '2026-10-10T00:00:00.000Z');
	assert.equal(readFileSync(w.layerPath(`overlay.base/${BTN}`), 'utf8'), changed);
	await apply(w.opts());
	assert.equal(readFileSync(w.outPath(BTN), 'utf8'), readFileSync(w.layerPath(`overlay/${BTN}`), 'utf8'), 'the brand override still wins');
});

test('a recorded resolution counts only for its own pin and the exact new hash', async (t) => {
	const w = world(t);
	const changed = `${readFileSync(w.basePath(BTN), 'utf8')}export const Extra = 1;\n`;
	writeFileSync(w.basePath(BTN), changed);
	const h = sha256(changed);
	editManifest(w, (m) => (m.entries.find((e) => e.path === BTN).resolution = { pin: PIN2, baseHash: h, text: 'for another pin' }));
	await failsWith(apply(w.opts()), 'drift-unresolved');
	editManifest(w, (m) => (m.entries.find((e) => e.path === BTN).resolution = { pin: PIN, baseHash: sha256('something else'), text: 'for another hash' }));
	await failsWith(apply(w.opts()), 'drift-unresolved');
	editManifest(w, (m) => (m.entries.find((e) => e.path === BTN).resolution = { pin: PIN, baseHash: h, text: 'for this pin and this hash' }));
	await apply(w.opts());
});

test('readopt: the override and its entry are dropped and the new base is used', async (t) => {
	const w = world(t);
	const changed = `${readFileSync(w.basePath(BTN), 'utf8')}export const Extra = 1;\n`;
	writeFileSync(w.basePath(BTN), changed);
	await failsWith(apply(w.opts()), 'drift-unresolved');
	readopt({ layerDir: w.layer, pin: PIN, id: BTN, text: 'brand no longer needs this eject', now: new Date('2026-10-10T00:00:00Z') });
	assert.equal(existsSync(w.layerPath(`overlay/${BTN}`)), false);
	assert.equal(existsSync(w.layerPath(`overlay.base/${BTN}`)), false);
	const m = readJ(w.layerPath('overlay.manifest.json'));
	assert.equal(m.entries.some((e) => e.path === BTN), false);
	assert.deepEqual(m.resolutions.map((r) => [r.action, r.id]), [['readopt', BTN]]);
	await apply(w.opts());
	assert.equal(readFileSync(w.outPath(BTN), 'utf8'), changed);
	assert.equal(readJ(w.outPath('.compose-managed.json')).files.find((f) => f.path === BTN).origin, 'base');
});

test('a patched script key drifts like an eject: accept and readopt both work', async (t) => {
	const w = world(t);
	const id = 'package.json#scripts.build';
	const newBuild = 'pnpm run lint && pnpm run clean && pnpm run build.client && pnpm run build.server';
	const pkg = readJ(w.basePath('package.json'));
	pkg.scripts.build = newBuild;
	writeFileSync(w.basePath('package.json'), `${JSON.stringify(pkg, null, '\t')}\n`);
	const err = await failsWith(apply(w.opts()), 'drift-unresolved');
	assert.ok(err.details.some((d) => d.file === id));
	{
		const { layer, base } = open(w);
		const d = describeDrift({ entry: entryOf(layer, id), layer, base });
		assert.ok(d.upstreamDiff.includes('+pnpm run lint && pnpm run clean && pnpm run build.client && pnpm run build.server'));
		assert.ok(d.overrideDiff.includes('+bash scripts/build-production.sh'));
		accept({ layerDir: w.layer, base, pin: PIN, id, text: 'build chain reviewed; the brand script still replaces it' });
	}
	await apply(w.opts());
	assert.equal(readJ(w.outPath('package.json')).scripts.build, 'bash scripts/build-production.sh');

	// readopt: the patch goes away entirely and the base script is used
	const pkg2 = readJ(w.basePath('package.json'));
	pkg2.scripts.build = `${newBuild} && echo more`;
	writeFileSync(w.basePath('package.json'), `${JSON.stringify(pkg2, null, '\t')}\n`);
	await failsWith(apply(w.opts()), 'drift-unresolved');
	readopt({ layerDir: w.layer, pin: PIN, id, text: 'use the base build again' });
	assert.equal('build' in readJ(w.layerPath('brand.json')).packageScripts, false);
	await apply(w.opts());
	assert.equal(readJ(w.outPath('package.json')).scripts.build, pkg2.scripts.build);
});

test('migrate: an eject whose base file moved upstream follows it', async (t) => {
	const w = world(t);
	mkdirSync(w.basePath('src/components/ui'), { recursive: true });
	renameSync(w.basePath(BTN), w.basePath('src/components/ui/Button.tsx'));
	await failsWith(apply(w.opts()), 'orphaned-eject');
	const { base } = open(w);
	const layers = parseLayers(readJ(w.basePath('layers.json')));
	const override = readFileSync(w.layerPath(`overlay/${BTN}`));
	assert.throws(() => migrate({ layerDir: w.layer, layers, base, pin: PIN, from: BTN, to: 'src/components/nowhere/Button.tsx' }), /no-such-base-file/);
	assert.throws(() => migrate({ layerDir: w.layer, layers, base, pin: PIN, from: BTN, to: 'src/brand/tokens.css' }), /not-l2/);
	assert.throws(() => migrate({ layerDir: w.layer, layers, base, pin: PIN, from: 'src/brand/tokens.css', to: 'src/components/ui/Button.tsx' }), /not-an-eject/);
	const r = migrate({ layerDir: w.layer, layers, base, pin: PIN, from: BTN, to: 'src/components/ui/Button.tsx' });
	assert.equal(r.id, 'src/components/ui/Button.tsx');
	assert.equal(existsSync(w.layerPath(`overlay/${BTN}`)), false);
	assert.equal(existsSync(w.layerPath(`overlay.base/${BTN}`)), false);
	assert.deepEqual(readFileSync(w.layerPath('overlay/src/components/ui/Button.tsx')), override);
	const e = readJ(w.layerPath('overlay.manifest.json')).entries.find((x) => x.path === 'src/components/ui/Button.tsx');
	assert.equal(e.baseHash, sha256(readFileSync(w.basePath('src/components/ui/Button.tsx'))));
	assert.equal(e.resolution.action, 'migrate');
	await apply(w.opts());
	assert.deepEqual(readFileSync(w.outPath('src/components/ui/Button.tsx')), override);
	assert.equal(existsSync(w.outPath(BTN)), false);
	// an eject whose file still exists upstream is not migratable
	assert.throws(() => migrate({ layerDir: w.layer, layers, base, pin: PIN, from: 'src/components/ui/Button.tsx', to: 'src/components/Card.tsx' }), /not-orphaned/);
});

test('CLI: report with diffs and exit 1 while drifted, accept through main(), exit 0 when clean', async (t) => {
	const w = world(t);
	const run = (args) => spawnSync(process.execPath, [CLI, w.layer, '--base-dir', w.base, ...args], { encoding: 'utf8' });
	assert.equal(run([]).status, 0);
	const changed = `${readFileSync(w.basePath(BTN), 'utf8')}export const Extra = 1;\n`;
	writeFileSync(w.basePath(BTN), changed);
	const r = run([]);
	assert.equal(r.status, 1);
	assert.ok(r.stdout.includes(`== ${BTN} [CHANGED]`));
	assert.ok(r.stdout.includes('+export const Extra = 1;'));
	assert.ok(r.stdout.includes('3 eject(s), 1 problem(s)'));
	let text = '';
	const noResolution = await driftMain([w.layer, '--base-dir', w.base, '--accept', BTN], { out: (s) => (text += s) }).catch((e) => e);
	assert.match(String(noResolution.message), /resolution-required/);
	const code = await driftMain([w.layer, '--base-dir', w.base, '--accept', BTN, '--resolution', 'reviewed'], { out: (s) => (text += s) });
	assert.equal(code, 0);
	assert.ok(text.includes(`accepted ${BTN}`));
	assert.equal(run([]).status, 0);
});
