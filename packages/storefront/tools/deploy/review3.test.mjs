// node --test tools/deploy/review3.test.mjs   (cwd: packages/storefront)
// Review round 3 regression tests for the deploy tools: the artifact gate of an SSR build (3.1), the smoke child's ownership
// (3.2), the retained retention markers (3.3), rollback retries and unfinished swaps (3.4), the shared deployment lock (3.5).
// Real processes only where the defect needs one (a killed parent, a real HTTP server, a real lock descriptor).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { activate, build, defaultDeps, recover, restorePreviousCommand } from './entry.mjs';
import { DeployError, EXIT, ensureStateDir, pathsFor, procStartTicks, reapSmokeChild, takeLock } from './lib.mjs';
import { rollbackComposed, rollbackPrevious } from './rollback.mjs';
import { main as stageMain, checkArtifacts } from './stage.mjs';
import { HISTORY_ID, HASHES, equalSnapshots, makeWorld, snapshot, writeBuilt } from './fixtures/world.mjs';

const NP = { noRestart: true, smokePort: 4555 };
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return true;
		await sleepMs(25);
	}
	return false;
}
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
const groupAlive = (pgid) => {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
};
const entryText = (tree) => readFileSync(path.join(tree, 'server/entry.express.js'), 'utf8');
const marker = (w) => path.join(w.root, '.deploy-backups/store-assets-active.json');

// ------------------------------------------------------------------ 3.1 artifact gate

test('review 3.1: the artifact gate accepts what this checkout\'s SSR build produces (no dist/index.html) and still refuses what it needs', (t) => {
	// the express adapter of this checkout prerenders nothing: no HTML document exists under dist/ by design
	const adapter = readFileSync(new URL('../../adapters/express/vite.config.mts', import.meta.url), 'utf8');
	assert.match(adapter, /ssg:\s*\{\s*include:\s*\[\s*\]\s*\}/, 'prerendering is disabled for every build');
	const w = world(t);
	const tree = path.join(w.base, 'ssr-tree');
	writeBuilt(tree, 'ssr');
	assert.equal(existsSync(path.join(tree, 'dist/index.html')), false, 'the fixture is shaped like the real build: no index.html');
	assert.deepEqual(checkArtifacts({ tree }), { ok: true, problems: [] });
	// what the SSR build does need is still required
	for (const rel of ['server/entry.express.js', 'dist/q-manifest.json', 'dist/build']) {
		const t2 = path.join(w.base, `no-${rel.replaceAll('/', '-')}`);
		writeBuilt(t2, 'x');
		rmSync(path.join(t2, rel), { recursive: true });
		assert.equal(checkArtifacts({ tree: t2 }).ok, false, rel);
	}
});

test('review 3.1: a real composed build, activation and restore run against trees without dist/index.html', async (t) => {
	const w = world(t);
	const ctx = w.ctx();
	await build(ctx, {});
	assert.equal(existsSync(path.join(w.next, 'dist/index.html')), false);
	await activate(ctx, NP);
	assert.equal(w.readState().state, 'active');
	await restorePreviousCommand(ctx, NP);
	assert.equal(w.readState().state, 'restored-previous');
});

// ------------------------------------------------------------------ 3.2 smoke child

/** The entry stand-in for the smoke child tests: the real lock, the real startLocal, the journal the real smokeLocal writes. */
function launcherScript(w, { cwd, port, pollMs }) {
	const u = (f) => JSON.stringify(new URL(f, import.meta.url).href);
	return `import { loadConfig, recordSmokeChild, underLock } from ${u('./lib.mjs')};
import { makeContext } from ${u('./entry.mjs')};
const ctx = makeContext(loadConfig(${JSON.stringify(w.config())}));
await underLock(ctx, async () => {
	const h = await ctx.deps.startLocal({ cwd: ${JSON.stringify(cwd)}, port: ${port}, env: { PATH: process.env.PATH, PORT: '${port}', HOST: '127.0.0.1' }, inheritFd: ctx.lockFd, parentPollMs: ${pollMs}, onSpawn: (info) => recordSmokeChild(ctx.paths, { ...info, port: ${port}, cwd: ${JSON.stringify(cwd)} }) });
	console.log(JSON.stringify({ pid: h.pid }));
	setInterval(() => {}, 1000);
	await new Promise(() => {});
});
`;
}
async function startLauncher(w, t, pollMs) {
	const cwd = path.join(w.base, 'smoke-tree');
	mkdirSync(path.join(cwd, 'server'), { recursive: true });
	writeFileSync(path.join(cwd, 'server/entry.express.js'), "require('node:http').createServer((q, r) => r.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');\n");
	const port = await defaultDeps().freePort();
	const script = path.join(w.base, 'launcher.mjs');
	writeFileSync(script, launcherScript(w, { cwd, port, pollMs }));
	const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
	const out = await new Promise((resolve, reject) => {
		child.stdout.once('data', (d) => resolve(String(d)));
		child.once('exit', () => reject(new Error('the launcher exited before starting the smoke child')));
	});
	const { pid } = JSON.parse(out);
	t.after(() => {
		child.kill('SIGKILL');
		try {
			process.kill(-pid, 'SIGKILL');
		} catch {
			/* already gone */
		}
	});
	const serves = async () => {
		try {
			return (await fetch(`http://127.0.0.1:${port}/`)).status === 200;
		} catch {
			return false;
		}
	};
	assert.ok(await until(serves), 'the smoke server answers');
	return { child, pid, port, serves, p: pathsFor(w.ctx().cfg) };
}
const killAndWait = async (child) => {
	child.kill('SIGKILL');
	await new Promise((r) => child.on('exit', r));
};

