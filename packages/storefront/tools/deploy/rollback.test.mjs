// node --test tools/deploy/rollback.test.mjs   (cwd: packages/storefront)
// Plan A §4.5 and §4.6a e: the three rollback procedures (findings C1, C4, C8, C9). Every command is a fake.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { activate, build, recover, resumeActivation, runCli as entryCli } from './entry.mjs';
import { DeployError, EXIT, InjectedCrash } from './lib.mjs';
import { pickComposedTarget, rollbackComposed, rollbackLegacy, rollbackPrevious, runCli } from './rollback.mjs';
import { CLIENT_NAME, DEV_LINK, HASHES, HISTORY_ID, equalSnapshots, makeWorld, sha, snapshot } from './fixtures/world.mjs';

async function exit(fn) {
	try {
		await fn();
		return 0;
	} catch (e) {
		if (e instanceof DeployError) return e.exit;
		throw e;
	}
}
const world = (t, o) => {
	const w = makeWorld(o);
	t.after(w.cleanup);
	return w;
};
const NP = { noRestart: true, smokePort: 4555 };
const entryOf = (tree) => readFileSync(path.join(tree, 'server/entry.express.js'), 'utf8');
const noRuntimeCalls = (w) => {
	assert.ok(!w.calls.some((c) => c.label === 'pm2' || c.label === 'fake-purge'), 'pm2 and the purge were never called');
	assert.ok(!w.started.some((s) => s.prod), 'the production restart was never called');
};

// ------------------------------------------------------------------ 1. previous

test('previous (non-production): restores the previous tree with no rebuild, passes --no-restart through, never reaches pm2 or the purge', async (t) => {
	const w = world(t);
	const ctx = w.ctx();
	await build(ctx, {});
	await activate(ctx, NP);
	const labels = w.labels().length;
	await rollbackPrevious(ctx, NP);
	assert.deepEqual(w.labels().slice(labels), []);
	assert.equal(entryOf(w.live), 'entry-v1');
	assert.equal(w.readState().state, 'restored-previous');
	assert.equal(w.started.length, 2);
	assert.ok(w.started.every((s) => s.env?.PORT === '4555'), 'its own process on the given port');
	noRuntimeCalls(w);
});

test('previous: the purge is a separate step after the smoke on production, and an injected purge failure on a copy is exit 9', async (t) => {
	const w = world(t, { production: true });
	const ctx = w.ctx();
	await build(ctx, {});
	await activate(ctx, {});
	await rollbackPrevious(ctx, {});
	assert.equal(entryOf(w.live), 'entry-v1');
	assert.equal(w.called('fake-purge'), true);
	assert.equal(w.smokesBeforePurge, 2);
	assert.equal(w.readState().state, 'purged');

	const x = world(t);
	const cx = x.ctx();
	await build(cx, {});
	await activate(cx, NP);
	assert.equal(await exit(() => rollbackPrevious(cx, { ...NP, fault: 'purge' })), EXIT.PURGE);
	assert.equal(x.readState().state, 'purge-failed');
	assert.equal(x.called('fake-purge'), false);
});

test('C1: every mode refuses a missing --no-restart/--smoke-port on a copy, and the flags on production, before any step', async (t) => {
	const w = world(t);
	const ctx = w.ctx();
	await build(ctx, {});
	await activate(ctx, NP);
	const before = snapshot(w.root);
	const calls = w.calls.length;
	for (const fn of [() => rollbackPrevious(ctx, {}), () => rollbackComposed(ctx, HISTORY_ID(1), {}), () => rollbackLegacy(ctx, 'tag-1', {}), () => rollbackPrevious(ctx, { noRestart: true })]) assert.equal(await exit(fn), EXIT.ROOT);
	assert.ok(equalSnapshots(before, snapshot(w.root)));
	assert.equal(w.calls.length, calls);
	noRuntimeCalls(w);
	const p = world(t, { production: true });
	for (const fn of [() => rollbackPrevious(p.ctx(), NP), () => rollbackComposed(p.ctx(), HISTORY_ID(1), { noRestart: true }), () => rollbackLegacy(p.ctx(), 'tag-1', { smokePort: 1 }), () => rollbackPrevious(p.ctx(), { fault: 'purge' })]) assert.equal(await exit(fn), EXIT.ROOT);
	assert.deepEqual(p.calls, []);
	assert.equal(p.started.length, 0);
	assert.equal(await exit(() => rollbackPrevious(w.ctx(), { ...NP, fault: 'nonsense' })), EXIT.USAGE);
});

// ------------------------------------------------------------------ 2. composed

