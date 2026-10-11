// node --test tools/deploy/review4.test.mjs   (cwd: packages/storefront)
// Review round 4 regression tests: directory fsyncs and tree-verified swap recovery (4.1), stage-bound legacy resume (4.2),
// composed rollback target selection (4.4). Recovery temporaries (4.3) are in tools/compose/journal.test.mjs.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { activate, build } from './entry.mjs';
import { InjectedCrash, fsyncHooks, writeJsonAtomic } from './lib.mjs';
import { pickComposedTarget, rollbackLegacy } from './rollback.mjs';
import { recoverSwap, restoreOps, runOps, swapOps } from './stage.mjs';
import { HISTORY_ID, makeWorld, sha } from './fixtures/world.mjs';

const NP = { noRestart: true, smokePort: 4555 };
const world = (t, o) => {
	const w = makeWorld(o);
	t.after(w.cleanup);
	return w;
};

function trees(t, names) {
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'r4-')));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const n of names) {
		mkdirSync(path.join(root, n));
		writeFileSync(path.join(root, n, 'id'), n);
	}
	const p = { root, live: path.join(root, 'live'), next: path.join(root, 'next'), prev: path.join(root, 'prev'), failed: path.join(root, 'failed'), removed: path.join(root, 'removed') };
	return { root, p };
}
const where = (root, n) => (existsSync(path.join(root, n, 'id')) ? readFileSync(path.join(root, n, 'id'), 'utf8') : null);
const done = (ops) => ops.map((o) => ({ ...o, status: 'done' }));

// ------------------------------------------------------------------ 4.1

test('review 4.1: every journal replace and every tree rename is followed by a directory fsync before it is recorded or acted on', (t) => {
	const { root, p } = trees(t, ['live', 'next', 'prev']);
	const events = [];
	fsyncHooks.onDir = (d) => events.push(`fsync:${path.relative(root, d) || '.'}`);
	t.after(() => (fsyncHooks.onDir = null));
	runOps({
		p,
		ops: swapOps(p),
		record: (ops) => events.push(`record:${ops.map((o) => o.status[0]).join('')}`),
	});
	// each rename: record(started) ... fsync(root) ... record(done); a rename is never recorded done before its fsync
	for (const done of ['record:dpp', 'record:ddp', 'record:ddd']) {
		const i = events.indexOf(done);
		assert.ok(i > 0 && events[i - 1] === 'fsync:.', `${done} follows a root fsync: ${events.join(' ')}`);
	}
	assert.equal(events.filter((e) => e === 'fsync:.').length >= 4, true, 'three renames and the deletion of the moved-aside tree each fsync the root');
	// the journal replace fsyncs its directory
	events.length = 0;
	writeJsonAtomic(path.join(root, 'state.json'), { a: 1 });
	assert.deepEqual(events, ['fsync:.']);
});

test('review 4.1: recovery trusts the trees, not the recorded statuses: a journal that says done while the renames did not persist is undone', (t) => {
	const { root, p } = trees(t, ['live', 'next', 'prev']);
	// host crash: the journal reached the disk (all done) but none of the renames did
	const r = recoverSwap({ p, ops: done(swapOps(p)) });
	assert.equal(r.direction, 'undone');
	assert.deepEqual([where(root, 'live'), where(root, 'next'), where(root, 'prev')], ['live', 'next', 'prev'], 'nothing moved, nothing deleted');
});

test('review 4.1: recovery completes a swap whose renames persisted although the journal still says pending or started', (t) => {
	const { root, p } = trees(t, ['live', 'next', 'prev']);
	// really performed: prev -> removed, live -> prev, next -> live
	const mv = (a, b) => renameSync(path.join(root, a), path.join(root, b));
	mv('prev', 'removed');
	mv('live', 'prev');
	mv('next', 'live');
	const ops = swapOps(p);
	ops[0].status = 'started'; // the journal lagged behind the directory
	const r = recoverSwap({ p, ops });
	assert.equal(r.direction, 'completed');
	assert.deepEqual([where(root, 'live'), where(root, 'prev'), existsSync(p.removed)], ['next', 'live', false], 'the new tree is live, the old live is prev, the moved-aside tree is deleted');
});

test('review 4.1: a swap interrupted after the first renames is reversed from the actual trees, in either journal state', (t) => {
	for (const status of ['pending', 'started', 'done']) {
		const { root, p } = trees(t, ['live', 'next', 'prev']);
		// prev -> removed and live -> prev persisted; next -> live did not
		rmSync(path.join(root, 'prev'), { recursive: true });
		mkdirSync(path.join(root, 'removed'));
		writeFileSync(path.join(root, 'removed/id'), 'prev');
		rmSync(path.join(root, 'live'), { recursive: true });
		mkdirSync(path.join(root, 'prev'));
		writeFileSync(path.join(root, 'prev/id'), 'live');
		const ops = swapOps(p).map((o) => ({ ...o, status }));
		const r = recoverSwap({ p, ops });
		assert.equal(r.direction, 'undone', status);
		assert.deepEqual([where(root, 'live'), where(root, 'next'), where(root, 'prev'), existsSync(p.removed)], ['live', 'next', 'prev', false], status);
	}
});

