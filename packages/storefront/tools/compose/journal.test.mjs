// node --test tools/compose/journal.test.mjs   (cwd: packages/storefront)
// Plan A §4.3 step 4a, §4.6a b: journal, --recover, lock, --live, --check-build-env, --mark-built --build-config, exit codes (finding C3, C8, C11).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FAULT_STEPS, apply, checkBuildEnv, exitCodeFor, faultHook, inventory, plan, recover, withBrandLock } from './compose.mjs';
import { buildInventory } from './lib/inventory.mjs';
import { LOCK_NAME, acquireLock, assertNoJournal, beginJournal, journalRootFor, pendingJournals, recoverJournals } from './lib/journal.mjs';
import { abandonEntry, historyDirFor, listEntries, markBuilt } from './lib/history.mjs';
import { ComposeError, hashJson, sha256 } from './lib/util.mjs';
import { acquireOsLock } from './lib/os-lock.mjs';
import { equalSnapshots, makeWorld, snapshot } from './fixtures/support.mjs';
import { fsyncHooks } from './lib/durable.mjs';

const child = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures/child.mjs');
const runChild = (scenario, data) => new Promise((r) => spawn(process.execPath, [child, JSON.stringify({ scenario, ...data })], { stdio: 'ignore' }).on('exit', (c, sig) => r(sig ?? c)));

const readJ = (p) => JSON.parse(readFileSync(p, 'utf8'));
const crash = (point) => (step) => {
	if (step === point) throw new Error(`injected crash after ${step}`);
};

/** A managed tree, then inputs that make the next apply write, remove and rewrite the managed files. */
async function managedWorld(t) {
	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	w.write(w.outPath('.env'), 'VITE_STORE_NAME=Fixture Store\n');
	await apply(w.opts());
	rmSync(w.layerPath('overlay/src/brand-slots/Hello.tsx'));
	const mf = w.layerPath('overlay.manifest.json');
	const m = readJ(mf);
	m.entries = m.entries.filter((e) => e.path !== 'src/brand-slots/Hello.tsx');
	writeFileSync(mf, JSON.stringify(m, null, 2));
	rmSync(w.basePath('src/components/Card.tsx'));
	w.write(w.basePath('src/components/NewThing.tsx'), 'export const n = 1;\n');
	w.write(w.layerPath('overlay/src/brand/extra.css'), ':root { --extra: 1; }\n');
	m.entries.push({ path: 'src/brand/extra.css', layer: 'L3' });
	writeFileSync(mf, JSON.stringify(m, null, 2));
	return w;
}

test('each journal step: a crash leaves a journal, every other mode refuses, --recover restores the exact previous tree', async (t) => {
	for (const step of FAULT_STEPS) {
		const w = await managedWorld(t);
		const before = snapshot(w.out);
		const historyBefore = listEntries(w.layer).length;
		await assert.rejects(apply({ ...w.opts(), fault: crash(step) }), /injected crash/);
		assert.equal(pendingJournals(w.repo).length, 1, `${step}: journal kept`);
		assert.equal(existsSync(path.join(w.repo, LOCK_NAME)), false, `${step}: lock released on failure`);
		assert.throws(() => assertNoJournal(w.repo), (e) => e.code === 'journal-present' && exitCodeFor(e) === 5);
		await assert.rejects(apply(w.opts()), (e) => e.code === 'journal-present');
		const done = await recover({ layerDir: w.layer, outDir: w.out });
		assert.equal(done.length, 1);
		assert.ok(equalSnapshots(before, snapshot(w.out)), `${step}: build directory is byte for byte the previous one`);
		assert.deepEqual(pendingJournals(w.repo), []);
		const entries = listEntries(w.layer);
		assert.equal(entries.length, historyBefore + 1, `${step}: the interrupted history entry is kept`);
		assert.equal(entries.at(-1).meta.status, 'abandoned');
		// idempotent, and the next apply works
		assert.deepEqual(await recover({ layerDir: w.layer, outDir: w.out }), []);
		assert.ok(equalSnapshots(before, snapshot(w.out)));
		const ok = await apply(w.opts());
		assert.ok(ok.changes.length > 0);
		assert.deepEqual(pendingJournals(w.repo), []);
	}
});

test('the journal exists, with previous bytes and every intended addition, before the first output change and before the history entry', async (t) => {
	const w = await managedWorld(t);
	const prevManaged = readFileSync(w.outPath('.compose-managed.json'));
	let seen;
	await assert.rejects(
		apply({
			...w.opts(),
			fault: (step) => {
				if (step !== 'retire') return;
				const dir = path.join(journalRootFor(w.repo), pendingJournals(w.repo)[0]);
				seen = { doc: readJ(path.join(dir, 'journal.json')), dir };
				throw new Error('stop');
			},
		}),
		/stop/,
	);
	const byRel = new Map(seen.doc.entries.filter((e) => e.root === 'out').map((e) => [e.rel, e]));
	assert.equal(byRel.get('.compose-managed.json').present, true);
	assert.equal(byRel.get('.compose-managed.json').sha256, sha256(prevManaged));
	assert.equal(readFileSync(path.join(seen.dir, 'prev', String(byRel.get('.compose-managed.json').n))).equals(prevManaged), true, 'previous bytes stored');
	assert.equal(byRel.get('src/components/NewThing.tsx').present, false, 'an intended addition is recorded as absent');
	assert.equal(byRel.get('src/components/Card.tsx').present, true, 'a path to be removed keeps its bytes');
	assert.equal(typeof byRel.get('src/components/Card.tsx').mode, 'number');
	assert.ok(seen.doc.history, 'the history entry id is recorded');
	assert.ok(seen.doc.entries.some((e) => e.root === 'history' && e.rel === 'compose-adoption.json'));
	assert.ok(readdirSync(path.join(w.repo, '.compose-history')).some((n) => n === seen.doc.history));
});