const writeMeta = (w, n, over = {}) => w.write(path.join(w.root, '.compose-history', HISTORY_ID(n), 'meta.json'), JSON.stringify({ id: HISTORY_ID(n), status: 'built', hashes: { ...HASHES }, buildConfigHash: w.buildConfigHash, ...over }));

async function twoReleases(w, flags) {
	const ctx = w.ctx();
	await build(ctx, {});
	await activate(ctx, flags);
	writeMeta(w, 1);
	await build(ctx, {});
	await activate(ctx, flags);
	writeMeta(w, 2);
	return ctx;
}

test('composed: restore the inputs, rebuild into a stage, verify every recorded hash before activation, activate; default target is the newest earlier activation', async (t) => {
	const w = world(t);
	w.restoreNote = ` Run the build entry to compose these inputs with --pin ${'a'.repeat(40)} (the saved output was composed at another pin).`;
	const ctx = await twoReleases(w, NP);
	assert.equal(pickComposedTarget(w.readState()), HISTORY_ID(1));
	const labels = w.labels().length;
	await rollbackComposed(ctx, undefined, NP);
	const after = w.labels().slice(labels);
	assert.deepEqual(after, ['compose-restore', 'env', 'compose-apply', 'compose-check', 'install', 'build', 'compose-mark', 'retain-save', 'retain-restore']);
	const restore = w.calls.find((c) => c.label === 'compose-restore').argv;
	assert.deepEqual(restore.slice(-2), ['--restore-inputs', HISTORY_ID(1)]);
	assert.ok(w.calls.filter((c) => c.label === 'compose-apply').at(-1).argv.includes('a'.repeat(40)), 'the recorded pin override is used');
	assert.equal(w.readState().state, 'active');
	noRuntimeCalls(w);
});

test('C8: a rebuilt stage whose hashes differ from the history entry is exit 7 before activation, live untouched, stage kept', async (t) => {
	for (const mutate of [(w) => (w.reportHashes.lock = 'x'.repeat(64)), (w) => (w.reportHashes.publicConfig = 'y'.repeat(64)), (w) => (w.reportHashes.pin = 'z'.repeat(40)), (w) => (w.buildConfigHash = 'd'.repeat(64))]) {
		const w = world(t);
		const ctx = await twoReleases(w, NP);
		mutate(w);
		const before = snapshot(w.live);
		const started = w.started.length;
		const err = await rollbackComposed(ctx, HISTORY_ID(1), NP).catch((e) => e);
		assert.equal(err.exit, EXIT.ARTIFACT);
		assert.match(err.message, /differs from history entry/);
		assert.ok(equalSnapshots(before, snapshot(w.live)));
		assert.equal(w.started.length, started, 'nothing was started');
		assert.equal(w.readState().state, 'built');
		assert.equal(w.exists(w.next), true);
	}
	// a history entry without a recorded build-config hash cannot be verified
	const x = world(t);
	const cx = await twoReleases(x, NP);
	writeMeta(x, 1, { buildConfigHash: undefined });
	assert.equal(await exit(() => rollbackComposed(cx, HISTORY_ID(1), NP)), EXIT.ARTIFACT);
});

test('composed: unknown, unbuilt or malformed targets, a failing restore and no earlier activation', async (t) => {
	const w = world(t);
	const ctx = await twoReleases(w, NP);
	assert.equal(await exit(() => rollbackComposed(ctx, HISTORY_ID(9), NP)), EXIT.PRECOND, 'no such entry');
	writeMeta(w, 1, { status: 'abandoned' });
	assert.equal(await exit(() => rollbackComposed(ctx, HISTORY_ID(1), NP)), EXIT.PRECOND);
	assert.equal(await exit(() => rollbackComposed(ctx, '../../etc', NP)), EXIT.USAGE);
	writeMeta(w, 1);
	w.fail['compose-restore'] = 7;
	assert.equal(await exit(() => rollbackComposed(ctx, HISTORY_ID(1), NP)), EXIT.ARTIFACT);
	w.fail['compose-restore'] = 5;
	assert.equal(await exit(() => rollbackComposed(ctx, HISTORY_ID(1), NP)), EXIT.RECOVER);
	assert.equal(w.calls.filter((c) => c.label === 'install').length, 2, 'no rebuild was started by the failed restores');
	const solo = world(t);
	const cs = solo.ctx();
	await build(cs, {});
	await activate(cs, NP);
	assert.equal(await exit(() => rollbackComposed(cs, undefined, NP)), EXIT.PRECOND, 'only one activation: nothing earlier');
	assert.equal(pickComposedTarget(null), null);
});

