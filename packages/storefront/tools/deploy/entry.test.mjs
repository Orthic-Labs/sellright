// node --test tools/deploy/entry.test.mjs   (cwd: packages/storefront)
// Plan A §4.6a a (entry) and §4.5: staged build, swap, purge, restore-previous, recover. Findings C1, C2, C5, C6, C7, C8, C11.
// Every external command is a fake: no test here can reach pm2, a CDN, a network or the production tree.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { activate, build, defaultDeps, deploy, purge, recover, restorePreviousCommand, runCli } from './entry.mjs';
import { DeployError, EXIT, InjectedCrash, takeLock, pathsFor } from './lib.mjs';
import { HISTORY_ID, equalSnapshots, makeWorld, sha, snapshot } from './fixtures/world.mjs';

/** Runs a command; returns its exit code (0 on success), rethrows anything that is not a DeployError. */
async function exit(fn) {
	try {
		await fn();
		return 0;
	} catch (e) {
		if (e instanceof DeployError) return e.exit;
		throw e;
	}
}
/** Takes the deploy lock of world `w` in a child process and resolves once it holds it. */
async function holdLockInChild(w, t) {
	const script = path.join(w.base, 'holder.mjs');
	writeFileSync(script, `import { takeLock } from ${JSON.stringify(new URL('./lib.mjs', import.meta.url).href)};\nawait takeLock(${JSON.stringify(pathsFor(w.ctx().cfg))});\nconsole.log('locked');\nsetInterval(() => {}, 1000);\n`);
	const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
	t.after(() => child.kill('SIGKILL'));
	await new Promise((resolve, reject) => {
		child.stdout.once('data', resolve);
		child.once('exit', () => reject(new Error('the lock holder exited before locking')));
	});
	return child;
}
const world = (t, o) => {
	const w = makeWorld(o);
	t.after(w.cleanup);
	return w;
};
const NP = { noRestart: true, smokePort: 4555 };
/** The only purge a non-production root accepts: it reaches the state checks, then records a failure without calling anything. */
const PURGE_FAULT = { fault: 'purge' };
const entryOf = (w, tree) => readFileSync(path.join(tree, 'server/entry.express.js'), 'utf8');
const noRuntimeCalls = (w) => {
	assert.ok(!w.calls.some((c) => c.label === 'pm2' || c.label === 'fake-purge'), 'pm2 and the purge were never called');
	assert.ok(!w.started.some((s) => s.prod), 'the production restart was never called');
};

// ------------------------------------------------------------------ build

test('build: order b1 to b10, nothing outside the stage, history and state directory is written, state built', async (t) => {
	const w = world(t);
	const liveBefore = snapshot(w.live);
	const markerBefore = readFileSync(path.join(w.root, '.deploy-backups/store-assets-active.json'));
	const ctx = w.ctx();
	await build(ctx, {});
	assert.deepEqual(w.labels(), ['env', 'compose-apply', 'compose-check', 'install', 'build', 'compose-mark']);
	assert.ok(equalSnapshots(liveBefore, snapshot(w.live)), 'the live tree was not touched');
	assert.equal(readFileSync(path.join(w.root, '.deploy-backups/store-assets-active.json')).equals(markerBefore), true);
	const s = w.readState();
	assert.equal(s.state, 'built');
	assert.equal(s.source, `compose:${HISTORY_ID(1)}`);
	assert.equal(s.buildConfigHash, w.buildConfigHash);
	assert.equal(s.buildConfigSha, sha(readFileSync(path.join(w.next, 'build-config.json'))));
	assert.match(s.stageId, /^\d{8}T\d{6}Z-[0-9a-f]{6}$/);
	assert.equal(entryOf(w, w.next), 'entry-v2-store.next');
	assert.equal(w.mode(path.join(w.next, '.env')), 0o600);
	assert.equal(w.exists(path.join(w.root, '.deploy-state/marker-before.json')), true);
	noRuntimeCalls(w);
	// the generator is told the live .env as source and the stage as target
	const gen = w.calls.find((c) => c.label === 'env').argv;
	assert.deepEqual(gen.slice(-4), ['--source', path.join(w.live, '.env'), '--out', path.join(w.next, '.env')]);
	// compose got the layer, the stage as --out, the live tree, and no --adopt
	const comp = w.calls.find((c) => c.label === 'compose-apply').argv;
	assert.deepEqual(comp.slice(0, 5), ['fake-compose', w.layer, '--out', w.next, '--live']);
	assert.ok(comp.includes(w.live) && comp.includes('--apply') && !comp.includes('--adopt'));
});

test('build: every child runs under the allowlist, the build also gets the deploy token, no secret leaks into the log', async (t) => {
	const w = world(t);
	w.deps.env = { PATH: '/usr/bin', HOME: '/home/x', PNPM_HOME: '/p', SECRET_TOKEN: 'hunter2', STRIPE_KEY: 'sk_live' };
	await build(w.ctx(), {});
	for (const c of w.calls) {
		assert.deepEqual(Object.keys(c.env).filter((k) => !['PATH', 'HOME', 'PNPM_HOME', 'SELLRIGHT_DEPLOY_STAGE'].includes(k)), [], `${c.label}: only allowlisted names`);
		assert.equal(c.env.SECRET_TOKEN, undefined);
	}
	assert.equal(w.calls.find((c) => c.label === 'install').env.PNPM_HOME, '/p');
	assert.equal(w.calls.find((c) => c.label === 'build').env.SELLRIGHT_DEPLOY_STAGE, w.readState().stageId);
	const log = readFileSync(path.join(w.root, '.deploy-state/log.jsonl'), 'utf8');
	assert.ok(!log.includes('hunter2') && !log.includes('sk_live') && !log.includes('GENERATED=1'), 'neither env values nor .env content are logged');
	assert.ok(log.split('\n').filter(Boolean).every((l) => JSON.parse(l).step));
});

test('C5: a stray build selector is refused before anything runs, naming the variable only', async (t) => {
	for (const env of [{ SELLRIGHT_BUILD_SUFFIX: 'e2e' }, { SELLRIGHT_DISABLE_SSG: '1' }, { NODE_ENV: 'development' }, { VITE_X: '1' }, { E2E_FOO: '1' }, { PLAYWRIGHT_Z: '1' }]) {
		const w = world(t);
		w.deps.env = { PATH: '/usr/bin', ...env };
		const err = await build(w.ctx(), {}).catch((e) => e);
		assert.ok(err instanceof DeployError && err.exit === EXIT.ENV, JSON.stringify(env));
		assert.match(err.message, new RegExp(Object.keys(env)[0]));
		assert.deepEqual(w.calls, [], 'no command ran');
		assert.equal(w.exists(w.next), false, 'no stage was created');
		assert.equal(w.exists(w.state), false, 'no state was written');
	}
	const ok = world(t);
	ok.deps.env = { PATH: '/usr/bin', NODE_ENV: 'production' };
	await build(ok.ctx(), {});
});