test('a journal that never finished beginning (a .tmp directory) changed nothing and does not block', async (t) => {
	const w = await managedWorld(t);
	mkdirSync(path.join(journalRootFor(w.repo), '2026T-1.tmp', 'prev'), { recursive: true });
	assert.deepEqual(pendingJournals(w.repo), []);
	await apply(w.opts());
	assert.deepEqual(await recover({ layerDir: w.layer, outDir: w.out }), []);
});

test('success deletes the journal last; recover with no journal writes nothing', async (t) => {
	const w = await managedWorld(t);
	await apply(w.opts());
	assert.deepEqual(pendingJournals(w.repo), []);
	assert.equal(existsSync(path.join(w.repo, LOCK_NAME)), false);
	const before = snapshot(w.out);
	const histBefore = snapshot(path.join(w.repo, '.compose-history'));
	assert.deepEqual(await recover({ layerDir: w.layer, outDir: w.out }), []);
	assert.ok(equalSnapshots(before, snapshot(w.out)));
	assert.ok(equalSnapshots(histBefore, snapshot(path.join(w.repo, '.compose-history'))));
});

test('a final read-back mismatch after all writes also leaves a journal that recovers', async (t) => {
	const w = await managedWorld(t);
	const before = snapshot(w.out);
	// a loadEnv that disagrees with the planned config, but only for the final read-back (armed once every step is written)
	let armed = false;
	const flaky = (mode, dir, prefix) => {
		const real = w.opts().loadEnv(mode, dir, prefix);
		return armed ? { ...real, VITE_STORE_NAME: 'tampered' } : real;
	};
	const arm = (step) => {
		if (step === 'adoption') armed = true;
	};
	await assert.rejects(apply({ ...w.opts(), loadEnv: flaky, fault: arm }), (e) => e.code === 'effective-config-mismatch' && exitCodeFor(e) === 7);
	assert.equal(pendingJournals(w.repo).length, 1);
	await recover({ layerDir: w.layer, outDir: w.out });
	assert.ok(equalSnapshots(before, snapshot(w.out)));
});

test('retire step: a first adoption that is interrupted restores the retired legacy file', async (t) => {
	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	w.write(w.outPath('package.json'), '{ "name": "legacy" }\n');
	w.write(w.outPath('src/old/legacy.ts'), 'export const legacy = 1;\n');
	w.write(w.outPath('src/components/Card.tsx'), readFileSync(w.basePath('src/components/Card.tsx'), 'utf8'));
	w.write(w.outPath('README.md'), 'hand notes\n');
	w.write(w.outPath('.env'), 'VITE_STORE_NAME=Fixture Store\n');
	const dispositions = {
		'package.json': { class: 'superseded', reason: 'replaced' },
		'src/old/legacy.ts': { class: 'dropped', reason: 'removed upstream' },
		'README.md': { class: 'brand-l3', reason: 'kept' },
	};
	const legacyTreePaths = ['package.json', 'src/old/legacy.ts', 'src/components/Card.tsx'];
	const ctx = await plan({ ...w.opts(), mode: 'inventory' });
	const composed = new Map([...ctx.outputs].map(([k, v]) => [k, sha256(v.buf)]));
	ctx.base.cleanup();
	const inv = buildInventory({ outDir: w.out, composed, dispositions, tracked: new Set(legacyTreePaths), legacyTreePaths, legacyTag: 'tag-1', legacyCommit: 'c'.repeat(40) });
	const invFile = path.join(w.root, 'inv.json');
	writeFileSync(invFile, JSON.stringify(inv));
	const before = snapshot(w.out);
	await assert.rejects(apply({ ...w.opts(), adoptFile: invFile, fault: crash('adoption') }), /injected crash/);
	assert.equal(existsSync(w.outPath('src/old/legacy.ts')), false, 'retired before the crash');
	await recover({ layerDir: w.layer, outDir: w.out });
	assert.equal(readFileSync(w.outPath('src/old/legacy.ts'), 'utf8'), 'export const legacy = 1;\n');
	assert.equal(readFileSync(w.outPath('package.json'), 'utf8'), '{ "name": "legacy" }\n');
	assert.ok(equalSnapshots(before, snapshot(w.out)), 'including the absence of every composed addition and the adoption record');
	assert.equal(existsSync(path.join(w.repo, '.compose-history', 'compose-adoption.json')), false);
});

test('recover refuses a journal taken for another tree, and a copy that fails its hash', async (t) => {
	const w = await managedWorld(t);
	await assert.rejects(apply({ ...w.opts(), fault: crash('write') }), /injected crash/);
	await assert.rejects(recover({ layerDir: w.layer, outDir: path.join(w.repo, 'elsewhere') }), (e) => e.code === 'journal-root-mismatch');
	const dir = path.join(journalRootFor(w.repo), pendingJournals(w.repo)[0], 'prev');
	const first = readdirSync(dir)[0];
	writeFileSync(path.join(dir, first), 'corrupt');
	await assert.rejects(recover({ layerDir: w.layer, outDir: w.out }), (e) => e.code === 'bad-journal');
	assert.equal(pendingJournals(w.repo).length, 1, 'a failed recover keeps the journal');
});