test('composed on production: activate, then the purge as its own step after the smoke', async (t) => {
	const w = world(t, { production: true });
	const ctx = await twoReleases(w, {});
	await rollbackComposed(ctx, HISTORY_ID(1), {});
	assert.equal(w.called('fake-purge'), true);
	assert.equal(w.smokesBeforePurge, 3);
	assert.equal(w.readState().state, 'purged');
});

// ------------------------------------------------------------------ 3. legacy

function legacyWorld(t, o) {
	const w = world(t, o);
	const tag = 'tag-1';
	w.write(path.join(w.root, '.compose-history/compose-adoption.json'), JSON.stringify({ legacyCommit: w.tagCommit, legacyTag: tag }));
	const rec = path.join(w.root, '.deploy-backups/legacy-client', tag);
	const files = Object.fromEntries(Object.entries(w.legacyFiles).map(([k, v]) => [k, sha(v)]));
	w.write(path.join(rec, 'legacy-input.json'), JSON.stringify({ tag, commit: w.tagCommit, node: w.versions.node, pnpm: w.versions.pnpm, files }));
	const clientRel = 'sellright/packages/storefront-client/package.json';
	w.write(path.join(rec, clientRel), '{"name":"client"}');
	w.write(path.join(rec, 'closure.json'), JSON.stringify({ files: { [clientRel]: sha('{"name":"client"}') } }));
	return { w, rec, tag, clientRel };
}

test('C4: every validation failure exits before a stage, a journal or any state exists, and the live tree is untouched', async (t) => {
	const cases = {
		'tag resolves to another commit': [EXIT.PRECOND, ({ w }) => (w.tagCommit = 'f'.repeat(40))],
		'a manifest hash differs': [EXIT.ARTIFACT, ({ w }) => (w.legacyFiles['pnpm-lock.yaml'] = 'edited lock\n')],
		'a closure file differs': [EXIT.ARTIFACT, ({ rec, clientRel }) => writeFileSync(path.join(rec, clientRel), '{"name":"tampered"}')],
		'a closure file is missing': [EXIT.ARTIFACT, ({ rec, clientRel }) => rmSync(path.join(rec, clientRel))],
		'node differs': [EXIT.PRECOND, ({ w }) => (w.versions.node = 'v25.0.0')],
		'pnpm differs': [EXIT.PRECOND, ({ w }) => (w.versions.pnpm = '12.0.0')],
		'no adoption record': [EXIT.PRECOND, ({ w }) => rmSync(path.join(w.root, '.compose-history/compose-adoption.json'))],
		'no input record': [EXIT.PRECOND, ({ rec }) => rmSync(path.join(rec, 'legacy-input.json'))],
		'a compose journal exists': [EXIT.RECOVER, ({ w }) => mkdirSync(path.join(w.root, '.compose-journal/20261011T000000Z-1'), { recursive: true })],
	};
	for (const [name, [want, mutate]] of Object.entries(cases)) {
		const l = legacyWorld(t);
		mutate(l);
		const before = snapshot(l.w.live);
		assert.equal(await exit(() => rollbackLegacy(l.w.ctx(), l.tag, NP)), want, name);
		assert.equal(l.w.exists(l.w.next), false, `${name}: no stage`);
		assert.equal(l.w.exists(l.w.state), false, `${name}: no state file`);
		assert.equal(l.w.exists(l.w.ctx().paths.legacyJournal), false, `${name}: no journal`);
		assert.ok(equalSnapshots(before, snapshot(l.w.live)), `${name}: live untouched`);
		assert.equal(l.w.called('env') || l.w.called('install'), false, `${name}: nothing was built`);
	}
	const e = legacyWorld(t);
	assert.equal(await exit(() => rollbackLegacy(e.w.ctx({ externals: [path.join(e.w.base, 'missing-heap-script.mjs')] }), e.tag, NP)), EXIT.PRECOND, 'a required external is missing');
	assert.equal(e.w.exists(e.w.next), false);
	assert.equal(await exit(() => rollbackLegacy(e.w.ctx(), undefined, NP)), EXIT.USAGE);
	// an interrupted activation also stops it (state activating): exit 5
	const a = legacyWorld(t);
	mkdirSync(path.join(a.w.root, '.deploy-state'), { recursive: true });
	writeFileSync(a.w.state, JSON.stringify({ version: 1, state: 'activating', stageId: 's', source: 'x', swap: [], activations: [] }));
	assert.equal(await exit(() => rollbackLegacy(a.w.ctx(), a.tag, NP)), EXIT.RECOVER);
});