test('C7: the guarded build script runs only through the entry (the fake build verifies the token against the state file)', async (t) => {
	const w = world(t);
	await build(w.ctx(), {});
	assert.equal(w.called('build'), true);
	// a later direct call without the token, from the stage the entry left behind, is refused
	const { checkToken } = await import('./build-guard.mjs');
	assert.equal(checkToken({ scriptDir: path.join(w.next, 'scripts'), env: {} }).ok, false);
	assert.equal(checkToken({ scriptDir: path.join(w.next, 'scripts'), env: { SELLRIGHT_DEPLOY_STAGE: w.readState().stageId } }).ok, false, 'state is built now, not building');
});

test('C2: a failing build leaves the live tree byte for byte as it was and the stage for inspection; the next build replaces it', async (t) => {
	const w = world(t);
	w.fail.build = 3;
	const before = snapshot(w.live);
	assert.equal(await exit(() => build(w.ctx(), {})), EXIT.FAIL);
	assert.ok(equalSnapshots(before, snapshot(w.live)));
	assert.equal(w.readState().state, 'build-failed');
	assert.equal(w.exists(w.next), true);
	noRuntimeCalls(w);
	w.fail = {};
	await build(w.ctx(), {});
	assert.equal(w.readState().state, 'built');
	assert.ok(equalSnapshots(before, snapshot(w.live)));
});

test('C2: a missing artifact after the build is exit 7 and build-failed; a stage the state does not mark is never removed', async (t) => {
	const w = world(t);
	w.skipArtifact = 'dist/q-manifest.json';
	assert.equal(await exit(() => build(w.ctx(), {})), EXIT.ARTIFACT);
	assert.equal(w.readState().state, 'build-failed');
	w.skipArtifact = null;
	// an unknown stage (no state file) is refused
	const x = world(t);
	mkdirSync(x.next);
	assert.equal(await exit(() => build(x.ctx(), {})), EXIT.PRECOND);
	assert.equal(x.exists(x.state), false);
});

test('build: a failing compose step maps its exit status (5 recovery, 6 refused, 7 mismatch) and marks the build failed', async (t) => {
	for (const [status, want] of [[5, EXIT.RECOVER], [6, EXIT.PRECOND], [7, EXIT.ARTIFACT], [1, EXIT.FAIL]]) {
		const w = world(t);
		w.fail['compose-apply'] = status;
		assert.equal(await exit(() => build(w.ctx(), {})), want);
		assert.equal(w.readState().state, 'build-failed');
		assert.equal(w.called('install'), false);
	}
	const w = world(t);
	w.fail['compose-check'] = 7;
	assert.equal(await exit(() => build(w.ctx(), {})), EXIT.ARTIFACT, 'C8: the build config check stops the build before install');
	assert.equal(w.called('install'), false);
	const g = world(t);
	g.fail.env = 1;
	assert.equal(await exit(() => build(g.ctx(), {})), EXIT.FAIL);
	assert.equal(g.called('compose-apply'), false, 'C8: the generator runs before compose');
});

test('C8: the env generator runs before compose, and the check reads exactly what the build reads, before the install', async (t) => {
	const w = world(t);
	await build(w.ctx(), {});
	const order = w.labels();
	assert.ok(order.indexOf('env') < order.indexOf('compose-apply'));
	assert.ok(order.indexOf('compose-apply') < order.indexOf('compose-check'));
	assert.ok(order.indexOf('compose-check') < order.indexOf('install'));
	// a generated .env that is group- or world-readable is refused (names only; the file is never read)
	const x = world(t);
	const orig = x.deps.run;
	x.deps.run = (c) => {
		const r = orig(c);
		if (x.calls.at(-1).label === 'env') chmodSync(path.join(x.next, '.env'), 0o644);
		return r;
	};
	assert.equal(await exit(() => build(x.ctx(), {})), EXIT.ARTIFACT);
});

// ------------------------------------------------------------------ adoption (C11)

const invFile = (w, over = {}) => {
	const f = path.join(w.base, 'inventory.json');
	writeFileSync(f, JSON.stringify({ legacyTag: 'tag-1', ...over }));
	return f;
};

test('C11: an unadopted live tree needs the explicit one-time adoption command; an ordinary build never adopts', async (t) => {
	const w = world(t, { adopted: false });
	assert.equal(await exit(() => build(w.ctx(), {})), EXIT.PRECOND);
	assert.deepEqual(w.labels(), [], 'refused before anything ran');
	assert.equal(w.exists(w.next), false);
	assert.equal(w.exists(w.state), false);
	assert.equal(await exit(() => build(w.ctx(), { adopt: invFile(w) })), EXIT.PRECOND, '--adopt needs --legacy-tag');
	assert.equal(await exit(() => build(w.ctx(), { legacyTag: 'tag-1' })), EXIT.PRECOND, '--legacy-tag needs --adopt');
	assert.equal(await exit(() => build(w.ctx(), { adopt: invFile(w, { legacyTag: 'other' }), legacyTag: 'tag-1' })), EXIT.PRECOND, 'inventory for another tag');
	w.gitDirty = true;
	assert.equal(await exit(() => build(w.ctx(), { adopt: invFile(w), legacyTag: 'tag-1' })), EXIT.PRECOND, 'a dirty or untracked store tree');
	w.gitDirty = false;
	w.tagTreeDiffers = true;
	assert.equal(await exit(() => build(w.ctx(), { adopt: invFile(w), legacyTag: 'tag-1' })), EXIT.PRECOND, 'tag tree differs from HEAD');
	assert.equal(w.called('compose-apply'), false);
	assert.equal(w.exists(w.next), false);
});

test('C11: the adoption command passes --adopt to compose with the live tree, once, and only then', async (t) => {
	const w = world(t, { adopted: false });
	const f = invFile(w);
	await build(w.ctx(), { adopt: f, legacyTag: 'tag-1' });
	const argv = w.calls.find((c) => c.label === 'compose-apply').argv;
	assert.equal(argv[argv.indexOf('--adopt') + 1], f);
	assert.ok(argv.includes('--live'));
	assert.ok(w.called('git:status') && w.calls.filter((c) => c.label === 'git:rev-parse').length === 2);
	// adopting an already adopted tree is refused
	const a = world(t);
	assert.equal(await exit(() => build(a.ctx(), { adopt: invFile(a), legacyTag: 'tag-1' })), EXIT.PRECOND);
	assert.equal(a.exists(a.next), false);
});