test('review 4.1: the restore renames recover the same way', (t) => {
	const { root, p } = trees(t, ['live', 'prev', 'failed']);
	const r = recoverSwap({ p, ops: done(restoreOps(p)) });
	assert.equal(r.direction, 'undone');
	assert.deepEqual([where(root, 'live'), where(root, 'prev'), where(root, 'failed')], ['live', 'prev', 'failed']);
});

// ------------------------------------------------------------------ 4.2

// the legacy tree is live; a composed build needs it re-adopted first (the one-time adoption marker)
const readopt = (w) => w.write(path.join(w.live, '.compose-managed.json'), '{}');

function legacyWorld(t) {
	const w = world(t);
	const tag = 'tag-1';
	w.write(path.join(w.root, '.compose-history/compose-adoption.json'), JSON.stringify({ legacyCommit: w.tagCommit, legacyTag: tag }));
	const rec = path.join(w.root, '.deploy-backups/legacy-client', tag);
	const files = Object.fromEntries(Object.entries(w.legacyFiles).map(([k, v]) => [k, sha(v)]));
	w.write(path.join(rec, 'legacy-input.json'), JSON.stringify({ tag, commit: w.tagCommit, node: w.versions.node, pnpm: w.versions.pnpm, files }));
	const clientRel = 'sellright/packages/storefront-client/package.json';
	w.write(path.join(rec, clientRel), '{"name":"client"}');
	w.write(path.join(rec, 'closure.json'), JSON.stringify({ files: { [clientRel]: sha('{"name":"client"}') } }));
	return { w, tag };
}

test('review 4.2: a second rollback to the same tag interrupted during extraction does not reuse the first rollback\'s completed journal', async (t) => {
	const { w, tag } = legacyWorld(t);
	const ctx = w.ctx();
	await rollbackLegacy(ctx, tag, NP);
	const first = JSON.parse(readFileSync(ctx.paths.legacyJournal, 'utf8'));
	assert.ok(first.completed.includes('artifacts'), 'the first rollback left a completed journal behind');
	// a composed release goes live in between, so the tag is not the live release any more
	readopt(w);
	await build(ctx, {});
	await activate(ctx, NP);
	// second rollback to the same tag: killed right after the stage's extraction command
	let tars = 0;
	w.crashAfter = {
		get tar() {
			return ++tars === 2;
		},
	};
	await assert.rejects(rollbackLegacy(ctx, tag, NP), InjectedCrash);
	const state = w.readState();
	const journal = JSON.parse(readFileSync(ctx.paths.legacyJournal, 'utf8'));
	assert.equal(journal.stageId, state.stageId, 'the journal was replaced with the new stage\'s before extraction started');
	assert.deepEqual(journal.completed, [], 'extraction is not marked complete');
	assert.notEqual(journal.stageId, first.stageId);
	// the retry discards the partial stage and rebuilds from the archive instead of continuing from it
	w.crashAfter = {};
	rmSync(path.join(w.next, 'package.json'), { force: true }); // partial extraction: the stage lacks files
	await rollbackLegacy(ctx, tag, NP);
	assert.equal(w.readState().state, 'active');
	assert.equal(JSON.parse(readFileSync(path.join(w.live, 'package.json'), 'utf8')).name, 'legacy');
});

// ------------------------------------------------------------------ 4.4

test('review 4.4: the default composed rollback target is a composed activation, never a legacy tag (composed -> legacy -> composed)', async (t) => {
	const { w, tag } = legacyWorld(t);
	const ctx = w.ctx();
	await build(ctx, {});
	await activate(ctx, NP);
	const h1 = w.readState().activations.at(-1);
	assert.equal(h1.origin, 'compose');
	await rollbackLegacy(ctx, tag, NP);
	const legacy = w.readState().activations.at(-1);
	assert.equal(legacy.origin, 'legacy');
	assert.equal(legacy.historyId, tag, 'the legacy activation stores its tag as historyId');
	readopt(w);
	await build(ctx, {});
	await activate(ctx, NP);
	const s = w.readState();
	assert.equal(s.activations.at(-1).origin, 'compose');
	assert.equal(pickComposedTarget(s), h1.historyId, 'the earlier composed release, not the legacy tag');
});

test('review 4.4: pickComposedTarget ignores legacy entries by origin and, for records without origin, by id shape', () => {
	const act = (stageId, historyId, origin) => ({ kind: 'activate', smoke: 'passed', stageId, historyId, ...(origin ? { origin } : {}) });
	const state = { live: { stageId: 's4' }, activations: [act('s1', HISTORY_ID(1), 'compose'), act('s2', 'tag-1', 'legacy'), act('s3', 'tag-2'), act('s4', HISTORY_ID(2), 'compose')] };
	assert.equal(pickComposedTarget(state), HISTORY_ID(1));
	assert.equal(pickComposedTarget({ live: { stageId: 's9' }, activations: [act('s2', 'tag-1', 'legacy')] }), null);
});