test('C9: legacy rollback builds the tag in a stage from the captured closure, never composes, never deletes from the live tree, then activates', async (t) => {
	const { w, tag, rec } = legacyWorld(t);
	const ctx = w.ctx();
	const prevLive = snapshot(w.live);
	await rollbackLegacy(ctx, tag, NP);
	const labels = w.labels();
	assert.ok(!labels.some((l) => l.startsWith('compose')), 'compose is never invoked');
	assert.ok(!labels.includes('build'), 'the guarded composed build script is not used');
	assert.deepEqual(labels.filter((l) => ['git:archive', 'tar', 'env', 'install', 'legacy-build', 'retain-save', 'retain-restore'].includes(l)), ['git:archive', 'tar', 'git:archive', 'tar', 'env', 'install', 'legacy-build', 'retain-save']);
	const legacyBuild = w.calls.find((c) => c.label === 'legacy-build');
	assert.deepEqual(legacyBuild.argv, ['bash', path.join(w.next, 'scripts/build-production.sh'), '--no-restart']);
	assert.equal(legacyBuild.cwd, w.next);
	// the legacy tree (its own package.json) is live; the previous live tree is kept as prev, whole
	assert.equal(JSON.parse(readFileSync(path.join(w.live, 'package.json'), 'utf8')).name, 'legacy');
	assert.ok(equalSnapshots(prevLive, snapshot(w.prev)), 'nothing was deleted from the old live tree');
	// the dependency link resolves inside the captured closure, not a dev tree
	const link = path.join(w.live, 'node_modules/@sellright/storefront-client');
	assert.equal(lstatSync(link).isSymbolicLink(), true);
	assert.ok(realpathSync(link).startsWith(realpathSync(rec) + path.sep));
	const s = w.readState();
	assert.equal(s.state, 'active');
	assert.equal(s.source, `legacy:${tag}`);
	assert.equal(w.exists(path.join(w.live, '.compose-managed.json')), false);
	noRuntimeCalls(w);
	// the plain build now stops at the adoption guard (exit 6) until re-adoption
	assert.equal(await exit(() => build(ctx, {})), EXIT.PRECOND);
	const journal = JSON.parse(readFileSync(ctx.paths.legacyJournal, 'utf8'));
	assert.deepEqual(journal.completed, ['stage', 'env', 'link', 'install', 'build', 'artifacts']);
});

test('C9: a closure whose client resolves outside the closure is exit 7 at validation, live untouched, and the build never runs', async (t) => {
	const { w, tag, rec } = legacyWorld(t);
	// the "captured" client is really a link to a dev tree: its files hash correctly, but it lies outside the closure
	const dev = path.join(w.base, 'dev-tree');
	mkdirSync(dev);
	writeFileSync(path.join(dev, 'package.json'), '{"name":"client"}');
	rmSync(path.join(rec, 'sellright'), { recursive: true });
	mkdirSync(path.join(rec, 'sellright/packages'), { recursive: true });
	symlinkSync(dev, path.join(rec, 'sellright/packages/storefront-client'));
	const before = snapshot(w.live);
	// refused by the closure validation, before any stage or state exists (each component is lstat-ed; the client directory is a link out)
	assert.equal(await exit(() => rollbackLegacy(w.ctx(), tag, NP)), EXIT.ARTIFACT);
	assert.equal(existsSync(path.join(w.root, '.deploy-state/storefront.json')), false);
	assert.ok(equalSnapshots(before, snapshot(w.live)));
	assert.equal(w.called('legacy-build'), false, 'the build never ran against a dev tree');
});

test('C4: an interrupted legacy build resumes: completed steps are rechecked and skipped, the stage is not re-extracted', async (t) => {
	const { w, tag } = legacyWorld(t);
	w.crash.install = true;
	await assert.rejects(rollbackLegacy(w.ctx(), tag, NP), InjectedCrash);
	assert.equal(w.readState().state, 'building');
	assert.deepEqual(JSON.parse(readFileSync(w.ctx().paths.legacyJournal, 'utf8')).completed, ['stage', 'env', 'link']);
	w.crash = {};
	assert.equal(await exit(() => build(w.ctx(), {})), EXIT.RECOVER, 'other commands still refuse');
	await rollbackLegacy(w.ctx(), tag, NP);
	assert.equal(w.calls.filter((c) => c.label === 'env').length, 1, 'the env step was not repeated');
	assert.equal(w.calls.filter((c) => c.label === 'tar' && c.argv.includes('--strip-components=1')).length, 1, 'the stage was extracted once');
	assert.equal(w.calls.filter((c) => c.label === 'install').length, 2, 'the interrupted step ran again');
	assert.equal(w.readState().state, 'active');
	noRuntimeCalls(w);
});