test('journal refuses a non-regular path and a symlinked journal root', async (t) => {
	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	mkdirSync(w.out, { recursive: true });
	mkdirSync(w.outPath('adir'));
	assert.throws(() => beginJournal({ brandRepo: w.repo, roots: { out: w.out }, paths: [{ root: 'out', rel: 'adir' }] }), (e) => e.code === 'not-a-file');
	assert.deepEqual(pendingJournals(w.repo), []);
	assert.throws(() => beginJournal({ brandRepo: w.repo, roots: { out: w.out }, paths: [{ root: 'out', rel: '../x' }] }));
});

test('lock: a live holder makes a second operation exit 5; the lock dies with its holder; release removes the pid file', async (t) => {
	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	const release = await acquireLock(w.repo);
	assert.equal(existsSync(path.join(w.repo, LOCK_NAME)), true);
	await release();
	assert.equal(existsSync(path.join(w.repo, LOCK_NAME)), false);

	// a live process other than this one holds it
	const holder = await holdInChild(w.root, w.repo, t);
	await assert.rejects(acquireLock(w.repo), (e) => e.code === 'locked' && exitCodeFor(e) === 5);
	await assert.rejects(apply(w.opts()), (e) => e.code === 'locked');
	await assert.rejects(recover({ layerDir: w.layer, outDir: w.out }), (e) => e.code === 'locked');
	holder.kill('SIGKILL');
	await new Promise((r) => holder.on('exit', r));
	// killed holder: nothing to take over, no stale state to detect
	await (await acquireLock(w.repo))();
	// the pid file is diagnostic only: an unreadable one blocks nothing
	writeFileSync(path.join(w.repo, LOCK_NAME), 'not json');
	await (await acquireLock(w.repo))();
});

test('review 5: simultaneous acquisitions admit exactly one holder, including over a stale pid file', async (t) => {
	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	writeFileSync(path.join(w.repo, LOCK_NAME), JSON.stringify({ pid: 2 ** 22 + 4242 }));
	const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquireLock(w.repo)));
	assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
	for (const r of results.filter((x) => x.status === 'rejected')) assert.equal(r.reason.code, 'locked');
	await results.find((r) => r.status === 'fulfilled').value();
});

/** Takes the brand-repo lock in a child process and resolves once it holds it. */
async function holdInChild(root, repo, t) {
	const script = path.join(root, 'holder.mjs');
	writeFileSync(script, `import { acquireLock } from ${JSON.stringify(new URL('./lib/journal.mjs', import.meta.url).href)};\nawait acquireLock(${JSON.stringify(repo)});\nconsole.log('locked');\nsetInterval(() => {}, 1000);\n`);
	const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
	t.after(() => child.kill('SIGKILL'));
	await new Promise((resolve, reject) => {
		child.stdout.once('data', resolve);
		child.once('exit', () => reject(new Error('holder exited early')));
	});
	return child;
}

test('--allow-fault: COMPOSE_FAULT is inert without the flag, kills after the named step with it, and rejects unknown steps', () => {
	assert.equal(faultHook({ allow: false, env: { COMPOSE_FAULT: 'write' } }), undefined);
	assert.equal(faultHook({ allow: true, env: {} }), undefined);
	const killed = [];
	const hook = faultHook({ allow: true, env: { COMPOSE_FAULT: 'remove' }, kill: (s) => killed.push(s) });
	for (const s of FAULT_STEPS) hook(s);
	assert.deepEqual(killed, ['remove']);
	assert.throws(() => faultHook({ allow: true, env: { COMPOSE_FAULT: 'nope' } }), /COMPOSE_FAULT/);
});

test('--live: managed-file presence and the legacy test read the live tree, the stage stays the output', async (t) => {
	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	const stage = path.join(w.repo, 'store.next');
	// foreign live tree, empty stage: refuses, writes nothing
	w.write(w.outPath('package.json'), '{ "name": "legacy" }\n');
	w.write(w.outPath('.env'), 'VITE_STORE_NAME=Fixture Store\n');
	await assert.rejects(apply({ ...w.opts(), outDir: stage, liveDir: w.out }), (e) => e.code === 'validation' && e.details.some((d) => d.code === 'adoption-required') && exitCodeFor(e) === 6);
	assert.equal(existsSync(stage), false, 'nothing written');
	assert.equal(pendingJournals(w.repo).length, 0);
	// an adopted live tree: the stage composes without --adopt, and the stage's old files are removed by the live managed list
	rmSync(w.out, { recursive: true });
	w.write(w.outPath('.env'), 'VITE_STORE_NAME=Fixture Store\n');
	await apply(w.opts());
	const r = await apply({ ...w.opts(), outDir: stage, liveDir: w.out });
	assert.ok(r.changes.length > 0);
	assert.equal(existsSync(path.join(stage, '.compose-managed.json')), true);
	// live and stage must not overlap
	await assert.rejects(apply({ ...w.opts(), outDir: path.join(w.out, 'inner'), liveDir: w.out }), (e) => e.details?.some((d) => d.code === 'overlap') ?? false);
});

test('--inventory on an unadopted tree requires --legacy-tag and --dispositions', async (t) => {
	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	w.write(w.outPath('package.json'), '{ "name": "legacy" }\n');
	await assert.rejects(inventory(w.opts()), (e) => e.code === 'inventory-args' && exitCodeFor(e) === 2);
	await assert.rejects(inventory({ ...w.opts(), legacyTag: 't' }), (e) => e.code === 'inventory-args');
});