test('build: branch check and --pull (only when configured), --pin and the compose fault pass-through', async (t) => {
	const w = world(t);
	w.branch = 'feature';
	assert.equal(await exit(() => build(w.ctx({ branch: 'main' }), {})), EXIT.PRECOND);
	w.branch = 'main';
	await build(w.ctx({ branch: 'main' }), { pull: true, pin: 'f'.repeat(40) });
	assert.deepEqual(w.merged, ['f'.repeat(40)], 'fast-forwarded to the commit that was inspected');
	assert.ok(w.calls.find((c) => c.label === 'compose-apply').argv.includes('f'.repeat(40)));
	// fault injection reaches compose only for a non-production root, and only with the flag
	const x = world(t);
	await build(x.ctx(), { composeFault: 'write' });
	const c = x.calls.find((k) => k.label === 'compose-apply');
	assert.ok(c.argv.includes('--allow-fault'));
	assert.equal(c.env.COMPOSE_FAULT, 'write');
	const p = world(t, { production: true });
	assert.equal(await exit(() => build(p.ctx(), { composeFault: 'write' })), EXIT.ROOT);
	assert.deepEqual(p.labels(), []);
	const plain = world(t);
	await build(plain.ctx(), {});
	assert.ok(!plain.calls.find((k) => k.label === 'compose-apply').argv.includes('--allow-fault'));
});

// ------------------------------------------------------------------ activate

const built = async (w, over) => {
	const ctx = w.ctx(over);
	await build(ctx, {});
	return ctx;
};

test('activate (non-production): retention, carry-over, renames, local start, smoke; the previous tree is kept; no pm2, no purge', async (t) => {
	const w = world(t);
	const ctx = await built(w);
	// a build that changed the retention marker: activation reinstates the snapshot taken when the build started
	writeFileSync(path.join(w.root, '.deploy-backups/store-assets-active.json'), '{"active":["changed-by-build"]}\n');
	const before = w.labels().length;
	await activate(ctx, NP);
	assert.deepEqual(w.labels().slice(before), ['retain-save', 'retain-restore']);
	assert.equal(readFileSync(path.join(w.root, '.deploy-backups/store-assets-active.json'), 'utf8'), '{"active":["a"]}\n');
	assert.equal(entryOf(w, w.live), 'entry-v2-store.next');
	assert.equal(entryOf(w, w.prev), 'entry-v1');
	assert.equal(w.exists(w.next), false);
	assert.equal(w.exists(path.join(w.live, 'server/old-chunk.js')), true, 'a live-only server chunk is carried into the new tree');
	assert.equal(w.exists(w.failedTree), false);
	// the helper of the live tree saved before the swap, run from the live tree
	assert.equal(w.calls.find((c) => c.label === 'retain-save').cwd, w.live);
	assert.equal(w.calls.find((c) => c.label === 'retain-restore').cwd, w.next);
	// started on its own loopback port from the swapped tree, smoked, stopped
	assert.equal(w.started.length, 1);
	assert.equal(w.started[0].cwd, w.live);
	assert.equal(w.started[0].env.PORT, '4555');
	assert.equal(w.started[0].env.HOST, '127.0.0.1');
	assert.equal(w.stopped, 1);
	assert.equal(w.smokeCalls[0].base, 'http://127.0.0.1:4555');
	assert.equal(w.smokeCalls[0].opts.host, 'example.invalid');
	assert.equal(w.smokeCalls[0].liveEntry, 'entry-v2-store.next', 'the smoke ran against the new tree');
	noRuntimeCalls(w);
	const s = w.readState();
	assert.equal(s.state, 'active');
	assert.equal(s.prev.source, 'legacy', 'at cutover the previous tree is the legacy tree');
	assert.equal(s.live.source, `compose:${HISTORY_ID(1)}`);
	assert.deepEqual(s.activations.map((a) => [a.historyId, a.smoke, a.kind]), [[HISTORY_ID(1), 'passed', 'activate']]);
	assert.deepEqual(s.swap, []);
});

test('activate: requires state built (6), the artifacts (7) and a clean idle state (5)', async (t) => {
	const w = world(t);
	assert.equal(await exit(() => activate(w.ctx(), NP)), EXIT.PRECOND, 'no state file');
	const ctx = await built(w);
	rmSync(path.join(w.next, 'dist/q-manifest.json'));
	const before = snapshot(w.live);
	assert.equal(await exit(() => activate(ctx, NP)), EXIT.ARTIFACT);
	assert.ok(equalSnapshots(before, snapshot(w.live)));
	assert.equal(w.readState().state, 'built');
	assert.equal(w.started.length, 0);
	// build-config.json changed after the build
	const x = world(t);
	const cx = await built(x);
	writeFileSync(path.join(x.next, 'build-config.json'), '{"tampered":1}');
	assert.equal(await exit(() => activate(cx, NP)), EXIT.ARTIFACT);
	// a state that is not built
	const y = world(t);
	const cy = await built(y);
	await activate(cy, NP);
	assert.equal(await exit(() => activate(cy, NP)), EXIT.PRECOND, 'already active');
});

test('activate: same-name server files with different content refuse the activation (7) and swap nothing', async (t) => {
	const w = world(t);
	w.serverCollision = true;
	const ctx = await built(w);
	const before = snapshot(w.live);
	const err = await activate(ctx, NP).catch((e) => e);
	assert.equal(err.exit, EXIT.ARTIFACT);
	assert.match(err.message, /shared\.js/);
	assert.ok(equalSnapshots(before, snapshot(w.live)));
	assert.equal(w.exists(w.next), true);
	assert.equal(w.readState().state, 'built');
});

test('C6: a failed origin smoke is exit 8, state smoke-failed, no purge, no activation recorded; deploy stops there', async (t) => {
	const w = world(t, { production: true });
	w.smokeOk = false;
	const ctx = w.ctx();
	const code = await exit(() => deploy(ctx, {}));
	assert.equal(code, EXIT.SMOKE);
	assert.equal(w.readState().state, 'smoke-failed');
	assert.deepEqual(w.readState().activations, []);
	assert.equal(w.called('fake-purge'), false);
	assert.equal(await exit(() => purge(ctx, {})), EXIT.PRECOND, 'purge refuses without a passed smoke');
	assert.equal(w.called('fake-purge'), false);
	assert.equal(entryOf(w, w.live), 'entry-v2-store.next', 'the new tree is live; the operator restores the previous one');
	assert.equal(entryOf(w, w.prev), 'entry-v1');
});

