// node --test tools/deploy/review7.test.mjs   (cwd: packages/storefront)
// Review round 7: a rollback records its target and direction durably before it acts, and every retry after a post-swap
// failure (restart, smoke, purge, a kill before or after the purge) resumes that recorded operation: no new target is
// selected, nothing is rebuilt, nothing is swapped a second time. Also: a torn deploy-log tail is repaired before an append.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { activate, build, recover } from './entry.mjs';
import { DeployError, EXIT, InjectedCrash, logStep, underLock } from './lib.mjs';
import { rollbackComposed, rollbackLegacy, rollbackPrevious } from './rollback.mjs';
import { HASHES, HISTORY_ID, equalSnapshots, makeWorld, snapshot } from './fixtures/world.mjs';

const NP = { noRestart: true, smokePort: 4555 };
const world = (t, o) => {
	const w = makeWorld(o);
	t.after(w.cleanup);
	return w;
};
async function outcome(fn) {
	try {
		await fn();
		return 'ok';
	} catch (e) {
		if (e instanceof InjectedCrash) return 'killed';
		if (e instanceof DeployError) return e.exit;
		throw e;
	}
}
const writeMeta = (w, n) => w.write(path.join(w.root, '.compose-history', HISTORY_ID(n), 'meta.json'), JSON.stringify({ id: HISTORY_ID(n), status: 'built', hashes: { ...HASHES }, buildConfigHash: w.buildConfigHash }));
const opFile = (w) => path.join(w.root, '.deploy-state', 'rollback-op.json');
const readOp = (w) => JSON.parse(readFileSync(opFile(w), 'utf8'));
const count = (w, label) => w.calls.filter((c) => c.label === label).length;

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

/** Every post-swap failure, on a copy and on production: how to arm it, how to disarm it, the exit/kill it ends in, the state it leaves. */
const ARMS = [
	{ name: 'restart', where: 'both', arm: (w, prod) => (prod ? (w.restartOk = false) : null), flags: (prod) => (prod ? {} : { ...NP, fault: 'restart' }), disarm: (w) => (w.restartOk = true), end: { np: 'active', prod: 'purged' } },
	{ name: 'smoke', where: 'both', arm: (w) => (w.smokeOk = false), flags: (prod) => (prod ? {} : NP), disarm: (w) => (w.smokeOk = true), end: { np: 'active', prod: 'purged' } },
	{ name: 'purge failed', where: 'both', arm: (w, prod) => (prod ? (w.fail['fake-purge'] = 1) : null), flags: (prod) => (prod ? {} : { ...NP, fault: 'purge' }), disarm: (w) => delete w.fail['fake-purge'], end: { np: 'purge-failed', prod: 'purged' } },
	{ name: 'killed before the purge call', where: 'prod', arm: (w) => (w.crash['fake-purge'] = true), flags: () => ({}), disarm: (w) => delete w.crash['fake-purge'], end: { prod: 'purged' } },
	{ name: 'killed after the purge call', where: 'prod', arm: (w) => (w.crashAfter['fake-purge'] = true), flags: () => ({}), disarm: (w) => delete w.crashAfter['fake-purge'], end: { prod: 'purged' } },
];
const worldsFor = (a) => (a.where === 'both' ? [false, true] : [true]);

test('review 7.1: a composed rollback records its target and direction before it restores anything; every failure state, retried by default and by explicit target, resumes that operation (no new target, no rebuild, no second swap)', async (t) => {
	for (const a of ARMS) {
		for (const prod of worldsFor(a)) {
			for (const retry of ['default', 'explicit']) {
				const tag = `${a.name} / ${prod ? 'production' : 'copy'} / ${retry}`;
				const w = world(t, { production: prod });
				const ctx = await twoReleases(w, prod ? {} : NP);
				a.arm(w, prod);
				const first = await outcome(() => rollbackComposed(ctx, HISTORY_ID(1), a.flags(prod)));
				assert.notEqual(first, 'ok', `${tag}: the first attempt failed`);
				const op = readOp(w);
				assert.deepEqual([op.kind, op.direction, op.target], ['composed', 'to-history', HISTORY_ID(1)], `${tag}: recorded`);
				const st = w.readState();
				assert.equal(op.stageId, st.live.stageId, `${tag}: the record names the stage that is live`);
				// what would a fresh default selection pick now? Not the recorded target (it is the one that would reverse the rollback)
				if (a.name.startsWith('purge') || a.name.includes('purge call')) assert.notEqual(st.activations.filter((x) => x.kind === 'activate').at(-2)?.historyId, HISTORY_ID(1), `${tag}: the scenario is one where a new selection differs`);
				const fallback = snapshot(w.prev);
				const built = { restore: count(w, 'compose-restore'), apply: count(w, 'compose-apply'), install: count(w, 'install'), build: count(w, 'build') };
				const prevId = st.prev?.stageId;
				const live = st.live.stageId;
				a.disarm(w);
				await rollbackComposed(ctx, retry === 'default' ? undefined : HISTORY_ID(1), a.flags(prod).fault === 'purge' ? { ...NP } : prod ? {} : NP);
				const after = w.readState();
				assert.deepEqual({ restore: count(w, 'compose-restore'), apply: count(w, 'compose-apply'), install: count(w, 'install'), build: count(w, 'build') }, built, `${tag}: no restore, no rebuild`);
				assert.equal(after.live.stageId, live, `${tag}: the same tree is live`);
				assert.equal(after.prev?.stageId, prevId, `${tag}: the fallback is the same release`);
				assert.ok(equalSnapshots(fallback, snapshot(w.prev)), `${tag}: the fallback tree was not replaced`);
				assert.equal(after.state, prod ? a.end.prod : a.end.np, tag);
				assert.equal(new Set(after.activations.map((x) => x.stageId)).size, after.activations.length, `${tag}: no stage was activated twice`);
				assert.equal(existsSync(opFile(w)), false, `${tag}: the finished operation is retired`);
			}
		}
	}
});