test('--check-build-env writes build-config.json (names, hashes, no values) and exits 7 on a stale env file', async (t) => {
	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	const brandFile = w.layerPath('brand.json');
	const b = readJ(brandFile);
	b.buildExports = { SOME_API_BASE: 'http://api.example.invalid' };
	writeFileSync(brandFile, JSON.stringify(b, null, 2));
	w.write(w.outPath('.env'), 'VITE_STORE_NAME=Fixture Store\n');
	await apply(w.opts());
	const cfg = await checkBuildEnv({ layerDir: w.layer, outDir: w.out, loadEnv: w.opts().loadEnv });
	const onDisk = readJ(w.outPath('build-config.json'));
	assert.deepEqual(onDisk, cfg);
	assert.ok(cfg.publicNames.includes('VITE_STORE_NAME'));
	assert.deepEqual(cfg.exportNames, ['SOME_API_BASE']);
	assert.match(cfg.buildConfigHash, /^[0-9a-f]{64}$/);
	assert.ok(!JSON.stringify(onDisk).includes('Fixture Store') && !JSON.stringify(onDisk).includes('api.example.invalid'), 'names and hashes only');
	assert.equal(cfg.effectiveConfigHash, readJ(w.outPath('compose-report.json')).hashes.publicConfig);
	// a later-loading env file changes what the build reads
	w.write(w.outPath('.env.production.local'), 'VITE_STORE_NAME=Other\n');
	await assert.rejects(checkBuildEnv({ layerDir: w.layer, outDir: w.out, loadEnv: w.opts().loadEnv }), (e) => e.code === 'build-config-mismatch' && exitCodeFor(e) === 7);
});

test('--mark-built records the build-config hash in the history entry', async (t) => {
	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	w.write(w.outPath('.env'), 'VITE_STORE_NAME=Fixture Store\n');
	await apply(w.opts());
	const cfg = await checkBuildEnv({ layerDir: w.layer, outDir: w.out, loadEnv: w.opts().loadEnv });
	const id = markBuilt({ layerDir: w.layer, outDir: w.out, now: new Date(), buildConfigHash: cfg.buildConfigHash });
	const meta = listEntries(w.layer).find((e) => e.id === id).meta;
	assert.equal(meta.status, 'built');
	assert.equal(meta.buildConfigHash, cfg.buildConfigHash);
});

test('exit codes: 5 journal or lock, 6 adoption or pin, 7 env or build-config, 2 usage, else 1', () => {
	const e = (code) => new ComposeError(code, 'x');
	const v = (...codes) => new ComposeError('validation', 'x', codes.map((c) => ({ code: c, message: 'm' })));
	assert.equal(exitCodeFor(e('journal-present')), 5);
	assert.equal(exitCodeFor(e('locked')), 5);
	assert.equal(exitCodeFor(v('adoption-required')), 6);
	assert.equal(exitCodeFor(e('bad-pin')), 6);
	assert.equal(exitCodeFor(v('inventory-stale')), 6);
	assert.equal(exitCodeFor(e('effective-config-mismatch')), 7);
	assert.equal(exitCodeFor(e('build-config-mismatch')), 7);
	assert.equal(exitCodeFor(e('bad-args')), 2);
	assert.equal(exitCodeFor(e('symlink')), 1);
	assert.equal(exitCodeFor(new Error('boom')), 1);
});

test('recoverJournals marks the history through the callback and ignores a missing entry', () => {
	// unit level: no journal, nothing called
	const called = [];
	assert.deepEqual(recoverJournals({ brandRepo: '/nonexistent-brand-repo', roots: {}, markAbandoned: (i) => called.push(i) }), []);
	assert.deepEqual(called, []);
});

// ------------------------------------------------------------------ review round 1

/** An rm that dies partway, like a SIGKILL during the deletion: it removes the journal's own file, then throws. */
const killedRm = (target) => (dir, opts) => {
	rmSync(path.join(dir, 'journal.json'), { force: true });
	const e = new Error('killed during cleanup');
	e.target = target;
	throw e;
};

test('review 4: a kill during the deletion of a finished journal leaves nothing that blocks, and the next apply proceeds', async (t) => {
	const w = await managedWorld(t);
	await assert.rejects(apply({ ...w.opts(), rm: killedRm('success') }), /killed during cleanup/);
	assert.deepEqual(pendingJournals(w.repo), [], 'a retired journal is not a journal');
	assert.doesNotThrow(() => assertNoJournal(w.repo));
	const leftovers = readdirSync(journalRootFor(w.repo));
	assert.equal(leftovers.length, 1);
	assert.match(leftovers[0], /\.done$/);
	// every mode runs again, and recover sweeps the leftover
	assert.deepEqual(await recover({ layerDir: w.layer, outDir: w.out }), []);
	assert.deepEqual(readdirSync(journalRootFor(w.repo)), []);
	const ok = await apply(w.opts());
	assert.ok(ok.history !== undefined || ok.historyId);
});