test('C6: production order is build, activate (restart, readiness, smoke), then purge, and the purge follows the smoke', async (t) => {
	const w = world(t, { production: true });
	await deploy(w.ctx(), {});
	assert.deepEqual(w.labels(), ['env', 'compose-apply', 'compose-check', 'install', 'build', 'compose-mark', 'retain-save', 'retain-restore', 'fake-purge']);
	assert.equal(w.started.length, 1);
	assert.equal(w.started[0].prod, true);
	assert.equal(w.smokeCalls.length, 1);
	assert.equal(w.smokesBeforePurge, 1, 'the smoke had passed before the purge ran');
	assert.equal(w.smokeCalls[0].base, 'http://127.0.0.1:4999');
	assert.equal(w.readState().state, 'purged');
	assert.equal(w.readState().live.lastState, 'purged');
});

test('activate: a failed restart is activate-failed (1), no smoke and no purge; a failed readiness likewise', async (t) => {
	const w = world(t, { production: true });
	w.restartOk = false;
	const ctx = await built(w);
	assert.equal(await exit(() => activate(ctx, {})), EXIT.FAIL);
	assert.equal(w.readState().state, 'activate-failed');
	assert.equal(w.smokeCalls.length, 0);
	assert.equal(w.called('fake-purge'), false);
	// injected faults on a non-production root
	const x = world(t);
	const cx = await built(x);
	assert.equal(await exit(() => activate(cx, { ...NP, fault: 'restart' })), EXIT.FAIL);
	assert.equal(x.readState().state, 'activate-failed');
	assert.equal(x.started.length, 0, 'the injected restart failure calls nothing');
	const y = world(t);
	const cy = await built(y);
	assert.equal(await exit(() => activate(cy, { ...NP, fault: 'smoke' })), EXIT.SMOKE);
	assert.equal(y.readState().state, 'smoke-failed');
	assert.equal(y.smokeCalls.length, 0, 'the injected smoke failure calls nothing');
	assert.equal(y.stopped, 1, 'the local process is stopped even when the smoke fails');
	const z = world(t);
	const cz = await built(z);
	assert.equal(await exit(() => activate(cz, { ...NP, fault: 'bogus' })), EXIT.USAGE);
});

// ------------------------------------------------------------------ C1: the root rule

test('C1: a non-production root refuses restart, pm2 and purge (exit 3) and changes nothing', async (t) => {
	const w = world(t);
	const ctx = await built(w);
	const before = snapshot(w.root);
	const calls = w.calls.length;
	assert.equal(await exit(() => activate(ctx, {})), EXIT.ROOT, 'no --no-restart');
	assert.equal(await exit(() => activate(ctx, { noRestart: true })), EXIT.ROOT, 'no --smoke-port');
	assert.equal(await exit(() => activate(ctx, { smokePort: 4555 })), EXIT.ROOT);
	assert.equal(await exit(() => purge(ctx, {})), EXIT.ROOT);
	assert.equal(await exit(() => restorePreviousCommand(ctx, {})), EXIT.ROOT);
	assert.ok(equalSnapshots(before, snapshot(w.root)));
	assert.equal(w.calls.length, calls);
	noRuntimeCalls(w);
});

test('C1: the production root refuses --no-restart, --smoke-port and --fault (exit 3)', async (t) => {
	const w = world(t, { production: true });
	const ctx = await built(w);
	const before = snapshot(w.root);
	for (const o of [{ noRestart: true }, { smokePort: 4555 }, { fault: 'smoke' }, { fault: 'restart' }]) assert.equal(await exit(() => activate(ctx, o)), EXIT.ROOT, JSON.stringify(o));
	assert.equal(await exit(() => purge(ctx, { fault: 'purge' })), EXIT.ROOT);
	assert.equal(await exit(() => restorePreviousCommand(ctx, { noRestart: true })), EXIT.ROOT);
	assert.ok(equalSnapshots(before, snapshot(w.root)));
	assert.equal(w.started.length, 0);
});

test('C1: on a non-production root the purge only exists as an injected failure that calls nothing', async (t) => {
	const w = world(t);
	const ctx = await built(w);
	await activate(ctx, NP);
	const err = await purge(ctx, { fault: 'purge' }).catch((e) => e);
	assert.equal(err.exit, EXIT.PURGE);
	assert.equal(w.readState().state, 'purge-failed');
	assert.equal(w.readState().activations.length, 1, 'a purge failure never changes the activation list');
	assert.equal(w.called('fake-purge'), false);
	noRuntimeCalls(w);
	// non-production deploy: build and activate run, the purge is refused (3), never called
	const x = world(t);
	assert.equal(await exit(() => deploy(x.ctx(), NP)), EXIT.ROOT);
	assert.equal(x.readState().state, 'active');
	assert.equal(x.called('fake-purge'), false);
});

// ------------------------------------------------------------------ purge

test('purge: production only; failure is exit 9 and purge-failed, rerunnable, and leaves the activation list alone', async (t) => {
	const w = world(t, { production: true });
	const ctx = await built(w);
	assert.equal(await exit(() => purge(ctx, {})), EXIT.PRECOND, 'not active yet');
	await activate(ctx, {});
	w.fail['fake-purge'] = 1;
	assert.equal(await exit(() => purge(ctx, {})), EXIT.PURGE);
	assert.equal(w.readState().state, 'purge-failed');
	assert.equal(w.readState().activations.length, 1);
	w.fail = {};
	await purge(ctx, {});
	assert.equal(w.readState().state, 'purged');
	await purge(ctx, {});
	assert.equal(w.readState().state, 'purged', 'rerunnable');
	assert.equal(w.readState().activations.length, 1);
});

// ------------------------------------------------------------------ restore previous (C2)

test('restore-previous: swap back with no install, build or compose; then the purge is its own step', async (t) => {
	const w = world(t);
	const ctx = await built(w);
	await activate(ctx, NP);
	const labelsBefore = w.labels().length;
	await restorePreviousCommand(ctx, NP);
	assert.deepEqual(w.labels().slice(labelsBefore), [], 'no command ran: no install, no build, no compose');
	assert.equal(entryOf(w, w.live), 'entry-v1');
	assert.equal(entryOf(w, w.failedTree), 'entry-v2-store.next');
	assert.equal(w.exists(w.prev), false);
	assert.equal(w.smokeCalls.length, 2, 'restart-equivalent and smoke as in activate');
	const s = w.readState();
	assert.equal(s.state, 'restored-previous');
	assert.equal(s.prev, null);
	assert.equal(s.failed.stageId.length > 0, true);
	assert.equal(s.activations.at(-1).kind, 'restore');
	// nothing left to restore
	assert.equal(await exit(() => restorePreviousCommand(ctx, NP)), EXIT.PRECOND);
});