test('review 7.1: an explicit target that differs from the unfinished operation is refused (exit 6) and nothing changes; the recorded one still resumes', async (t) => {
	for (const arm of ['restart', 'purge']) {
		const w = world(t);
		const ctx = await twoReleases(w, NP);
		const flags = arm === 'restart' ? { ...NP, fault: 'restart' } : { ...NP, fault: 'purge' };
		assert.notEqual(await outcome(() => rollbackComposed(ctx, HISTORY_ID(1), flags)), 'ok');
		const before = snapshot(w.root);
		const calls = w.calls.length;
		assert.equal(await outcome(() => rollbackComposed(ctx, HISTORY_ID(2), NP)), EXIT.PRECOND, arm);
		assert.equal(w.calls.length, calls);
		assert.ok(equalSnapshots(before, snapshot(w.root)));
		assert.equal(await outcome(() => rollbackComposed(ctx, undefined, NP)), 'ok', arm);
	}
});

test('review 7.1: the record exists before the inputs are restored; a failure or kill before the swap keeps the same target for the retry, and an explicit different target replaces it', async (t) => {
	const w = world(t);
	const ctx = await twoReleases(w, NP);
	w.fail['compose-restore'] = 5;
	assert.equal(await outcome(() => rollbackComposed(ctx, undefined, NP)), EXIT.RECOVER);
	assert.deepEqual([readOp(w).target, readOp(w).stageId], [HISTORY_ID(1), null], 'recorded before the restore ran, no stage yet');
	delete w.fail['compose-restore'];
	// killed right after the build: the stage exists, the swap does not
	w.onCheckpoint = (name) => {
		if (name === 'composed:after-build') throw new InjectedCrash(name);
	};
	assert.equal(await outcome(() => rollbackComposed(ctx, undefined, NP)), 'killed');
	assert.equal(readOp(w).target, HISTORY_ID(1));
	assert.equal(readOp(w).stageId, w.readState().stageId, 'the built stage is recorded');
	w.onCheckpoint = null;
	const restores = w.calls.filter((c) => c.label === 'compose-restore').length;
	await rollbackComposed(ctx, undefined, NP);
	assert.deepEqual(w.calls.filter((c) => c.label === 'compose-restore').slice(restores).map((c) => c.argv.at(-1)), [HISTORY_ID(1)], 'the retry restored the recorded target');
	assert.equal(w.readState().state, 'active');
	assert.equal(existsSync(opFile(w)), false);

	// an uncommitted record is replaced by an explicit other target
	const x = world(t);
	const cx = await twoReleases(x, NP);
	x.fail['compose-restore'] = 5;
	await outcome(() => rollbackComposed(cx, HISTORY_ID(1), NP));
	delete x.fail['compose-restore'];
	await rollbackComposed(cx, HISTORY_ID(2), NP);
	assert.equal(x.calls.filter((c) => c.label === 'compose-restore').at(-1).argv.at(-1), HISTORY_ID(2));
});

test('review 7.1: a previous-restore records its target and direction first; every failure state resumes it (no "no previous tree" error, no second swap)', async (t) => {
	for (const a of ARMS) {
		for (const prod of worldsFor(a)) {
			const tag = `${a.name} / ${prod ? 'production' : 'copy'}`;
			const w = world(t, { production: prod });
			const ctx = w.ctx();
			await build(ctx, {});
			await activate(ctx, prod ? {} : NP);
			a.arm(w, prod);
			const first = await outcome(() => rollbackPrevious(ctx, a.flags(prod)));
			assert.notEqual(first, 'ok', tag);
			const op = readOp(w);
			assert.deepEqual([op.kind, op.direction], ['previous', 'to-previous'], tag);
			const st = w.readState();
			assert.equal(op.target, st.live.stageId, `${tag}: the record names the restored stage`);
			const failedTree = snapshot(w.failedTree);
			a.disarm(w);
			await rollbackPrevious(ctx, a.flags(prod).fault === 'purge' ? { ...NP } : prod ? {} : NP);
			const after = w.readState();
			assert.equal(after.live.stageId, st.live.stageId, `${tag}: still the restored tree`);
			assert.equal(after.prev, null, `${tag}: nothing was swapped back in`);
			assert.ok(equalSnapshots(failedTree, snapshot(w.failedTree)), `${tag}: the failed tree was not replaced`);
			assert.equal(after.state, prod ? (a.end.prod === 'purged' ? 'purged' : a.end.prod) : a.end.np === 'active' ? 'restored-previous' : a.end.np, tag);
			assert.equal(existsSync(opFile(w)), false, tag);
		}
	}
});