test('review 4: a kill during the deletion at the end of recover leaves a state the next recover and apply handle', async (t) => {
	const w = await managedWorld(t);
	const before = snapshot(w.out);
	await assert.rejects(apply({ ...w.opts(), fault: crash('write') }), /injected crash/);
	await assert.rejects(recover({ layerDir: w.layer, outDir: w.out, rm: killedRm('recover') }), /killed during cleanup/);
	assert.ok(equalSnapshots(before, snapshot(w.out)), 'the previous tree was already back');
	assert.deepEqual(pendingJournals(w.repo), [], 'the half-deleted journal no longer counts');
	assert.equal(listEntries(w.layer).at(-1).meta.status, 'abandoned');
	await assert.rejects(apply({ ...w.opts(), fault: crash('write') }), /injected crash/, 'apply is not blocked by the leftover');
	assert.equal((await recover({ layerDir: w.layer, outDir: w.out })).length, 1);
	assert.deepEqual(readdirSync(journalRootFor(w.repo)), []);
});

test('review 12: --check-build-env writes the export values once, beside the hash that covers exactly them', async (t) => {
	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	const brandFile = w.layerPath('brand.json');
	const b = readJ(brandFile);
	b.buildExports = { SOME_API_BASE: 'http://api.example.invalid', A_PATH: '/catalog' };
	writeFileSync(brandFile, JSON.stringify(b, null, 2));
	w.write(w.outPath('.env'), 'VITE_STORE_NAME=Fixture Store\n');
	await apply(w.opts());
	const cfg = await checkBuildEnv({ layerDir: w.layer, outDir: w.out, loadEnv: w.opts().loadEnv });
	const values = readJ(w.outPath('build-exports.json'));
	assert.deepEqual(values.exports, b.buildExports, 'the values the entry will apply');
	assert.equal(hashJson(Object.entries(values.exports).sort(([a], [c]) => (a < c ? -1 : 1))), cfg.exportsHash, 'the recorded hash is the hash of those same values');
	// an export that is not a string under a variable name is refused before anything is written
	b.buildExports = { 'BAD NAME': 'x' };
	writeFileSync(brandFile, JSON.stringify(b, null, 2));
	rmSync(w.outPath('build-exports.json'));
	await assert.rejects(checkBuildEnv({ layerDir: w.layer, outDir: w.out, loadEnv: w.opts().loadEnv }), (e) => e.code === 'build-exports-invalid');
	assert.equal(existsSync(w.outPath('build-exports.json')), false);
});

// ------------------------------------------------------------------ review round 3

test('review 3.5: compose and the deployment lock exclude each other, in both directions', async (t) => {
	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	const stateDir = path.join(w.repo, '.deploy-state');
	mkdirSync(stateDir, { recursive: true });
	// a deployment operation holds its lock: every compose mode that takes the brand lock is refused (exit 5)
	const deploy = await acquireOsLock(stateDir, 'lock');
	await assert.rejects(acquireLock(w.repo), (e) => e.code === 'locked' && exitCodeFor(e) === 5);
	await assert.rejects(apply(w.opts()), (e) => e.code === 'locked');
	await assert.rejects(recover({ layerDir: w.layer, outDir: w.out }), (e) => e.code === 'locked');
	assert.equal(existsSync(path.join(w.repo, LOCK_NAME)), false, 'the refused compose left no lock behind');
	await deploy();
	// a compose holds its own: a deployment operation cannot take the deployment lock meanwhile
	const compose = await acquireLock(w.repo);
	await assert.rejects(acquireOsLock(stateDir, 'lock'), (e) => e.name === 'LockHeldError');
	await compose();
	await (await acquireOsLock(stateDir, 'lock'))();
});

test('review 3.5: a compose started by the holder of the deployment lock runs inside it (verified descriptor), and an unrelated descriptor 3 does not count', async (t) => {
	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	const stateDir = path.join(w.repo, '.deploy-state');
	mkdirSync(stateDir, { recursive: true });
	const script = path.join(w.root, 'child.mjs');
	writeFileSync(script, `import { acquireLock } from ${JSON.stringify(new URL('./lib/journal.mjs', import.meta.url).href)};\ntry { await (await acquireLock(${JSON.stringify(w.repo)}))(); console.log('ok'); } catch (e) { console.log(e.code); }\n`);
	const run = (stdio) =>
		new Promise((resolve) => {
			const c = spawn(process.execPath, [script], { stdio });
			let out = '';
			c.stdout.on('data', (d) => (out += d));
			c.on('exit', () => resolve(out.trim()));
		});
	const deploy = await acquireOsLock(stateDir, 'lock');
	assert.equal(await run(['ignore', 'pipe', 'inherit']), 'locked', 'not delegated');
	assert.equal(await run(['ignore', 'pipe', 'inherit', deploy.fd]), 'ok', 'delegated by the verified lock descriptor');
	const { openSync } = await import('node:fs');
	assert.equal(await run(['ignore', 'pipe', 'inherit', openSync(path.join(w.root, 'plain'), 'w')]), 'locked', 'an unrelated descriptor is not the lock');
	await deploy();
});

test('review 3.5: a lock-wrapped async mode keeps the lock until its work has finished', async (t) => {
	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	let during = null;
	await withBrandLock(w.layer, async () => {
		await new Promise((r) => setTimeout(r, 20));
		during = await acquireLock(w.repo).then(() => 'free', (e) => e.code);
	});
	assert.equal(during, 'locked', 'a rival is refused while the async work is still running');
	await (await acquireLock(w.repo))();
});