test('review 3.2: a SIGKILLed entry does not leave its smoke server running: the supervisor stops it, and the lock is released', async (t) => {
	const w = world(t);
	const s = await startLauncher(w, t, 100);
	const rec = JSON.parse(readFileSync(s.p.smokeChild, 'utf8'));
	assert.equal(rec.pid, s.pid, 'the pid is journaled');
	assert.equal(rec.startTicks, procStartTicks(s.pid), 'with its start time');
	assert.equal(rec.parentPid, s.child.pid);
	await assert.rejects(takeLock(s.p), (e) => e instanceof DeployError && e.exit === EXIT.RECOVER, 'the group holds the lock while it lives');
	await killAndWait(s.child);
	assert.ok(await until(() => !groupAlive(s.pid)), 'the whole smoke group exits after its parent dies');
	assert.equal(await s.serves(), false, 'the server no longer answers');
	await (await takeLock(s.p))();
	// the journal that is left names a child that is gone: reaping drops it and signals nothing
	assert.deepEqual(await reapSmokeChild(s.p), { reaped: false });
	assert.equal(existsSync(s.p.smokeChild), false);
});

test('review 3.2: recover stops a smoke child whose parent died (identity checked), then takes the lock it held', async (t) => {
	const w = world(t);
	const s = await startLauncher(w, t, 600000); // a supervisor that never notices on its own: only recover can end it
	await killAndWait(s.child);
	await sleepMs(300);
	assert.equal(groupAlive(s.pid), true, 'the orphaned group is still running');
	await assert.rejects(takeLock(s.p), (e) => e instanceof DeployError && e.exit === EXIT.RECOVER);
	assert.equal(await exit(() => recover(w.ctx())), 0, 'recover succeeds although the orphan held the lock');
	assert.equal(groupAlive(s.pid), false);
	assert.equal(await s.serves(), false);
	assert.equal(existsSync(s.p.smokeChild), false, 'the record is retired');
	await (await takeLock(s.p))();
});

test('review 3.2: reaping signals nothing unless the record still names its process: a live parent, a reused pid and a dead parent with a matching identity', async (t) => {
	const w = world(t);
	const p = pathsFor(w.ctx().cfg);
	ensureStateDir(p);
	const victim = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
	victim.unref();
	t.after(() => {
		try {
			process.kill(-victim.pid, 'SIGKILL');
		} catch {
			/* already gone */
		}
	});
	const write = (over) => writeFileSync(p.smokeChild, JSON.stringify({ version: 1, pid: victim.pid, startTicks: procStartTicks(victim.pid), parentPid: 2 ** 22 + 7, parentStartTicks: 'gone', ...over }));
	// the entry that started it is still running: nothing is touched, the record stays
	write({ parentPid: process.pid, parentStartTicks: procStartTicks(process.pid) });
	assert.equal((await reapSmokeChild(p)).reaped, false);
	assert.equal(groupAlive(victim.pid), true);
	assert.equal(existsSync(p.smokeChild), true);
	// the pid was reused by another process (different start time): not ours, never signalled
	write({ startTicks: '1' });
	assert.equal((await reapSmokeChild(p)).reaped, false);
	assert.equal(groupAlive(victim.pid), true, 'an unrelated process survives a stale record');
	assert.equal(existsSync(p.smokeChild), false);
	// the parent is gone and the identity matches: that group is stopped
	write({});
	assert.equal((await reapSmokeChild(p)).reaped, true);
	assert.ok(await until(() => !groupAlive(victim.pid)));
});