test('C4: a completed legacy build is not rebuilt after an interrupted activation is recovered', async (t) => {
	const { w, tag } = legacyWorld(t);
	await assert.rejects(rollbackLegacy(w.ctx(), tag, { ...NP, fault: 'swap-mid' }), InjectedCrash);
	assert.equal(w.readState().state, 'activating');
	assert.equal(await exit(() => rollbackLegacy(w.ctx(), tag, NP)), EXIT.RECOVER);
	await recover(w.ctx());
	assert.equal(w.readState().state, 'built');
	await rollbackLegacy(w.ctx(), tag, NP);
	assert.equal(w.calls.filter((c) => c.label === 'legacy-build').length, 1);
	assert.equal(w.readState().state, 'active');
	assert.equal(w.readState().source, `legacy:${tag}`);
});

test('legacy on production: activate then purge after the smoke', async (t) => {
	const { w, tag } = legacyWorld(t, { production: true });
	await rollbackLegacy(w.ctx(), tag, {});
	assert.equal(w.called('fake-purge'), true);
	assert.equal(w.smokesBeforePurge, 1);
	assert.equal(w.readState().state, 'purged');
	assert.ok(w.started.some((s) => s.prod));
});

test('a failing legacy build step marks build-failed and leaves the live tree alone', async (t) => {
	const { w, tag } = legacyWorld(t);
	w.fail['legacy-build'] = 2;
	const before = snapshot(w.live);
	assert.equal(await exit(() => rollbackLegacy(w.ctx(), tag, NP)), EXIT.FAIL);
	assert.equal(w.readState().state, 'build-failed');
	assert.ok(equalSnapshots(before, snapshot(w.live)));
	assert.equal(existsSync(w.next), true);
});

// ------------------------------------------------------------------ CLI

test('CLI: usage and exit codes', async (t) => {
	const w = world(t);
	const out = { log: () => {}, error: () => {} };
	const cfg = w.config();
	assert.equal(await runCli([], { deps: w.deps, out }), EXIT.USAGE);
	assert.equal(await runCli(['--config', cfg, 'sideways'], { deps: w.deps, out }), EXIT.USAGE);
	assert.equal(await runCli(['--config', cfg, 'previous'], { deps: w.deps, out }), EXIT.ROOT);
	assert.equal(await runCli(['--config', cfg, 'previous', '--no-restart', '--smoke-port', 'x'], { deps: w.deps, out }), EXIT.USAGE);
	assert.equal(await runCli(['--config', cfg, 'previous', '--no-restart', '--smoke-port', '4555'], { deps: w.deps, out }), EXIT.PRECOND, 'no state yet');
	assert.equal(await entryCli(['--config', cfg, 'build'], { deps: w.deps, out }), 0);
	assert.equal(await entryCli(['--config', cfg, 'activate', '--no-restart', '--smoke-port', '4555'], { deps: w.deps, out }), 0);
	assert.equal(await runCli(['--config', cfg, 'previous', '--no-restart', '--smoke-port', '4555'], { deps: w.deps, out }), 0);
	assert.equal(entryOf(w.live), 'entry-v1');
	assert.equal(await runCli(['--config', cfg, 'legacy', '--no-restart', '--smoke-port', '4555'], { deps: w.deps, out }), EXIT.USAGE, 'legacy needs --legacy-tag');
});

// ------------------------------------------------------------------ review round 1

test('review 6: composed rollback keeps one lock from restore to purge; a rival is refused between build, verification and activation', async (t) => {
	const w = world(t);
	const ctx = await twoReleases(w, NP);
	const rival = w.ctx();
	const seen = {};
	let stage;
	w.onCheckpoint = async (name) => {
		stage ??= w.readState().stageId;
		seen[name] = await exit(() => build(rival, {}));
		assert.equal(w.readState().stageId, stage, 'the verified stage was not replaced');
		assert.equal(w.readState().state, 'built');
	};
	await rollbackComposed(ctx, HISTORY_ID(1), NP);
	assert.deepEqual(seen, { 'composed:after-build': EXIT.RECOVER, 'composed:after-verify': EXIT.RECOVER });
	assert.equal(w.readState().state, 'active');
	assert.equal(w.readState().stageId, stage, 'what was verified is what was activated');
});

test('review 6: legacy rollback keeps one lock from validation to purge', async (t) => {
	const { w, tag } = legacyWorld(t);
	const rival = w.ctx();
	const seen = {};
	w.onCheckpoint = async (name) => {
		seen[name] = await exit(() => build(rival, {}));
	};
	await rollbackLegacy(w.ctx(), tag, NP);
	assert.deepEqual(seen, { 'legacy:after-build': EXIT.RECOVER });
	assert.equal(w.readState().state, 'active');
});