test('review 3.6: a write killed between creating its temporary and renaming it leaves nothing behind after --recover; unrelated files stay', async (t) => {
	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	mkdirSync(w.out, { recursive: true });
	const history = path.join(w.repo, '.compose-history');
	mkdirSync(history, { recursive: true });
	writeFileSync(path.join(w.out, 'a.txt'), 'previous');
	// not recorded by the journal: must never be touched
	writeFileSync(path.join(w.out, 'unrelated.compose-tmp-1'), 'someone else');
	writeFileSync(path.join(w.out, 'other.txt'), 'other');
	const roots = { out: w.out, history };
	const code = await runChild('killed-write', { brandRepo: w.repo, roots, out: w.out });
	assert.equal(code, 'SIGKILL');
	const leftovers = () => (existsSync(path.join(w.out, 'b')) ? readdirSync(path.join(w.out, 'b')).filter((n) => n.includes('.compose-tmp-')) : []);
	assert.equal(leftovers().length, 1, 'the interrupted write left its temporary');
	assert.equal(pendingJournals(w.repo).length, 1);
	// a torn last line in the log and a recorded path outside the journal's roots change nothing
	const jdir = path.join(journalRootFor(w.repo), pendingJournals(w.repo)[0]);
	const outside = path.join(w.root, 'outside.compose-tmp-9');
	writeFileSync(outside, 'not ours');
	writeFileSync(path.join(jdir, 'temps.log'), `${readFileSync(path.join(jdir, 'temps.log'), 'utf8')}${JSON.stringify({ p: outside })}\n{"p":"${path.join(w.out, 'other.txt')}`);
	const done = await recover({ layerDir: w.layer, outDir: w.out });
	assert.equal(done.length, 1);
	assert.equal(done[0].temps, 1, 'exactly the interrupted temporary was removed (the completed write\'s temporary was already renamed away)');
	assert.equal(leftovers().length, 0, 'the interrupted temporary is gone');
	assert.equal(existsSync(path.join(w.out, 'b/new.txt')), false, 'the intended addition never appeared');
	assert.equal(existsSync(path.join(w.out, 'b')), false, 'the directory the interrupted composition created is gone too');
	assert.equal(readFileSync(path.join(w.out, 'a.txt'), 'utf8'), 'previous', 'the journaled file is back to its previous bytes');
	assert.equal(readFileSync(path.join(w.out, 'unrelated.compose-tmp-1'), 'utf8'), 'someone else', 'an unrecorded temp-named file is left alone');
	assert.equal(readFileSync(path.join(w.out, 'other.txt'), 'utf8'), 'other');
	assert.equal(readFileSync(outside, 'utf8'), 'not ours', 'a recorded path outside the roots is ignored');
	assert.deepEqual(pendingJournals(w.repo), []);
});

test('review 4.3: a recovery killed between creating a temporary and renaming it leaves nothing behind after the next recovery (restore write and abandonment write)', async (t) => {
	for (const killIn of ['restore', 'abandon']) {
		const w = makeWorld({ readOnlyBase: false });
		t.after(w.cleanup);
		mkdirSync(w.out, { recursive: true });
		const history = path.join(w.repo, '.compose-history');
		mkdirSync(path.join(history, 'h1'), { recursive: true });
		writeFileSync(path.join(w.out, 'a.txt'), 'previous');
		const roots = { out: w.out, history };
		await runChild('prepare', { brandRepo: w.repo, roots, out: w.out });
		assert.equal(pendingJournals(w.repo).length, 1);
		// recovery itself is killed inside a write: restoring a.txt, or marking the history entry abandoned
		const code = await runChild('killed-recovery', { brandRepo: w.repo, roots, history, killIn });
		assert.equal(code, 'SIGKILL', killIn);
		const temps = () => [...readdirSync(w.out), ...readdirSync(path.join(history, 'h1'))].filter((n) => n.includes('.compose-tmp-'));
		assert.equal(temps().length, 1, `${killIn}: the killed recovery left its temporary`);
		assert.equal(pendingJournals(w.repo).length, 1, `${killIn}: the journal is still there`);
		const again = await recover({ layerDir: w.layer, outDir: w.out });
		assert.equal(again.length, 1, killIn);
		assert.equal(again[0].temps, 1, `${killIn}: the recorded recovery temporary was removed`);
		assert.deepEqual(temps(), [], `${killIn}: no temporary survives`);
		assert.equal(readFileSync(path.join(w.out, 'a.txt'), 'utf8'), 'previous', killIn);
		assert.deepEqual(pendingJournals(w.repo), []);
	}
});