test('restore-previous: production restores, restarts, smokes and then purges as a separate command', async (t) => {
	const w = world(t, { production: true });
	const ctx = await built(w);
	await activate(ctx, {});
	await restorePreviousCommand(ctx, {});
	assert.equal(entryOf(w, w.live), 'entry-v1');
	assert.equal(w.called('fake-purge'), false);
	await purge(ctx, {});
	assert.equal(w.called('fake-purge'), true);
	assert.equal(w.smokesBeforePurge, 2);
});

test('restore-previous: a previous tree that fails its artifact check is exit 7 and nothing moves; a missing prev is exit 6; the smoke can fail', async (t) => {
	const w = world(t);
	const ctx = await built(w);
	await activate(ctx, NP);
	rmSync(path.join(w.prev, 'server/entry.express.js'));
	const before = snapshot(w.root);
	assert.equal(await exit(() => restorePreviousCommand(ctx, NP)), EXIT.ARTIFACT);
	assert.ok(equalSnapshots(before, snapshot(w.root)));
	const fresh = world(t);
	assert.equal(await exit(() => restorePreviousCommand(fresh.ctx(), NP)), EXIT.PRECOND);
	const s = world(t);
	const cs = await built(s);
	await activate(cs, NP);
	s.smokeOk = false;
	assert.equal(await exit(() => restorePreviousCommand(cs, NP)), EXIT.SMOKE);
	assert.equal(s.readState().state, 'smoke-failed');
	assert.equal(entryOf(s, s.live), 'entry-v1');
});

// ------------------------------------------------------------------ recover, locks, interruptions (C3-style state handling)

test('a killed build leaves `building`: every command refuses (5) until recover marks it build-failed; the stage is kept', async (t) => {
	const w = world(t);
	w.crash.build = true;
	await assert.rejects(build(w.ctx(), {}), InjectedCrash);
	assert.equal(w.readState().state, 'building');
	w.crash = {};
	for (const fn of [() => build(w.ctx(), {}), () => activate(w.ctx(), NP), () => purge(w.ctx(), PURGE_FAULT), () => restorePreviousCommand(w.ctx(), NP)]) assert.equal(await exit(fn), EXIT.RECOVER);
	const r = await recover(w.ctx());
	assert.equal(r.action, 'build-failed');
	assert.equal(w.readState().state, 'build-failed');
	assert.equal(w.exists(w.next), true, 'kept for inspection');
	await build(w.ctx(), {});
	assert.equal(w.readState().state, 'built');
});

test('a kill between the swap renames: activation refuses (5), recover reverses the renames and the stage is built again', async (t) => {
	const w = world(t);
	const ctx = await built(w);
	await assert.rejects(activate(ctx, { ...NP, fault: 'swap-mid' }), InjectedCrash);
	const s = w.readState();
	assert.equal(s.state, 'activating');
	assert.ok(s.swap.some((o) => o.op === 'live-to-prev' && o.status === 'done'), 'recorded');
	assert.equal(w.exists(w.live), false, 'half swapped');
	for (const fn of [() => build(ctx, {}), () => activate(ctx, NP), () => purge(ctx, PURGE_FAULT)]) assert.equal(await exit(fn), EXIT.RECOVER);
	const r = await recover(ctx);
	assert.equal(r.action, 'swap-undone');
	assert.equal(entryOf(w, w.live), 'entry-v1');
	assert.equal(w.exists(w.next), true);
	assert.equal(w.exists(w.prev), false);
	assert.equal(w.readState().state, 'built');
	assert.deepEqual(w.readState().swap, []);
	noRuntimeCalls(w);
	await activate(ctx, NP);
	assert.equal(w.readState().state, 'active');
});

test('a kill after the last rename: recover completes the swap, marks activate-failed and records the new live and prev', async (t) => {
	const w = world(t);
	const ctx = await built(w);
	w.crashOnStart = true;
	await assert.rejects(activate(ctx, NP), InjectedCrash);
	assert.equal(w.readState().state, 'activating');
	const r = await recover(ctx);
	assert.equal(r.action, 'swap-completed');
	assert.equal(w.readState().state, 'activate-failed');
	assert.equal(entryOf(w, w.live), 'entry-v2-store.next');
	assert.equal(w.readState().prev.source, 'legacy');
	w.crashOnStart = false;
	await restorePreviousCommand(ctx, NP);
	assert.equal(entryOf(w, w.live), 'entry-v1');
	assert.deepEqual(await recover(ctx), { action: 'nothing' }, 'recover is idempotent');
});

test('a compose journal or a held lock refuses every command with exit 5', async (t) => {
	const w = world(t);
	mkdirSync(path.join(w.root, '.compose-journal/20261011T000000Z-1'), { recursive: true });
	for (const fn of [() => build(w.ctx(), {}), () => activate(w.ctx(), NP), () => purge(w.ctx(), PURGE_FAULT)]) assert.equal(await exit(fn), EXIT.RECOVER);
	assert.deepEqual(w.labels(), []);
	rmSync(path.join(w.root, '.compose-journal'), { recursive: true });
	// a half-begun journal (.tmp) is not a journal
	mkdirSync(path.join(w.root, '.compose-journal/20261011T000000Z-1.tmp'), { recursive: true });
	await build(w.ctx(), {});

	// a real holder in another process: refused while it lives, free the moment it dies, however it dies
	const x = world(t);
	const holder = await holdLockInChild(x, t);
	assert.equal(await exit(() => build(x.ctx(), {})), EXIT.RECOVER);
	assert.deepEqual(x.labels(), []);
	holder.kill('SIGKILL');
	await new Promise((r) => holder.on('exit', r));
	await build(x.ctx(), {});
	assert.equal(x.exists(path.join(x.root, '.deploy-state/lock')), false, 'the lock is released');
});

// ------------------------------------------------------------------ CLI