test('review 3.2: the smoke child is journaled with its pid and start time before readiness is polled, and the record is retired after the stop', async (t) => {
	const w = world(t);
	const p = pathsFor(w.ctx().cfg);
	const seen = [];
	w.deps.startLocal = (o) => {
		o.onSpawn?.({ pid: 4242424, startTicks: '77' });
		return { alive: () => true, stop: async () => {} };
	};
	w.deps.waitReady = async () => {
		seen.push(existsSync(p.smokeChild) ? JSON.parse(readFileSync(p.smokeChild, 'utf8')) : null);
		return true;
	};
	const ctx = w.ctx();
	await build(ctx, {});
	await activate(ctx, NP);
	assert.equal(seen.length, 2, 'candidate smoke and live smoke');
	for (const r of seen) {
		assert.equal(r?.pid, 4242424, 'the record existed when readiness was polled');
		assert.equal(r.startTicks, '77');
		assert.equal(r.parentPid, process.pid);
	}
	assert.equal(existsSync(p.smokeChild), false, 'retired after the stop');
});

// ------------------------------------------------------------------ 3.3 retained markers

test('review 3.3: an aborted activation keeps the retained previous release\'s marker; rollback previous after recover restores it', async (t) => {
	const w = world(t);
	const M0 = '{"active":["a"]}\n';
	const MB = '{"active":["release-b"]}\n';
	const ctx = w.ctx();
	// legacy (M0) -> B
	await build(ctx, {});
	await activate(ctx, NP);
	w.write(marker(w), MB); // the retention helper of release B leaves its marker
	// B -> C, interrupted after the first rename and recovered (the renames are reversed, prev is the legacy tree again)
	await build(ctx, {});
	await assert.rejects(activate(ctx, { ...NP, fault: 'swap-mid' }), (e) => e.name === 'InjectedCrash');
	assert.equal((await recover(ctx)).action, 'swap-undone');
	assert.equal(readFileSync(marker(w), 'utf8'), MB, 'the live release (B) has its own marker again');
	assert.ok(readdirSync(path.join(w.root, '.deploy-state/marker-prev')).length >= 1, 'the retained marker of the previous release is still there');
	// rolling back to the previous release restores ITS marker, not the displaced release's
	await rollbackPrevious(ctx, NP);
	assert.equal(entryText(w.live), 'entry-v1', 'the previous (legacy) tree is live');
	assert.equal(readFileSync(marker(w), 'utf8'), M0, 'the previous release\'s marker is back');
});

// ------------------------------------------------------------------ 3.4 composed rollback retries

const writeMeta = (w, n) => {
	const id = HISTORY_ID(n);
	const f = path.join(w.layer, '..', '.compose-history', id, 'meta.json');
	w.write(f, JSON.stringify({ id, status: 'built', hashes: { ...HASHES }, buildConfigHash: w.buildConfigHash }));
};
async function twoReleases(w) {
	const ctx = w.ctx();
	await build(ctx, {});
	await activate(ctx, NP);
	writeMeta(w, 1);
	await build(ctx, {});
	await activate(ctx, NP);
	writeMeta(w, 2);
	return ctx;
}
const applies = (w) => w.calls.filter((c) => c.label === 'compose-apply').length;

test('review 3.4: retrying an explicit composed rollback after a failed restart or smoke resumes it; the rebuilt history id is not what it is matched against', async (t) => {
	for (const [name, arm, disarm] of [
		['restart', () => ({ ...NP, fault: 'restart' }), () => {}],
		['smoke', (w) => ((w.smokeOk = false), NP), (w) => (w.smokeOk = true)],
	]) {
		const w = world(t);
		const ctx = await twoReleases(w);
		const target = HISTORY_ID(1);
		assert.notEqual(await exit(() => rollbackComposed(ctx, target, arm(w))), 0, name);
		const failed = w.readState();
		assert.equal(failed.inflight.target, target, `${name}: the requested target is recorded with the operation`);
		assert.notEqual(failed.inflight.historyId, target, `${name}: the rebuilt stage got a history id of its own`);
		const fallback = snapshot(w.prev);
		const n = applies(w);
		disarm(w);
		await rollbackComposed(ctx, target, NP);
		assert.equal(applies(w), n, `${name}: the retry did not rebuild`);
		assert.ok(equalSnapshots(fallback, snapshot(w.prev)), `${name}: the fallback was not replaced`);
		assert.equal(w.readState().state, 'active', name);
	}
});

test('review 3.4: an unrelated rollback or build is refused, before anything is rebuilt, while an operation is unfinished; its record stays intact', async (t) => {
	const w = world(t);
	const ctx = await twoReleases(w);
	w.smokeOk = false;
	assert.notEqual(await exit(() => rollbackComposed(ctx, HISTORY_ID(1), NP)), 0);
	w.smokeOk = true;
	const before = w.readState();
	const n = applies(w);
	// another history id, and a plain build: both would overwrite the record `resume` and the retry work from
	assert.equal(await exit(() => rollbackComposed(ctx, HISTORY_ID(2), NP)), EXIT.PRECOND);
	assert.equal(await exit(() => build(ctx, {})), EXIT.PRECOND);
	assert.equal(applies(w), n, 'nothing was composed or rebuilt');
	assert.deepEqual(w.readState().inflight, before.inflight);
	assert.equal(w.readState().state, before.state);
	// the original command still finishes it
	await rollbackComposed(ctx, HISTORY_ID(1), NP);
	assert.equal(w.readState().state, 'active');
});