test('review 5.4: recovery removes the directories the interrupted composition created (the output root included), keeps one that holds anything else, and restores the mode of one it had to recreate', async (t) => {
	// a real apply into an output directory that does not exist yet, killed after its writes
	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	rmSync(w.out, { recursive: true, force: true });
	assert.equal(existsSync(w.out), false);
	await assert.rejects(apply({ ...w.opts(), fault: crash('write') }), /injected crash/);
	assert.equal(existsSync(w.out), true, 'the interrupted apply created the output directory');
	const doc = readJ(path.join(journalRootFor(w.repo), pendingJournals(w.repo)[0], 'journal.json'));
	assert.ok(doc.dirs.some((d) => d.root === 'out' && d.rel === '' && d.present === false), 'the journal recorded that the output root was absent');
	assert.ok(doc.dirs.some((d) => d.root === 'out' && d.rel === 'src' && d.present === false), 'and its created subdirectories');
	const done = await recover({ layerDir: w.layer, outDir: w.out });
	assert.equal(done.length, 1);
	assert.ok(done[0].dirs > 1, 'directories were removed');
	assert.equal(existsSync(w.out), false, 'the output directory is gone again: byte, directory and mode identical to before');
	assert.ok(equalSnapshots(new Map(), snapshot(w.out)));

	// a created directory that holds something the composition does not own stays (rmdir only removes empty directories)
	const x = makeWorld({ readOnlyBase: false });
	t.after(x.cleanup);
	mkdirSync(x.out, { recursive: true });
	const history = path.join(x.repo, '.compose-history');
	mkdirSync(history, { recursive: true });
	const roots = { out: x.out, history };
	beginJournal({ brandRepo: x.repo, roots, paths: [{ root: 'out', rel: 'p/q/new.txt' }] });
	const { safeWrite } = await import('./lib/util.mjs');
	safeWrite(x.out, 'p/q/new.txt', 'added');
	writeFileSync(path.join(x.out, 'p/q/stranger.txt'), 'not ours');
	const r1 = recoverJournals({ brandRepo: x.repo, roots });
	assert.equal(r1[0].dirs, 0, 'nothing removed: p/q still holds a file');
	assert.equal(readFileSync(path.join(x.out, 'p/q/stranger.txt'), 'utf8'), 'not ours');
	assert.equal(existsSync(path.join(x.out, 'p/q/new.txt')), false, 'the addition itself is removed');

	// a directory the apply emptied and pruned comes back with its recorded mode
	const y = makeWorld({ readOnlyBase: false });
	t.after(y.cleanup);
	mkdirSync(path.join(y.out, 'd'), { recursive: true });
	chmodSync(path.join(y.out, 'd'), 0o750);
	writeFileSync(path.join(y.out, 'd/f.txt'), 'previous');
	const yhist = path.join(y.repo, '.compose-history');
	mkdirSync(yhist, { recursive: true });
	const yroots = { out: y.out, history: yhist };
	const before = snapshot(y.out);
	beginJournal({ brandRepo: y.repo, roots: yroots, paths: [{ root: 'out', rel: 'd/f.txt' }] });
	const { safeRemoveFile, pruneEmptyDirs } = await import('./lib/util.mjs');
	safeRemoveFile(y.out, 'd/f.txt');
	assert.deepEqual(pruneEmptyDirs(y.out, 'd/f.txt'), ['d']);
	recoverJournals({ brandRepo: y.repo, roots: yroots });
	assert.equal(readFileSync(path.join(y.out, 'd/f.txt'), 'utf8'), 'previous');
	assert.equal(statSync(path.join(y.out, 'd')).mode & 0o777, 0o750, 'the recreated directory has its recorded mode');
	assert.ok(equalSnapshots(before, snapshot(y.out)), 'directories and modes are part of the comparison');
});

test('review 6.1: recovery killed after each of its own filesystem steps (every change and every directory fsync) recovers again to the exact previous state, whether the output root existed or not', async (t) => {
	const scenarios = [
		{ name: 'output root absent, crash before the first write', fresh: async () => { const w = makeWorld({ readOnlyBase: false }); t.after(w.cleanup); rmSync(w.out, { recursive: true, force: true }); return w; }, step: 'write' },
		{ name: 'output root absent, crash at the last step', fresh: async () => { const w = makeWorld({ readOnlyBase: false }); t.after(w.cleanup); rmSync(w.out, { recursive: true, force: true }); return w; }, step: 'adoption' },
		{ name: 'managed tree, crash after writes', fresh: () => managedWorld(t), step: 'write' },
		{ name: 'managed tree, crash after removals', fresh: () => managedWorld(t), step: 'remove' },
	];
	for (const sc of scenarios) {
		let killedAt = 0;
		for (let k = 1; ; k++) {
			const w = await sc.fresh();
			const before = snapshot(w.out);
			await assert.rejects(apply({ ...w.opts(), fault: crash(sc.step) }), /injected crash/, sc.name);
			let n = 0;
			let died = false;
			const tick = () => {
				if (++n === k) {
					died = true;
					throw new Error(`recovery killed at step ${k}`);
				}
			};
			fsyncHooks.onOp = tick;
			fsyncHooks.onDir = tick;
			try {
				// the recovery body without the kernel lock (a killed process frees its lock; an in-process throw would not)
				recoverJournals({ brandRepo: w.repo, roots: { out: w.out, history: historyDirFor(w.layer) }, markAbandoned: (id) => abandonEntry({ layerDir: w.layer, id }) });
			} catch (e) {
				if (!/recovery killed/.test(e.message)) throw e;
			} finally {
				fsyncHooks.onOp = null;
				fsyncHooks.onDir = null;
			}
			if (died) {
				await recover({ layerDir: w.layer, outDir: w.out });
			}
			assert.deepEqual(pendingJournals(w.repo), [], `${sc.name}: killed at step ${k}: no active journal after the second recovery`);
			assert.ok(equalSnapshots(before, snapshot(w.out)), `${sc.name}: killed at step ${k}: the output is exactly the previous state`);
			assert.deepEqual(await recover({ layerDir: w.layer, outDir: w.out }), [], `${sc.name}: a third recovery has nothing to do`);
			if (!died) {
				killedAt = k - 1;
				break;
			}
		}
		assert.ok(killedAt >= 3, `${sc.name}: recovery has several steps to kill (${killedAt})`);
	}
});