test('CLI: usage, config errors and exit codes; a crash is 137', async (t) => {
	const w = world(t);
	const out = { log: () => {}, error: () => {} };
	const cfg = w.config();
	assert.equal(await runCli([], { deps: w.deps, out }), EXIT.USAGE);
	assert.equal(await runCli(['--config', cfg, 'frobnicate'], { deps: w.deps, out }), EXIT.USAGE);
	assert.equal(await runCli(['--config', path.join(w.base, 'missing.json'), 'build'], { deps: w.deps, out }), EXIT.USAGE);
	assert.equal(await runCli(['--config', cfg, 'activate', '--no-restart', '--smoke-port', 'abc'], { deps: w.deps, out }), EXIT.USAGE);
	assert.equal(await runCli(['--config', cfg, 'activate', '--no-restart', '--smoke-port', '4555'], { deps: w.deps, out }), EXIT.PRECOND, 'no built stage yet');
	assert.equal(await runCli(['--config', cfg, 'build'], { deps: w.deps, out }), 0);
	assert.equal(await runCli(['--config', cfg, 'activate'], { deps: w.deps, out }), EXIT.ROOT);
	assert.equal(await runCli(['--config', cfg, 'activate', '--no-restart', '--smoke-port', '4555'], { deps: w.deps, out }), 0);
	assert.equal(await runCli(['--config', cfg, 'recover'], { deps: w.deps, out }), 0);
	const c = world(t);
	c.crash.build = true;
	assert.equal(await runCli(['--config', c.config(), 'build'], { deps: c.deps, out }), 137);
	const bad = world(t);
	assert.equal(await runCli(['--config', bad.config({ productionRoot: 'relative' }), 'build'], { deps: bad.deps, out }), EXIT.USAGE);
	const noCompose = world(t);
	assert.equal(await runCli(['--config', noCompose.config({ compose: [] }), 'build'], { deps: noCompose.deps, out }), EXIT.USAGE);
});

test('the tools carry no brand name, brand path or URL (generic product code)', () => {
	const here = path.dirname(new URL(import.meta.url).pathname);
	for (const f of ['lib.mjs', 'entry.mjs', 'rollback.mjs', 'stage.mjs', 'origin-smoke.mjs', 'preflight-env.mjs', 'build-guard.mjs']) {
		const src = readFileSync(path.join(here, f), 'utf8');
		assert.ok(!/\b(rotten|rottenhand|damned|stunning|toxic|hetzner)\b/i.test(src), `${f}: no brand name`);
		assert.ok(!/\/home\/|https?:\/\/(?!127\.0\.0\.1)/.test(src.replace(/\/\/.*$/gm, '')), `${f}: no brand path or external URL`);
		assert.ok(!/\bnode -e\b|--eval/.test(src.replace(/\/\/.*$/gm, '')), `${f}: no node -e`);
	}
});

// ------------------------------------------------------------------ review round 1

test('review 1: --pull never merges a commit that changes live paths, tracked or not; the live tree is never rewritten', async (t) => {
	const incomings = [
		{ 'store/package.json': '{"name":"pulled-into-live"}\n' },
		// the live tree is untracked and ignored in the checkout, and the incoming commit introduces paths into it (round 2)
		{ 'store/scripts/new-runtime.sh': 'evil\n', 'README.md': 'docs\n' },
		{ 'store.prev/x': 'x' },
		{ '.deploy-state/storefront.json': '{}' },
	];
	for (const incoming of incomings) {
		const w = world(t);
		w.incoming = incoming;
		const before = snapshot(w.live);
		assert.equal(await exit(() => build(w.ctx({ branch: 'main' }), { pull: true })), EXIT.PRECOND);
		assert.deepEqual(w.merged, [], 'nothing was merged');
		assert.ok(w.called('git:fetch'));
		assert.ok(equalSnapshots(before, snapshot(w.live)));
		assert.equal(w.exists(w.next), false);
		assert.equal(w.exists(w.state), false);
	}
	// an incoming commit outside the live paths is merged, to exactly the inspected commit
	const x = world(t);
	x.incoming = { 'README.md': 'docs\n', 'storefront/brand.json': '{}\n' };
	await build(x.ctx({ branch: 'main' }), { pull: true });
	assert.deepEqual(x.merged, [x.incomingSha]);
	assert.equal(x.labels().indexOf('git:fetch') < x.labels().indexOf('git:merge'), true, 'fetch first, merge after the inspection');
});

test('review 2: the candidate runs from the stage on an isolated port and passes its smoke before any live rename', async (t) => {
	const w = world(t);
	const ctx = await built(w);
	await activate(ctx, NP);
	assert.equal(w.candidateStarted.length, 1);
	assert.equal(w.candidateStarted[0].cwd, w.next, 'started from the stage');
	assert.equal(w.candidateStarted[0].env.PORT, String(w.candidatePort));
	assert.notEqual(w.candidatePort, NP.smokePort, 'not the port the live tree is smoked on');
	assert.equal(w.candidateSmokeCalls.length, 1);
	assert.equal(w.candidateSmokeCalls[0].entry, 'entry-v2-store.next', 'the candidate under test is the stage');
	assert.equal(w.candidateSmokeCalls[0].liveEntry, 'entry-v1', 'the live tree was still the old release when the candidate was smoked');
	assert.equal(w.candidateStopped, 1);
	assert.equal(w.smokeCalls.length, 1, 'the post-swap smoke is a separate check');
	assert.equal(w.smokeCalls[0].liveEntry, 'entry-v2-store.next');
});

test('review 2: a candidate that fails its smoke never replaces the live tree (exit 8, nothing renamed, nothing restarted)', async (t) => {
	for (const production of [false, true]) {
		const w = world(t, { production });
		const ctx = await built(w);
		w.candidateSmokeOk = false;
		const before = snapshot(w.live);
		const flags = production ? {} : NP;
		assert.equal(await exit(() => activate(ctx, flags)), EXIT.SMOKE);
		assert.ok(equalSnapshots(before, snapshot(w.live)), 'live byte for byte');
		assert.equal(w.exists(w.prev), false, 'no rename happened');
		assert.equal(w.exists(w.next), true, 'the stage is kept for inspection');
		assert.equal(w.readState().state, 'build-failed');
		assert.equal(w.started.length, 0, 'no live start or restart');
		assert.equal(w.smokeCalls.length, 0);
		assert.equal(w.candidateStopped, 1, 'the candidate process is stopped');
		assert.equal(w.called('fake-purge'), false);
	}
});

test('review 2: a candidate whose process dies is the same refusal; production deploy stops before the restart', async (t) => {
	const w = world(t, { production: true });
	w.childDead = true;
	const before = snapshot(w.live);
	assert.equal(await exit(() => deploy(w.ctx(), {})), EXIT.SMOKE);
	assert.ok(equalSnapshots(before, snapshot(w.live)));
	assert.equal(w.started.length, 0);
	assert.equal(w.called('fake-purge'), false);
});