test('review 7.1: a previous-restore killed in the middle of its swap and recovered is retried from its record; a committed composed rollback is superseded by previous, and blocks a legacy or another-kind retry until finished', async (t) => {
	const w = world(t);
	const ctx = w.ctx();
	await build(ctx, {});
	await activate(ctx, NP);
	const prevBefore = w.readState().prev.stageId;
	assert.equal(await outcome(() => rollbackPrevious(ctx, { ...NP, fault: 'swap-mid' })), 'killed');
	assert.deepEqual([readOp(w).kind, readOp(w).target], ['previous', prevBefore]);
	await recover(ctx);
	await rollbackPrevious(ctx, NP);
	assert.equal(w.readState().live.stageId, prevBefore);
	assert.equal(existsSync(opFile(w)), false);

	// composed rollback whose smoke failed: `previous` is the documented way back, and supersedes the composed record
	const x = world(t);
	const cx = await twoReleases(x, NP);
	x.smokeOk = false;
	assert.equal(await outcome(() => rollbackComposed(cx, undefined, NP)), EXIT.SMOKE);
	assert.equal(readOp(x).kind, 'composed');
	assert.equal(await outcome(() => rollbackLegacy(cx, 'tag-1', NP)), EXIT.PRECOND, 'a legacy rollback does not run over an unfinished composed one');
	x.smokeOk = true;
	await rollbackPrevious(cx, NP);
	assert.equal(existsSync(opFile(x)), false);
	assert.equal(x.readState().state, 'restored-previous');
});

test('review 7.1: a purge-failed previous-restore blocks a default composed rollback (it would re-deploy the release just rolled back); finishing the previous restore unblocks it', async (t) => {
	const w = world(t);
	const ctx = await twoReleases(w, NP);
	assert.notEqual(await outcome(() => rollbackPrevious(ctx, { ...NP, fault: 'purge' })), 'ok');
	assert.equal(w.readState().state, 'purge-failed');
	const calls = w.calls.length;
	assert.equal(await outcome(() => rollbackComposed(ctx, undefined, NP)), EXIT.PRECOND);
	assert.equal(w.calls.length, calls, 'nothing ran');
	await rollbackPrevious(ctx, NP);
	assert.equal(existsSync(opFile(w)), false);
});

test('review 7.1: an unreadable record is refused, not guessed at', async (t) => {
	const w = world(t);
	const ctx = await twoReleases(w, NP);
	writeFileSync(opFile(w), '{"version":1,"kind":');
	assert.equal(await outcome(() => rollbackComposed(ctx, HISTORY_ID(1), NP)), EXIT.PRECOND);
	assert.equal(await outcome(() => rollbackPrevious(ctx, NP)), EXIT.PRECOND);
	assert.equal(w.readState().state, 'active');
});

test('review 7.2: an operation takes the lock after a kill left a torn tail on the deploy log; the next record is not glued onto the fragment', async (t) => {
	const w = world(t);
	const ctx = w.ctx();
	await build(ctx, {});
	const log = path.join(w.root, '.deploy-state', 'log.jsonl');
	appendFileSync(log, '{"at":"x","step":"sta');
	await underLock(ctx, async () => logStep(ctx.paths, 'after', {}));
	const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
	for (const l of lines) JSON.parse(l);
	assert.equal(JSON.parse(lines.at(-1)).step, 'after');
});

test('review 7.2: the only append-only logs are temps.log and the deploy log, and each is repaired before it is appended to', async () => {
	const { readdirSync } = await import('node:fs');
	const here = path.dirname(new URL(import.meta.url).pathname);
	const sources = [...readdirSync(here).map((n) => path.join(here, n)), ...readdirSync(path.join(here, '../compose')).map((n) => path.join(here, '../compose', n)), ...readdirSync(path.join(here, '../compose/lib')).map((n) => path.join(here, '../compose/lib', n))].filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && !f.endsWith('durable.mjs'));
	const users = sources.filter((f) => /\bappendFile\(/.test(readFileSync(f, 'utf8'))).map((f) => path.basename(f)).sort();
	assert.deepEqual(users, ['journal.mjs', 'lib.mjs'], 'a new append-only writer must repair its torn tail first (durable.repairTornTail) and be listed here');
	for (const f of ['journal.mjs', 'lib.mjs']) assert.match(readFileSync(sources.find((s) => s.endsWith(`/${f}`)), 'utf8'), /repairTornTail\(/, f);
});