// ------------------------------------------------------------------ 3.5 one lock

test('review 3.5: stage.mjs seed and carry-server take the deployment lock; they are refused while an operation holds it', async (t) => {
	const w = world(t);
	const p = pathsFor(w.ctx().cfg);
	const lines = [];
	const out = { log: (m) => lines.push(m), error: (m) => lines.push(`ERR ${m}`) };
	const release = await takeLock(p);
	const before = readdirSync(w.root).sort();
	assert.equal(await stageMain(['--config', w.config(), 'seed'], out), EXIT.RECOVER);
	assert.equal(await stageMain(['--config', w.config(), 'carry-server'], out), EXIT.RECOVER);
	assert.deepEqual(readdirSync(w.root).sort(), before, 'no stage was written');
	await release();
	assert.equal(await stageMain(['--config', w.config(), 'seed'], out), 0);
	assert.equal(existsSync(w.next), true);
	// read-only check-artifacts never needed the lock
	const hold = await takeLock(p);
	assert.equal(await stageMain(['--config', w.config(), 'check-artifacts', '--tree', 'live'], out), 0);
	await hold();
});

test('review 3.5: while a deployment operation holds the lock, standalone compose refuses (exit 5); compose delegated by that operation runs under it', async (t) => {
	const w = world(t);
	const p = pathsFor(w.ctx().cfg);
	mkdirSync(w.next, { recursive: true });
	const composeCli = fileUrl('../compose/compose.mjs');
	const run = (stdio) =>
		new Promise((resolve) => {
			const c = spawn(process.execPath, [composeCli, w.layer, '--out', w.next, '--recover'], { stdio });
			let err = '';
			c.stderr?.on('data', (d) => (err += d));
			c.stdout?.on('data', () => {});
			c.on('exit', (code) => resolve({ code, err }));
		});
	const release = await takeLock(p);
	// no inherited descriptor: another process, not inside the operation
	const alone = await run(['ignore', 'pipe', 'pipe']);
	assert.equal(alone.code, 5, alone.err);
	assert.match(alone.err, /another operation holds/);
	// an unrelated descriptor 3 cannot pose as the lock
	const fake = openSync(path.join(w.base, 'not-a-lock'), 'w');
	assert.equal((await run(['ignore', 'pipe', 'pipe', fake])).code, 5);
	// the descriptor the runner hands down (the lock's own socket) is verified and accepted
	assert.equal(release.fd != null, true);
	const delegated = await run(['ignore', 'pipe', 'pipe', release.fd]);
	assert.equal(delegated.code, 0, delegated.err);
	await release();
	assert.equal((await run(['ignore', 'pipe', 'pipe'])).code, 0, 'free again once the operation is over');
});
const fileUrl = (rel) => new URL(rel, import.meta.url).pathname;

test('review 3.5: while a compose holds its lock, a deployment operation is refused (exit 5)', async (t) => {
	const w = world(t);
	const p = pathsFor(w.ctx().cfg);
	const { acquireLock } = await import('../compose/lib/journal.mjs');
	const release = await acquireLock(w.root);
	assert.equal(await exit(() => build(w.ctx(), {})), EXIT.RECOVER);
	assert.equal(w.called('compose-apply'), false);
	await assert.rejects(takeLock(p), (e) => e instanceof DeployError && e.exit === EXIT.RECOVER);
	await release();
	await (await takeLock(p))();
});


test('review 3.6: temporaries that an atomic write left behind when killed are removed by the next write and by recover; nothing else is', async (t) => {
	const w = world(t);
	const ctx = w.ctx();
	await build(ctx, {});
	const dir = path.join(w.root, '.deploy-state');
	for (const n of ['storefront.json.tmp-999', 'lock.tmp-4242', 'marker-before.meta.json.tmp-17']) writeFileSync(path.join(dir, n), 'stale');
	writeFileSync(path.join(dir, 'keep.txt'), 'mine');
	writeFileSync(path.join(dir, 'storefront.json.tmp-notapid'), 'not ours to judge');
	await recover(ctx);
	const left = readdirSync(dir).filter((n) => /\.tmp-/.test(n));
	assert.deepEqual(left, ['storefront.json.tmp-notapid'], 'pid-suffixed leftovers are gone, others stay');
	assert.equal(existsSync(path.join(dir, 'keep.txt')), true);
	writeFileSync(path.join(dir, 'storefront.json.tmp-31337'), 'stale');
	await build(w.ctx(), {});
	assert.equal(existsSync(path.join(dir, 'storefront.json.tmp-31337')), false, 'the next state write drops its own stale temporaries');
});