test('review 7: a crash while seeding leaves a recorded building state; recover frees the partial stage for the next build', async (t) => {
	const w = world(t);
	w.afterSeedCopy = (rel, n) => {
		if (n === 2) throw new InjectedCrash('seed');
	};
	const before = snapshot(w.live);
	await assert.rejects(build(w.ctx(), {}), InjectedCrash);
	assert.equal(w.readState().state, 'building', 'ownership was recorded before the first stage write');
	assert.equal(w.exists(w.next), true, 'a partial stage exists');
	w.afterSeedCopy = undefined;
	assert.equal(await exit(() => build(w.ctx(), {})), EXIT.RECOVER);
	assert.equal((await recover(w.ctx())).action, 'build-failed');
	await build(w.ctx(), {});
	assert.equal(w.readState().state, 'built');
	assert.ok(equalSnapshots(before, snapshot(w.live)));
});

test('review 7: a failing seed (not a kill) takes the build-failed transition and the next build replaces the partial stage', async (t) => {
	const w = world(t);
	w.afterSeedCopy = (rel, n) => {
		if (n === 2) throw new Error('disk full');
	};
	assert.equal(await exit(() => build(w.ctx(), {})), EXIT.FAIL);
	assert.equal(w.readState().state, 'build-failed');
	assert.equal(w.exists(w.next), true);
	w.afterSeedCopy = undefined;
	await build(w.ctx(), {});
	assert.equal(w.readState().state, 'built');
});

test('review 8: startLocal refuses a port something already listens on (a real competing listener)', async (t) => {
	const srv = net.createServer();
	await new Promise((r) => srv.listen(0, '127.0.0.1', r));
	t.after(() => srv.close());
	const { port } = srv.address();
	const err = await defaultDeps().startLocal({ cwd: tmpdir(), port, env: { PATH: process.env.PATH } }).catch((e) => e);
	assert.ok(err instanceof DeployError, 'refused');
	assert.match(err.message, /already in use/);
});

test('review 8: readiness is never reported for a process that is gone, even while something answers on the port', async () => {
	const d = defaultDeps();
	d.get = async () => ({ status: 200 });
	d.sleep = async () => {};
	assert.equal(await d.waitReady('http://127.0.0.1:1/', { timeoutMs: 50, alive: () => false }), false, 'dead from the start');
	let calls = 0;
	assert.equal(await d.waitReady('http://127.0.0.1:1/', { timeoutMs: 50, alive: () => ++calls < 2 }), false, 'died while answering');
	assert.equal(await d.waitReady('http://127.0.0.1:1/', { timeoutMs: 50, alive: () => true }), true);
	assert.equal(await d.waitReady('http://127.0.0.1:1/', { timeoutMs: 50 }), true);
});

test('review 8: a local child that dies during the smoke fails the activation even though the smoke passed', async (t) => {
	const w = world(t);
	const ctx = await built(w);
	w.childDead = true;
	assert.equal(await exit(() => activate(ctx, NP)), EXIT.SMOKE, 'the candidate is refused (its process exited)');
	assert.equal(w.exists(w.prev), false, 'no swap');
});

test('review 6: deploy holds the one lock across build, activate and purge; a rival is refused at every boundary', async (t) => {
	const w = world(t, { production: true });
	const rival = w.ctx();
	const seen = {};
	w.onCheckpoint = async (name) => {
		const stateBefore = readFileSync(w.state, 'utf8');
		seen[name] = await exit(() => build(rival, {}));
		assert.equal(readFileSync(w.state, 'utf8'), stateBefore, 'the rival changed nothing');
	};
	await deploy(w.ctx(), {});
	assert.deepEqual(seen, { 'deploy:after-build': EXIT.RECOVER, 'deploy:after-activate': EXIT.RECOVER });
	assert.equal(w.readState().state, 'purged');
	await build(rival, {});
	assert.equal(w.readState().state, 'built', 'the lock was released at the end');
});

test('review 12: the build exports reach the build, which refuses a differing value at its own boundary', async (t) => {
	const w = world(t);
	w.exports = { SOME_API_BASE: 'http://api.example.invalid', OTHER_PATH: '/catalog' };
	await build(w.ctx(), {});
	const call = w.calls.find((c) => c.label === 'build');
	assert.equal(call.env.SOME_API_BASE, 'http://api.example.invalid');
	assert.equal(call.env.OTHER_PATH, '/catalog');
	assert.equal(w.readState().state, 'built', 'the guard in the build accepted the recorded exports');
	// values on disk that do not hash to the recorded exportsHash: refused before the build runs
	const x = world(t);
	x.exports = { SOME_API_BASE: 'http://api.example.invalid' };
	x.exportsTamper = true;
	assert.equal(await exit(() => build(x.ctx(), {})), EXIT.ARTIFACT);
	assert.equal(x.called('build'), false);
	assert.equal(x.readState().state, 'build-failed');
	// a name that would shadow one the entry owns
	const y = world(t);
	y.exports = { PATH: '/evil' };
	assert.equal(await exit(() => build(y.ctx(), {})), EXIT.ARTIFACT);
	assert.equal(y.called('build'), false);
});


// ------------------------------------------------------------------ review round 2

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
	const end = Date.now() + ms;
	for (;;) {
		if (await fn()) return true;
		if (Date.now() > end) return false;
		await sleepMs(25);
	}
}

test('review 2.1: a killed entry keeps the lock while its build child is still writing; recover is refused until the child exits', async (t) => {
	const w = world(t);
	const out = path.join(w.base, 'writer.out');
	const ready = path.join(w.base, 'writer.ready');
	const stop = path.join(w.base, 'writer.stop');
	// the entry process: holds the real lock, records `building`, then runs a real long-running child through the real runner and blocks on it
	const script = path.join(w.base, 'killed-entry.mjs');
	writeFileSync(
		script,
		`import { loadConfig, newState, underLock, writeState } from ${JSON.stringify(new URL('./lib.mjs', import.meta.url).href)};
import { makeContext } from ${JSON.stringify(new URL('./entry.mjs', import.meta.url).href)};
const ctx = makeContext(loadConfig(${JSON.stringify(w.config())}));
await underLock(ctx, async () => {
	writeState(ctx.paths, newState({ stageId: 'stage-1', state: 'building' }));
	ctx.run('build', ['bash', '-c', 'touch "$1"; while [ ! -f "$2" ]; do date +%s%N >> "$3"; sleep 0.05; done', 'writer', ${JSON.stringify(ready)}, ${JSON.stringify(stop)}, ${JSON.stringify(out)}]);
});
`,
	);
	const child = spawn(process.execPath, [script], { stdio: 'ignore' });
	t.after(() => {
		try {
			writeFileSync(stop, '');
		} catch {
			/* the scratch directory is already gone */
		}
		child.kill('SIGKILL');
	});
	assert.ok(await until(() => w.exists(ready)), 'the build child started');
	child.kill('SIGKILL');
	await new Promise((r) => child.on('exit', r));
	// the entry is dead but its build child keeps writing
	const size = () => readFileSync(out, 'utf8').length;
	const s1 = size();
	await sleepMs(250);
	assert.ok(size() > s1, 'the writer outlived the killed entry');
	const ctx = w.ctx();
	// the lock is still held by the tree: no rival entry and no recover can reach the stage while it writes
	await assert.rejects(takeLock(pathsFor(ctx.cfg)), (e) => e instanceof DeployError && e.exit === EXIT.RECOVER);
	assert.equal(await exit(() => recover(ctx)), EXIT.RECOVER);
	assert.equal(await exit(() => build(ctx, {})), EXIT.RECOVER);
	assert.equal(w.readState().state, 'building', 'the state was not touched while a writer runs');
	// once the writer is gone the lock is free and recover proceeds
	writeFileSync(stop, '');
	assert.ok(await until(async () => (await exit(() => recover(ctx))) === 0), 'recover succeeds after the writer exits');
	assert.equal(w.readState().state, 'build-failed');
});