test('review 7.2: a torn temps.log tail is truncated before recovery appends, so a recovery killed inside its first temporary write still leaves a record the next recovery can act on', async (t) => {
	const w = makeWorld({ readOnlyBase: false });
	t.after(w.cleanup);
	mkdirSync(w.out, { recursive: true });
	const history = path.join(w.repo, '.compose-history');
	mkdirSync(history, { recursive: true });
	writeFileSync(path.join(w.out, 'a.txt'), 'previous');
	const roots = { out: w.out, history };
	// the apply: a journal, a write killed after its temporary exists
	assert.equal(await runChild('apply', { brandRepo: w.repo, roots, out: w.out }), 'SIGKILL');
	const jdir = path.join(journalRootFor(w.repo), pendingJournals(w.repo)[0]);
	const log = path.join(jdir, 'temps.log');
	// the kill also tore the next record in half
	writeFileSync(log, `${readFileSync(log, 'utf8')}{"p":"${path.join(w.out, 'a.txt')}.compose-tm`);
	// recovery #1 dies in its first temporary write (restoring a.txt)
	assert.equal(await runChild('recover-first', { brandRepo: w.repo, roots }), 'SIGKILL');
	const lines = readFileSync(log, 'utf8').split('\n');
	assert.equal(lines.at(-1), '', 'the log ends on a record boundary');
	for (const l of lines.filter(Boolean)) JSON.parse(l);
	assert.equal(lines.filter(Boolean).length, 2, 'the apply\'s record and the recovery\'s own, each a whole line');
	const temps = () => readdirSync(w.out).filter((n) => n.includes('.compose-tmp-'));
	assert.equal(temps().length, 1, 'the first recovery removed the apply\'s temporary and was itself killed holding its own');
	const done = await recover({ layerDir: w.layer, outDir: w.out });
	assert.equal(done[0].temps, 1, 'the recovery\'s own temporary was identified through the repaired log and removed');
	assert.deepEqual(temps(), []);
	assert.equal(readFileSync(path.join(w.out, 'a.txt'), 'utf8'), 'previous');
	assert.deepEqual(pendingJournals(w.repo), []);
});

test('review 7.3: the history id is journaled before any file of the entry exists; an interruption at every point of its creation recovers to the exact previous state, with no partial entry left and a completed one marked abandoned', async (t) => {
	let sawPartialRemoved = false;
	let sawIdBeforeFiles = false;
	const histories = (w) => readdirSync(historyDirFor(w.layer)).filter((n) => /^\d{8}T\d{6}Z-/.test(n));
	for (let k = 0; k < 40; k++) {
		const w = await managedWorld(t);
		const before = snapshot(w.out);
		const knownBefore = histories(w);
		const hist = historyDirFor(w.layer);
		let inHistory = 0;
		let steps = [];
		const { writeHooks } = await import('./lib/util.mjs');
		// k = 0 and 1: interrupted before the id is published and right after (no file yet); k >= 2: inside the creation of the k-2'th history file
		const fault = (step) => {
			steps.push(step);
			if (k === 0 && step === 'history-id') throw new Error('injected crash before the id is published');
			if (k === 1 && step === 'history-journaled') throw new Error('injected crash right after the id is published');
		};
		writeHooks.afterTemp = (tmp) => {
			if (!tmp.startsWith(`${hist}${path.sep}`)) return;
			if (++inHistory === k - 1) throw new Error(`injected crash inside history file ${inHistory}`);
		};
		let failed = true;
		try {
			await apply({ ...w.opts(), fault });
			failed = false;
		} catch (e) {
			assert.match(e.message, /injected crash/);
		} finally {
			writeHooks.afterTemp = null;
		}
		if (!failed) {
			assert.ok(k > 3, 'the loop covered several creation points');
			break;
		}
		const journal = readJ(path.join(journalRootFor(w.repo), pendingJournals(w.repo)[0], 'journal.json'));
		const created = histories(w).filter((n) => !knownBefore.includes(n));
		if (k === 0) assert.equal(journal.history, null, 'nothing was published, nothing exists');
		else {
			assert.match(journal.history, /^\d{8}T\d{6}Z-/, `k=${k}: the id is in the journal`);
			if (k === 1) assert.deepEqual(created, [], 'the id was journaled before its first file was created');
			if (k === 1) sawIdBeforeFiles = true;
		}
		if (k >= 2) assert.ok(created.includes(journal.history) || created.length === 0, `k=${k}: whatever exists is the journaled entry`);
		assert.ok(created.length <= 1);
		const done = await recover({ layerDir: w.layer, outDir: w.out });
		assert.equal(done.length, 1, `k=${k}`);
		assert.ok(equalSnapshots(before, snapshot(w.out)), `k=${k}: the output is the previous state`);
		assert.deepEqual(pendingJournals(w.repo), []);
		const left = histories(w).filter((n) => !knownBefore.includes(n));
		for (const n of left) {
			const meta = readJ(path.join(hist, n, 'meta.json'));
			assert.equal(meta.status, 'abandoned', `k=${k}: an entry that survives is a complete, abandoned one`);
		}
		if (k >= 2 && created.length && !left.length) sawPartialRemoved = true;
		for (const n of histories(w)) assert.ok(existsSync(path.join(hist, n, 'meta.json')), `k=${k}: no history entry without meta.json remains`);
		// the next apply works
		await apply(w.opts());
	}
	assert.ok(sawPartialRemoved && sawIdBeforeFiles, 'partial removal and the id-before-files order were both exercised');
	assert.equal(abandonEntry({ layerDir: (await managedWorld(t)).layer, id: '20990101T000000Z-aaaaaaaaaaaa' }), false, 'an id with no entry is ignored');
});