test('review 9: the installation resolves the client link inside the captured closure, with the development tree unavailable', async (t) => {
	const { w, tag, rec } = legacyWorld(t);
	const devTarget = path.resolve(w.root, 'store.next', DEV_LINK.slice(5));
	assert.equal(existsSync(devTarget), false, 'the development tree does not exist in this world');
	await rollbackLegacy(w.ctx(), tag, NP);
	assert.equal(w.installedLinks.length, 1);
	assert.ok(w.installedLinks[0].target.startsWith(`${rec}${path.sep}`), 'pnpm resolved the link into the closure');
	assert.notEqual(w.installedLinks[0].target, devTarget);
	// the manifest and the lockfile that records it point at the closure, not at the archived development link
	const pkg = JSON.parse(readFileSync(path.join(w.live, 'package.json'), 'utf8'));
	assert.ok(pkg.dependencies[CLIENT_NAME].startsWith('link:'));
	assert.notEqual(pkg.dependencies[CLIENT_NAME], DEV_LINK);
	assert.ok(!readFileSync(path.join(w.live, 'pnpm-lock.yaml'), 'utf8').includes(DEV_LINK));
	assert.ok(readFileSync(path.join(w.live, 'pnpm-lock.yaml'), 'utf8').includes(pkg.dependencies[CLIENT_NAME]));
});

test('review 9: a legacy manifest without the client link, or a lockfile that does not record it, is exit 7 before the install', async (t) => {
	for (const mutate of [
		(l) => {
			l.w.legacyFiles['package.json'] = '{"name":"legacy"}\n';
		},
		(l) => {
			l.w.legacyFiles['pnpm-lock.yaml'] = 'importers: {}\n';
		},
	]) {
		const l = legacyWorld(t);
		mutate(l);
		const files = Object.fromEntries(Object.entries(l.w.legacyFiles).map(([k, v]) => [k, sha(v)]));
		writeFileSync(path.join(l.rec, 'legacy-input.json'), JSON.stringify({ tag: l.tag, commit: l.w.tagCommit, node: l.w.versions.node, pnpm: l.w.versions.pnpm, files }));
		const before = snapshot(l.w.live);
		assert.equal(await exit(() => rollbackLegacy(l.w.ctx(), l.tag, NP)), EXIT.ARTIFACT);
		assert.equal(l.w.called('install'), false);
		assert.equal(l.w.readState().state, 'build-failed');
		assert.ok(equalSnapshots(before, snapshot(l.w.live)));
	}
});

test('review 10: a legacy build captures the live retention marker first; activation restores exactly that, including its absence', async (t) => {
	const marker = (w) => path.join(w.root, '.deploy-backups/store-assets-active.json');
	const { w, tag } = legacyWorld(t);
	const original = readFileSync(marker(w), 'utf8');
	let atSave;
	w.onCall = { 'retain-save': () => (atSave = readFileSync(marker(w), 'utf8')) };
	await rollbackLegacy(w.ctx(), tag, NP);
	assert.equal(atSave, original, 'retain save saw the marker of the currently live release, not the legacy script\'s');
	assert.equal(readFileSync(marker(w), 'utf8'), original);
	// the marker did not exist before: it does not exist after the swap either
	const x = legacyWorld(t);
	rmSync(marker(x.w));
	let present;
	x.w.onCall = { 'retain-save': () => (present = existsSync(marker(x.w))) };
	await rollbackLegacy(x.w.ctx(), x.tag, NP);
	assert.equal(present, false);
	assert.equal(existsSync(marker(x.w)), false);
});

test('review 11: a completed legacy swap that was recovered is resumed (restart, smoke), never rebuilt or swapped again', async (t) => {
	const { w, tag } = legacyWorld(t);
	w.crashOnStart = true;
	await assert.rejects(rollbackLegacy(w.ctx(), tag, NP), InjectedCrash);
	assert.equal(w.readState().state, 'activating');
	assert.equal((await recover(w.ctx())).action, 'swap-completed');
	assert.equal(w.readState().state, 'activate-failed');
	assert.equal(readFileSync(path.join(w.live, 'package.json'), 'utf8').includes('legacy'), true, 'the legacy tree is live');
	const original = snapshot(w.prev);
	w.crashOnStart = false;
	await rollbackLegacy(w.ctx(), tag, NP);
	assert.equal(w.calls.filter((c) => c.label === 'legacy-build').length, 1, 'built once');
	assert.equal(w.calls.filter((c) => c.label === 'tar' && c.argv.includes('--strip-components=1')).length, 1, 'extracted once');
	assert.ok(equalSnapshots(original, snapshot(w.prev)), 'the original fallback is still the retained previous tree');
	assert.equal(entryOf(w.prev), 'entry-v1');
	assert.equal(w.exists(w.removed ?? path.join(w.root, 'store.removed')), false);
	const s = w.readState();
	assert.equal(s.state, 'active');
	assert.equal(s.source, `legacy:${tag}`);
	assert.equal(s.activations.length, 1);
	assert.equal(w.smokeCalls.length, 1, 'the smoke ran once, after the resumed start');
	noRuntimeCalls(w);
});