test('review 2.5: activation with a symlinked stage root stops before retention, carry-over or any rename', async (t) => {
	const w = world(t);
	const ctx = await built(w);
	const marker = path.join(w.root, '.deploy-backups/store-assets-active.json');
	const real = path.join(w.root, 'real-stage');
	renameSync(w.next, real);
	symlinkSync(real, w.next);
	const markerBefore = readFileSync(marker, 'utf8');
	const stageBefore = snapshot(real);
	const liveBefore = snapshot(w.live);
	assert.equal(await exit(() => activate(ctx, NP)), EXIT.ARTIFACT);
	assert.equal(w.called('retain-save'), false, 'no retention side effect ran');
	assert.equal(w.called('retain-restore'), false);
	assert.equal(readFileSync(marker, 'utf8'), markerBefore);
	assert.ok(equalSnapshots(stageBefore, snapshot(real)), 'carry-over wrote nothing into the link target');
	assert.ok(equalSnapshots(liveBefore, snapshot(w.live)));
	assert.equal(w.readState().state, 'built');
	// the previous tree as a symlink is refused the same way
	const x = world(t);
	const cx = await built(x);
	await activate(cx, NP);
	const realPrev = path.join(x.root, 'real-prev');
	renameSync(x.prev, realPrev);
	symlinkSync(realPrev, x.prev);
	assert.equal(await exit(() => restorePreviousCommand(cx, NP)), EXIT.ARTIFACT);
	assert.equal(entryOf(x, x.live), 'entry-v2-store.next');
});

test('review 2.4: the retention marker follows the live release: abandoned builds, a reversed swap and a restore of the previous tree all put the right one back', async (t) => {
	const marker = (w) => path.join(w.root, '.deploy-backups/store-assets-active.json');
	const original = '{"active":["a"]}\n';
	// a composed build that rewrites the marker and then fails, or is killed, leaves the live marker as it was
	const a = world(t);
	a.buildChangesMarker = true;
	a.skipArtifact = 'dist';
	assert.equal(await exit(() => build(a.ctx(), {})), EXIT.ARTIFACT);
	assert.equal(readFileSync(marker(a), 'utf8'), original, 'a failed build restores it');
	a.skipArtifact = null;
	a.crashAfter.build = true;
	await assert.rejects(build(a.ctx(), {}), InjectedCrash);
	assert.notEqual(readFileSync(marker(a), 'utf8'), original);
	await recover(a.ctx());
	assert.equal(readFileSync(marker(a), 'utf8'), original, 'a killed build, once recovered, too');
	// the retry snapshots the live release again, not the leftover: a marker changed in between does not become "live"
	a.crashAfter = {};
	a.write(marker(a), '{"active":["leftover"]}\n');
	const ca = a.ctx();
	await build(ca, {});
	await activate(ca, NP);
	assert.deepEqual(a.retainSaw, [original]);
	// a reversed swap puts the marker back (the stage's retention restore had rewritten it)
	const b = world(t);
	b.retainRestoreWritesMarker = true;
	const cb = await built(b);
	await assert.rejects(activate(cb, { ...NP, fault: 'swap-mid' }), InjectedCrash);
	assert.equal(readFileSync(marker(b), 'utf8'), '{"active":["written-by-stage-restore"]}\n');
	assert.equal((await recover(cb)).action, 'swap-undone');
	assert.equal(readFileSync(marker(b), 'utf8'), original, 'the live release is back, and so is its marker');
	// a restore of the previous tree brings back the previous release's marker, not the displaced one's
	const c = world(t);
	c.retainRestoreWritesMarker = true;
	c.buildChangesMarker = true;
	const cc = await built(c);
	await activate(cc, NP);
	assert.equal(readFileSync(marker(c), 'utf8'), '{"active":["written-by-stage-restore"]}\n', 'the new release\'s marker after activation');
	await restorePreviousCommand(cc, NP);
	assert.equal(entryOf(c, c.live), 'entry-v1');
	assert.equal(readFileSync(marker(c), 'utf8'), original, 'the previous release\'s marker');
});

test('review 2.1: stopping the local process waits until it has exited (SIGKILL after the timeout), so nothing writes into the tree being renamed', async (t) => {
	const dir = path.join(tmpdir(), `stop-test-${process.pid}-${Date.now()}`);
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(path.join(dir, 'server'), { recursive: true });
	const out = path.join(dir, 'written');
	// a server that keeps writing for a while after SIGTERM, and one that ignores SIGTERM altogether
	const body = (term) => `import { appendFileSync } from 'node:fs';\nsetInterval(() => appendFileSync(${JSON.stringify(out)}, 'x'), 10);\nprocess.on('SIGTERM', () => { ${term} });\n`;
	const startLocal = defaultDeps().startLocal;
	for (const [name, term, timeout] of [['slow exit', 'setTimeout(() => process.exit(0), 300)', 5000], ['ignores SIGTERM', '', 250]]) {
		writeFileSync(path.join(dir, 'server/entry.express.js'), body(term));
		writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
		rmSync(out, { force: true });
		const h = await startLocal({ cwd: dir, port: await defaultDeps().freePort(), env: { PATH: process.env.PATH } });
		assert.ok(await until(() => w0(out)), `${name}: the child is writing`);
		await h.stop(timeout);
		assert.equal(h.alive(), false, name);
		const size = readFileSync(out, 'utf8').length;
		await sleepMs(120);
		assert.equal(readFileSync(out, 'utf8').length, size, `${name}: nothing was written after stop() returned`);
	}
});
const w0 = (f) => {
	try {
		return readFileSync(f, 'utf8').length > 0;
	} catch {
		return false;
	}
};