// ------------------------------------------------------------------ review round 2

const markerOf = (w) => path.join(w.root, '.deploy-backups/store-assets-active.json');

test('review 2.3: a previous-restore whose renames finished before the process died is finished by `rollback previous` and by `resume`, without another swap', async (t) => {
	for (const via of ['rollback', 'entry-resume']) {
		const w = world(t);
		const ctx = w.ctx();
		await build(ctx, {});
		await activate(ctx, NP);
		w.crashOnStart = true;
		await assert.rejects(rollbackPrevious(ctx, NP), InjectedCrash);
		assert.equal(w.readState().state, 'activating');
		assert.equal((await recover(w.ctx())).action, 'swap-completed');
		const s = w.readState();
		assert.equal(s.state, 'activate-failed');
		assert.equal(s.prev, null, 'the restore consumed prev: this is the state that used to be unrecoverable');
		assert.equal(entryOf(w.live), 'entry-v1');
		const failedTree = snapshot(w.failedTree);
		w.crashOnStart = false;
		if (via === 'rollback') await rollbackPrevious(w.ctx(), NP);
		else assert.equal(await entryCli(['--config', w.config(), 'resume', '--no-restart', '--smoke-port', '4555'], { deps: w.deps, out: { log() {}, error() {} } }), 0);
		const done = w.readState();
		assert.equal(done.state, 'restored-previous', via);
		assert.equal(entryOf(w.live), 'entry-v1');
		assert.ok(equalSnapshots(failedTree, snapshot(w.failedTree)), 'no second swap touched the failed tree');
		assert.equal(w.exists(w.prev), false);
		assert.equal(done.activations.at(-1).kind, 'restore');
		assert.equal(w.smokeCalls.length, 2, 'one smoke for the first activation, one for the resumed restore');
		noRuntimeCalls(w);
	}
});

test('review 2.6: every failed state is retried without a second swap: legacy after a failed restart and after a failed smoke, composed likewise, previous-restore after its smoke', async (t) => {
	// legacy: the swap completed, then the restart or the smoke failed
	for (const [name, arm, disarm, want] of [
		['restart', (w) => ({ ...NP, fault: 'restart' }), () => {}, EXIT.FAIL],
		['smoke', (w) => ((w.smokeOk = false), NP), (w) => (w.smokeOk = true), EXIT.SMOKE],
	]) {
		const { w, tag } = legacyWorld(t);
		assert.equal(await exit(() => rollbackLegacy(w.ctx(), tag, arm(w))), want, name);
		const failed = w.readState();
		assert.ok(['activate-failed', 'smoke-failed'].includes(failed.state), name);
		const fallback = snapshot(w.prev);
		assert.equal(entryOf(w.prev), 'entry-v1');
		disarm(w);
		await rollbackLegacy(w.ctx(), tag, NP);
		assert.equal(w.calls.filter((c) => c.label === 'legacy-build').length, 1, `${name}: built once`);
		assert.ok(equalSnapshots(fallback, snapshot(w.prev)), `${name}: the original composed tree is still the fallback`);
		assert.equal(w.readState().state, 'active', name);
		assert.equal(w.readState().activations.length, 1, name);
	}
	// composed: the rebuilt stage is live, its smoke failed; a rerun resumes it
	for (const [name, arm, disarm] of [
		['restart', () => ({ ...NP, fault: 'restart' }), () => {}],
		['smoke', (w) => ((w.smokeOk = false), NP), (w) => (w.smokeOk = true)],
	]) {
		const w = world(t);
		const ctx = await twoReleases(w, NP);
		assert.ok(await exit(() => rollbackComposed(ctx, undefined, arm(w))) !== 0, name);
		const fallback = snapshot(w.prev);
		const applies = w.calls.filter((c) => c.label === 'compose-apply').length;
		disarm(w);
		await rollbackComposed(ctx, undefined, NP);
		assert.equal(w.calls.filter((c) => c.label === 'compose-apply').length, applies, `${name}: not rebuilt`);
		assert.ok(equalSnapshots(fallback, snapshot(w.prev)), `${name}: the fallback was not replaced`);
		assert.equal(w.readState().state, 'active', name);
	}
	// a previous-restore whose smoke failed is retried by resuming (prev is gone), then the live tree is the restored one
	const w = world(t);
	const ctx = w.ctx();
	await build(ctx, {});
	await activate(ctx, NP);
	w.smokeOk = false;
	assert.equal(await exit(() => rollbackPrevious(ctx, NP)), EXIT.SMOKE);
	assert.equal(w.readState().state, 'smoke-failed');
	w.smokeOk = true;
	await rollbackPrevious(ctx, NP);
	assert.equal(w.readState().state, 'restored-previous');
	assert.equal(entryOf(w.live), 'entry-v1');
	// a deploy-style build + activate while the live tree never confirmed its smoke would delete the last verified release: refused
	const x = world(t);
	const cx = x.ctx();
	await build(cx, {});
	x.smokeOk = false;
	assert.equal(await exit(() => activate(cx, NP)), EXIT.SMOKE);
	x.smokeOk = true;
	const verified = snapshot(x.prev);
	// (review 3.4) the build itself is refused while the swap is unconfirmed: it would drop the record `resume` works from
	assert.equal(await exit(() => build(cx, {})), EXIT.PRECOND);
	assert.equal(x.readState().state, 'smoke-failed');
	assert.ok(x.readState().inflight, 'the operation in flight is still recorded');
	const before = snapshot(x.live);
	assert.equal(await exit(() => activate(cx, NP)), EXIT.PRECOND);
	assert.ok(equalSnapshots(verified, snapshot(x.prev)), 'the verified release is still prev');
	assert.ok(equalSnapshots(before, snapshot(x.live)));
	await rollbackPrevious(cx, NP);
	await build(cx, {});
	await activate(cx, NP);
	assert.equal(x.readState().state, 'active');
});

test('review 2.4: a legacy build that changed the retention marker and was killed does not turn its change into the live marker on the retry', async (t) => {
	const { w, tag } = legacyWorld(t);
	const original = readFileSync(markerOf(w), 'utf8');
	w.crashAfter['legacy-build'] = true;
	await assert.rejects(rollbackLegacy(w.ctx(), tag, NP), InjectedCrash);
	assert.notEqual(readFileSync(markerOf(w), 'utf8'), original, 'the killed build had rewritten the shared marker');
	await recover(w.ctx());
	assert.equal(readFileSync(markerOf(w), 'utf8'), original, 'an abandoned build gives the live marker back');
	// something else leaves the marker changed before the retry; the snapshot of the live release is what counts
	w.crashAfter = {};
	w.write(markerOf(w), '{"active":["leftover"]}\n');
	await rollbackLegacy(w.ctx(), tag, NP);
	assert.deepEqual(w.retainSaw, [original], 'retain save saw the marker of the release that was live, not the legacy stage\'s');
});

test('review 2.8: the client-link rewrite resumes after a kill between the lockfile and the manifest write', async (t) => {
	const { w, tag, rec } = legacyWorld(t);
	w.deps.afterLinkLock = () => {
		throw new InjectedCrash('between-link-writes');
	};
	await assert.rejects(rollbackLegacy(w.ctx(), tag, NP), InjectedCrash);
	delete w.deps.afterLinkLock;
	// the two files disagree on disk: lockfile rewritten, manifest still at the archived development link
	const pkg = JSON.parse(readFileSync(path.join(w.next, 'package.json'), 'utf8'));
	assert.equal(pkg.dependencies[CLIENT_NAME], DEV_LINK);
	assert.ok(!readFileSync(path.join(w.next, 'pnpm-lock.yaml'), 'utf8').includes(DEV_LINK));
	assert.equal(w.called('install'), false);
	// resumed in place from the journal (a recover would mark the stage build-failed and the retry would re-extract it, hiding the defect)
	assert.equal(w.readState().state, 'building');
	await rollbackLegacy(w.ctx(), tag, NP);
	assert.equal(w.calls.filter((c) => c.label === 'tar' && c.argv.includes('--strip-components=1')).length, 1, 'the stage was not re-extracted');
	assert.equal(w.readState().state, 'active');
	assert.ok(w.installedLinks[0].target.startsWith(`${rec}${path.sep}`));
	const live = JSON.parse(readFileSync(path.join(w.live, 'package.json'), 'utf8'));
	assert.ok(readFileSync(path.join(w.live, 'pnpm-lock.yaml'), 'utf8').includes(live.dependencies[CLIENT_NAME]));
});
