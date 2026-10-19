// node --test tools/deploy/tools.test.mjs   (cwd: packages/storefront)
// Plan A §4.6a c, d, g: preflight-env (C5), origin-smoke, build-guard (C7), stage (C2).
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkToken, main as guardMain } from './build-guard.mjs';
import { spawn } from 'node:child_process';
import { DeployError, EXIT, InjectedCrash, pathsFor, takeLock } from './lib.mjs';
import { LockHeldError, acquireOsLock } from '../compose/lib/os-lock.mjs';
import { hashJson } from '../compose/lib/util.mjs';
import { httpGet, main as smokeMain, runSmoke } from './origin-smoke.mjs';
import { main as preflightMain, offendingNames } from './preflight-env.mjs';
import { assertNoSymlinkAncestors, assertTreesReal, carryServer, main as stageMain, checkArtifacts, recoverSwap, removeTree, restoreOps, restorePrevious, seed, swap, swapOps } from './stage.mjs';
import { equalSnapshots, sha, snapshot, writeBuilt } from './fixtures/world.mjs';

const tmp = (t) => {
	const d = mkdtempSync(path.join(tmpdir(), 'deploy-tools-'));
	t.after(() => rmSync(d, { recursive: true, force: true }));
	return d;
};
const put = (file, text, mode) => {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, text);
	if (mode) chmodSync(file, mode);
};

// ------------------------------------------------------------------ preflight-env (C5)

test('preflight: each build selector is refused by name, values never printed', () => {
	assert.deepEqual(offendingNames({ PATH: '/bin', HOME: '/h', NODE_ENV: 'production' }), []);
	assert.deepEqual(offendingNames({ NODE_ENV: '' }), []);
	assert.deepEqual(offendingNames({}), []);
	assert.deepEqual(offendingNames({ SELLRIGHT_BUILD_SUFFIX: 'e2e', SELLRIGHT_DISABLE_SSG: '1' }), ['SELLRIGHT_BUILD_SUFFIX', 'SELLRIGHT_DISABLE_SSG']);
	assert.deepEqual(offendingNames({ NODE_ENV: 'development' }), ['NODE_ENV']);
	assert.deepEqual(offendingNames({ NODE_ENV: 'test' }), ['NODE_ENV']);
	assert.deepEqual(offendingNames({ VITE_STORE_NAME: 'x', E2E_PORT: '1', PLAYWRIGHT_BROWSERS_PATH: '/p', Z: '1' }), ['E2E_PORT', 'PLAYWRIGHT_BROWSERS_PATH', 'VITE_STORE_NAME']);
	assert.deepEqual(offendingNames({ SELLRIGHT_BUILD_SUFFIX: '' }), ['SELLRIGHT_BUILD_SUFFIX'], 'set but empty still counts');
	const lines = [];
	assert.equal(preflightMain({ VITE_SECRET_LIKE: 'hunter2', SELLRIGHT_BUILD_SUFFIX: 'demo' }, { error: (m) => lines.push(m) }), 4);
	assert.match(lines.join(), /SELLRIGHT_BUILD_SUFFIX/);
	assert.match(lines.join(), /VITE_SECRET_LIKE/);
	assert.ok(!lines.join().includes('hunter2') && !lines.join().includes('demo'), 'values are never printed');
	assert.equal(preflightMain({ PATH: '/bin' }, { error: () => assert.fail('no output on success') }), 0);
});

// ------------------------------------------------------------------ origin-smoke

async function withServer(handler, fn) {
	const seen = [];
	const server = http.createServer((req, res) => {
		seen.push({ url: req.url, host: req.headers.host });
		handler(req, res);
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	try {
		return await fn(`http://127.0.0.1:${server.address().port}`, seen);
	} finally {
		await new Promise((r) => server.close(r));
	}
}

const site = (req, res) => {
	const html = (code, body, extra = {}) => {
		res.writeHead(code, { 'content-type': 'text/html', ...extra });
		res.end(body);
	};
	if (req.url === '/') return html(200, '<!doctype html><html><body>ok</body></html>');
	if (req.url === '/shop') return html(200, '<html>shop</html>');
	if (req.url === '/broken-html') return html(200, '<div>fragment only</div>');
	if (req.url === '/err') return html(500, '<html>error</html>');
	if (req.url === '/moved') return html(301, '', { location: '/shop' });
	if (req.url === '/data.json') {
		res.writeHead(200, { 'content-type': 'application/json' });
		return res.end('{"a":1}');
	}
	return html(404, '<html>nope</html>');
};

test('origin-smoke: 200 with <html passes, the Host header is the one asked for, and no request follows a redirect', async () => {
	await withServer(site, async (base, seen) => {
		const r = await runSmoke(base, { host: 'shop.example.invalid', paths: ['/', '/shop', '/data.json'] });
		assert.equal(r.ok, true);
		assert.deepEqual(seen.map((s) => s.host), ['shop.example.invalid', 'shop.example.invalid', 'shop.example.invalid']);
	});
});

test('origin-smoke: a non-200, an HTML body without <html, a missing path and an unlisted redirect each fail; a listed redirect passes', async () => {
	await withServer(site, async (base, seen) => {
		const bad = await runSmoke(base, { host: 'h', paths: ['/err', '/broken-html', '/missing', '/moved'] });
		assert.equal(bad.ok, false);
		assert.deepEqual(bad.results.map((x) => x.ok), [false, false, false, false]);
		assert.match(bad.results[1].reason, /lacks <html/);
		const good = await runSmoke(base, { host: 'h', paths: ['/moved'], redirects: [{ path: '/moved', status: 301 }] });
		assert.equal(good.ok, true);
		assert.equal(seen.filter((s) => s.url === '/shop').length, 0, 'the redirect target was not requested');
		const wrong = await runSmoke(base, { host: 'h', paths: ['/'], redirects: [{ path: '/', status: 301 }] });
		assert.equal(wrong.ok, false);
	});
});

test('origin-smoke: a refused connection fails, an empty list never passes, and the CLI maps to exit codes', async () => {
	const dead = await runSmoke('http://127.0.0.1:1', { paths: ['/'] });
	assert.equal(dead.ok, false);
	assert.equal((await runSmoke('http://127.0.0.1:1', { paths: [] })).ok, false);
	const out = { log: () => {}, error: () => {} };
	assert.equal(await smokeMain([], out), 2);
	assert.equal(await smokeMain(['http://127.0.0.1:1', '--bogus'], out), 2);
	await withServer(site, async (base) => {
		assert.equal(await smokeMain([base, '--host', 'h', '--path', '/', '--path', '/shop'], out), 0);
		assert.equal(await smokeMain([base, '--host', 'h', '--path', '/err'], out), 1);
		assert.equal(await smokeMain([base, '--host', 'h', '--redirect', '/moved=301'], out), 0);
	});
});

test('origin-smoke: a continuously active body still exceeds the absolute deadline', async () => {
	let writes = 0;
	let closed = false;
	await withServer((_req, res) => {
		res.writeHead(200, { 'content-type': 'text/html' });
		res.write('<html>');
		const interval = setInterval(() => {
			writes++;
			if (writes === 30) { clearInterval(interval); res.end('</html>'); }
			else res.write('.');
		}, 10);
		res.once('close', () => { closed = true; clearInterval(interval); });
	}, async base => {
		await assert.rejects(httpGet(base, { timeoutMs: 100 }), /timeout after 100 ms/);
		assert.ok(writes > 1, 'body activity occurred well inside the inactivity threshold');
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.equal(closed, true, 'deadline destroys the active response');
	});
});

test('origin-smoke: oversized bodies reject and close instead of returning truncated success', async () => {
	let closed = false;
	await withServer((_req, res) => {
		res.writeHead(200, { 'content-type': 'text/html' });
		res.write('<html>secret-body-must-not-appear-in-errors');
		const end = setTimeout(() => res.end('</html>'), 250);
		res.once('close', () => { closed = true; clearTimeout(end); });
	}, async base => {
		await assert.rejects(httpGet(base, { timeoutMs: 1000, maxBytes: 8 }), { message: 'body exceeds 8 bytes' });
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.equal(closed, true);
	});
});

test('origin-smoke: the header wait is bounded and incomplete responses reject', async () => {
	await withServer((req, res) => {
		if (req.url === '/headers') {
			const end = setTimeout(() => res.end('<html>late</html>'), 250);
			res.once('close', () => clearTimeout(end));
		} else {
			res.writeHead(200, { 'content-type': 'text/html' });
			res.write('<html>');
			setTimeout(() => res.destroy(), 10);
		}
	}, async base => {
		await assert.rejects(httpGet(base + '/headers', { timeoutMs: 50 }), /timeout after 50 ms/);
		await assert.rejects(httpGet(base + '/aborted', { timeoutMs: 1000 }), /aborted|closed/);
	});
});

test('origin-smoke: completion cleans timers/listeners and absorbs late errors on failure', async t => {
	const streams = [];
	const mock = t.mock.method(http, 'request', (_url, _options, onResponse) => {
		const req = new EventEmitter();
		const res = new EventEmitter();
		const state = { req, res, timeouts: [], destroys: 0 };
		streams.push(state);
		const index = streams.length;
		req.setTimeout = (ms, fn) => { state.timeouts.push(ms); if (fn) req.on('timeout', fn); return req; };
		req.destroy = () => {
			state.destroys++;
			req.emit('error', new Error('late socket error'));
			req.emit('close');
			return req;
		};
		res.destroy = () => { res.emit('error', new Error('late response error')); res.emit('close'); return res; };
		req.once('response', onResponse);
		req.end = () => queueMicrotask(() => {
			if (index === 2) { req.emit('error', new Error('network failure')); return; }
			if (index === 3) { req.emit('timeout'); return; }
			res.statusCode = 201;
			res.headers = { 'content-type': 'text/plain', 'x-smoke': 'kept' };
			req.emit('response', res);
			res.emit('data', Buffer.from('complete'));
			res.emit('end');
			res.emit('close');
			req.emit('close');
		});
		return req;
	});
	try {
		assert.deepEqual(await httpGet('http://example.invalid', { timeoutMs: 20 }), {
			status: 201, headers: { 'content-type': 'text/plain', 'x-smoke': 'kept' }, body: 'complete',
		});
		await assert.rejects(httpGet('http://example.invalid', { timeoutMs: 20 }), { message: 'network failure' });
		await assert.rejects(httpGet('http://example.invalid', { timeoutMs: 20 }), { message: 'timeout after 20 ms' });
		assert.equal((await httpGet('http://example.invalid', { timeoutMs: 0 })).body, 'complete');
		await new Promise(resolve => setTimeout(resolve, 40));
		assert.equal(streams[0].destroys, 0, 'completed request has no live deadline');
		assert.equal(streams[1].destroys, 1, 'late error does not destroy twice');
		assert.equal(streams[2].destroys, 1, 'socket inactivity still destroys the request');
		assert.equal(streams[3].destroys, 0, 'explicit zero timeout remains an opt-out');
		for (const { req, res, timeouts } of streams) {
			assert.equal(timeouts.at(-1), 0, 'inactivity timer disabled');
			assert.deepEqual(req.eventNames(), [], 'request listeners removed at close');
			assert.deepEqual(res.eventNames(), [], 'response listeners removed at close');
		}
	} finally { mock.mock.restore(); }
});

// ------------------------------------------------------------------ build-guard (C7)

function guardWorld(t, { state = 'building', stageId = 'S1', dir = 'store.next' } = {}) {
	const root = tmp(t);
	mkdirSync(path.join(root, dir, 'scripts'), { recursive: true });
	put(path.join(root, '.deploy-state/storefront.json'), JSON.stringify({ version: 1, state, stageId }));
	put(path.join(root, dir, 'build-config.json'), JSON.stringify({ exportNames: [], exportsHash: hashJson([]) }));
	return { root, scriptDir: path.join(root, dir, 'scripts') };
}

test('build-guard: passes only with the token of a building stage and the script inside that stage', (t) => {
	const g = guardWorld(t);
	assert.deepEqual(checkToken({ scriptDir: g.scriptDir, env: { SELLRIGHT_DEPLOY_STAGE: 'S1' } }), { ok: true });
	assert.equal(guardMain(['--script-dir', g.scriptDir], { SELLRIGHT_DEPLOY_STAGE: 'S1' }, { error: () => {} }), 0);
});

test('build-guard: a plain `pnpm build` (no token), a wrong token, a state that is not building and a live tree all exit 6 and change nothing', (t) => {
	const g = guardWorld(t);
	const before = snapshot(g.root);
	const quiet = { error: () => {} };
	assert.equal(guardMain(['--script-dir', g.scriptDir], {}, quiet), 6);
	assert.equal(guardMain(['--script-dir', g.scriptDir], { SELLRIGHT_DEPLOY_STAGE: 'other' }, quiet), 6);
	const idle = guardWorld(t, { state: 'built' });
	assert.equal(guardMain(['--script-dir', idle.scriptDir], { SELLRIGHT_DEPLOY_STAGE: 'S1' }, quiet), 6);
	const live = guardWorld(t, { dir: 'store' });
	assert.equal(guardMain(['--script-dir', live.scriptDir], { SELLRIGHT_DEPLOY_STAGE: 'S1' }, quiet), 6, 'the live tree is never a build target');
	const noState = tmp(t);
	mkdirSync(path.join(noState, 'store.next/scripts'), { recursive: true });
	assert.equal(guardMain(['--script-dir', path.join(noState, 'store.next/scripts')], { SELLRIGHT_DEPLOY_STAGE: 'S1' }, quiet), 6);
	assert.equal(guardMain([], { SELLRIGHT_DEPLOY_STAGE: 'S1' }, quiet), 2);
	assert.ok(equalSnapshots(before, snapshot(g.root)), 'nothing was written');
	const msg = [];
	guardMain(['--script-dir', g.scriptDir], {}, { error: (m) => msg.push(m) });
	assert.match(msg[0], /deploy entry/);
});

test('build-guard: it is a self-contained node script (no imports beyond node built-ins)', () => {
	const src = readFileSync(new URL('./build-guard.mjs', import.meta.url), 'utf8');
	for (const m of src.matchAll(/^import .* from '([^']+)';/gm)) assert.match(m[1], /^node:/, `${m[1]} must be a built-in`);
});

// ------------------------------------------------------------------ stage (C2)

function trees(t) {
	const root = tmp(t);
	const p = { root, live: path.join(root, 'store'), next: path.join(root, 'store.next'), prev: path.join(root, 'store.prev'), failed: path.join(root, 'store.failed'), removed: path.join(root, 'store.removed') };
	return p;
}

test('seed copies the live tree\'s non-runtime paths with modes, and nothing else', (t) => {
	const p = trees(t);
	put(path.join(p.live, 'package.json'), '{}');
	put(path.join(p.live, 'src/a.ts'), 'a');
	put(path.join(p.live, 'scripts/run.sh'), '#!/bin/sh', 0o755);
	for (const f of ['node_modules/x/i.js', 'dist/index.html', 'dist-e2e/i.html', 'server/entry.express.js', 'server-e2e/e.js', '.cache/c', 'tmp/t', '.env', '.env.local', '.env.production', 'build-config.json', 'test-results/r']) put(path.join(p.live, f), 'runtime');
	const liveBefore = snapshot(p.live);
	const r = seed({ live: p.live, stage: p.next });
	assert.equal(r.copied, 3);
	assert.deepEqual(readdirSync(p.next).sort(), ['package.json', 'scripts', 'src']);
	assert.equal(statSync(path.join(p.next, 'scripts/run.sh')).mode & 0o777, 0o755);
	assert.ok(equalSnapshots(liveBefore, snapshot(p.live)), 'the live tree is read only');
	assert.throws(() => seed({ live: p.live, stage: p.next }), (e) => e instanceof DeployError && e.exit === EXIT.PRECOND, 'an existing stage is never reused here');
});

test('seed and swap refuse symlinks, in a tree and as a tree', (t) => {
	const p = trees(t);
	put(path.join(p.live, 'src/a.ts'), 'a');
	symlinkSync('/etc/hostname', path.join(p.live, 'src/link'));
	assert.throws(() => seed({ live: p.live, stage: p.next }), (e) => e.exit === EXIT.ARTIFACT && /symlink/.test(e.message));
	assert.equal(existsSync(p.next), false, 'checked before anything was created');
	rmSync(path.join(p.live, 'src/link'));
	const real = path.join(p.root, 'elsewhere');
	mkdirSync(real);
	rmSync(p.live, { recursive: true });
	symlinkSync(real, p.live);
	mkdirSync(p.next);
	assert.throws(() => swap({ p, record: () => {} }), (e) => e.exit === EXIT.ARTIFACT);
	assert.equal(existsSync(real), true);
});

test('checkArtifacts names every missing artifact, a stray dist-*/server-* directory and a changed build-config.json', (t) => {
	const tree = path.join(tmp(t), 'store.next');
	writeBuilt(tree, 'a');
	put(path.join(tree, 'build-config.json'), '{"x":1}');
	const cfgSha = sha('{"x":1}');
	assert.deepEqual(checkArtifacts({ tree, buildConfigSha: cfgSha }), { ok: true, problems: [] });
	assert.equal(checkArtifacts({ tree }).ok, true);
	for (const [rel, re] of [['server/entry.express.js', /entry\.express/], ['dist/q-manifest.json', /q-manifest/]]) {
		const keep = readFileSync(path.join(tree, rel));
		rmSync(path.join(tree, rel));
		const r = checkArtifacts({ tree });
		assert.equal(r.ok, false);
		assert.match(r.problems.join(), re);
		writeFileSync(path.join(tree, rel), keep);
	}
	rmSync(path.join(tree, 'dist/build/chunk.js'));
	assert.match(checkArtifacts({ tree }).problems.join(), /dist\/build is empty/);
	rmSync(path.join(tree, 'dist/build'), { recursive: true });
	assert.match(checkArtifacts({ tree }).problems.join(), /dist\/build is missing/);
	writeBuilt(tree, 'a');
	mkdirSync(path.join(tree, 'dist-e2e'));
	assert.match(checkArtifacts({ tree }).problems.join(), /dist-e2e/);
	rmSync(path.join(tree, 'dist-e2e'), { recursive: true });
	mkdirSync(path.join(tree, 'server-e2e'));
	assert.match(checkArtifacts({ tree }).problems.join(), /server-e2e/);
	rmSync(path.join(tree, 'server-e2e'), { recursive: true });
	writeFileSync(path.join(tree, 'build-config.json'), '{"x":2}');
	assert.match(checkArtifacts({ tree, buildConfigSha: cfgSha }).problems.join(), /changed during the build/);
	rmSync(path.join(tree, 'build-config.json'));
	assert.match(checkArtifacts({ tree, buildConfigSha: cfgSha }).problems.join(), /build-config.json is missing/);
	assert.equal(checkArtifacts({ tree: path.join(tree, 'nope') }).ok, false);
});

test('carryServer copies names the stage lacks, ignores identical files, tolerates a changed entry, and refuses collisions without copying', (t) => {
	const p = trees(t);
	writeBuilt(p.live, 'old', { server: { 'only-live.js': 'L', 'same.js': 'S', 'differs.js': 'old', 'sub/deep.js': 'D' } });
	writeBuilt(p.next, 'new', { server: { 'same.js': 'S', 'only-new.js': 'N' } });
	const r = carryServer({ live: p.live, stage: p.next });
	assert.deepEqual(r.collisions, []);
	assert.deepEqual(r.copied.sort(), ['differs.js', 'only-live.js', 'sub/deep.js']);
	assert.equal(readFileSync(path.join(p.next, 'server/only-live.js'), 'utf8'), 'L');
	assert.equal(readFileSync(path.join(p.next, 'server/entry.express.js'), 'utf8'), 'entry-new', 'the stage entry is never overwritten');
	assert.equal(readFileSync(path.join(p.next, 'server/only-new.js'), 'utf8'), 'N');

	const q = trees(t);
	writeBuilt(q.live, 'old', { server: { 'a.js': 'old-a', 'chunk.js': 'old' } });
	writeBuilt(q.next, 'new', { server: { 'chunk.js': 'NEW' } });
	const before = snapshot(path.join(q.next, 'server'));
	const c = carryServer({ live: q.live, stage: q.next });
	assert.deepEqual(c.collisions, ['chunk.js']);
	assert.deepEqual(c.copied, []);
	assert.ok(equalSnapshots(before, snapshot(path.join(q.next, 'server'))), 'nothing copied when any file collides');
	assert.deepEqual(carryServer({ live: path.join(q.root, 'none'), stage: q.next }), { copied: [], collisions: [] });
});

const treesWithAll = (t) => {
	const p = trees(t);
	for (const [n, tag] of [['live', 'L'], ['next', 'N'], ['prev', 'P']]) writeBuilt(p[n], tag);
	return p;
};

test('swap: old prev aside, live to prev, stage to live; each rename recorded before and after; exactly one prev', (t) => {
	const p = treesWithAll(t);
	const log = [];
	const ops = swap({ p, record: (o) => log.push(o.map((x) => `${x.op}:${x.status}`).join(',')) });
	assert.equal(readFileSync(path.join(p.live, 'server/entry.express.js'), 'utf8'), 'entry-N');
	assert.equal(readFileSync(path.join(p.prev, 'server/entry.express.js'), 'utf8'), 'entry-L');
	assert.equal(existsSync(p.next), false);
	assert.equal(existsSync(p.removed), false, 'the replaced prev is deleted after the swap');
	assert.ok(ops.every((o) => o.status === 'done'));
	assert.ok(log.some((l) => l.includes('live-to-prev:started')), 'recorded before it happens');
	assert.ok(log.some((l) => l.includes('live-to-prev:done')));
	assert.ok(log.findIndex((l) => l.includes('next-to-live:started')) > log.findIndex((l) => l.includes('live-to-prev:done')));
	// first activation: no prev yet, the aside step is skipped
	const q = trees(t);
	writeBuilt(q.live, 'L');
	writeBuilt(q.next, 'N');
	assert.equal(swap({ p: q, record: () => {} })[0].status, 'skipped');
	assert.equal(readFileSync(path.join(q.prev, 'server/entry.express.js'), 'utf8'), 'entry-L');
});

test('restore: live to failed, previous to live; exactly one failed tree is kept', (t) => {
	const p = trees(t);
	writeBuilt(p.live, 'BAD');
	writeBuilt(p.prev, 'GOOD');
	writeBuilt(p.failed, 'OLDER-FAILURE');
	restorePrevious({ p, record: () => {} });
	assert.equal(readFileSync(path.join(p.live, 'server/entry.express.js'), 'utf8'), 'entry-GOOD');
	assert.equal(readFileSync(path.join(p.failed, 'server/entry.express.js'), 'utf8'), 'entry-BAD');
	assert.equal(existsSync(p.prev), false);
	assert.equal(existsSync(p.removed), false);
	assert.deepEqual(readdirSync(p.root).sort(), ['store', 'store.failed']);
});

test('a crash after the first rename is undone from the record: the live tree is back, the stage kept', (t) => {
	const p = treesWithAll(t);
	let recorded = [];
	assert.throws(
		() => swap({ p, record: (o) => (recorded = o.map((x) => ({ ...x }))), crashAfter: (op) => { if (op === 'live-to-prev') throw new InjectedCrash('swap-mid'); } }),
		InjectedCrash,
	);
	assert.equal(existsSync(p.live), false, 'half-swapped');
	const r = recoverSwap({ p, ops: recorded });
	assert.equal(r.direction, 'undone');
	assert.equal(readFileSync(path.join(p.live, 'server/entry.express.js'), 'utf8'), 'entry-L');
	assert.equal(readFileSync(path.join(p.prev, 'server/entry.express.js'), 'utf8'), 'entry-P');
	assert.equal(readFileSync(path.join(p.next, 'server/entry.express.js'), 'utf8'), 'entry-N');
	assert.equal(existsSync(p.removed), false);
});

test('a crash after the last rename is completed, not reversed; a rename that never happened is not reversed', (t) => {
	const p = treesWithAll(t);
	let recorded = [];
	assert.throws(() => swap({ p, record: (o) => (recorded = o.map((x) => ({ ...x }))), crashAfter: (op) => { if (op === 'next-to-live') throw new InjectedCrash('late'); } }), InjectedCrash);
	assert.equal(existsSync(p.removed), true, 'the old prev is still aside until the swap is complete');
	assert.equal(recoverSwap({ p, ops: recorded }).direction, 'completed');
	assert.equal(readFileSync(path.join(p.live, 'server/entry.express.js'), 'utf8'), 'entry-N');
	assert.equal(existsSync(p.removed), false);

	// recorded `started` for a rename that did not happen: nothing to reverse
	const q = treesWithAll(t);
	const ops = swapOps(q);
	ops[0].status = 'started';
	assert.equal(recoverSwap({ p: q, ops }).direction, 'undone');
	assert.equal(readFileSync(path.join(q.live, 'server/entry.express.js'), 'utf8'), 'entry-L');
	assert.equal(readFileSync(path.join(q.prev, 'server/entry.express.js'), 'utf8'), 'entry-P');
	// restore ops go through the same recovery
	const r = trees(t);
	writeBuilt(r.live, 'BAD');
	writeBuilt(r.prev, 'GOOD');
	let rec = [];
	assert.throws(() => restorePrevious({ p: r, record: (o) => (rec = o.map((x) => ({ ...x }))), crashAfter: (op) => { if (op === 'live-to-failed') throw new InjectedCrash('x'); } }), InjectedCrash);
	assert.equal(recoverSwap({ p: r, ops: rec }).direction, 'undone');
	assert.equal(readFileSync(path.join(r.live, 'server/entry.express.js'), 'utf8'), 'entry-BAD');
	assert.equal(readFileSync(path.join(r.prev, 'server/entry.express.js'), 'utf8'), 'entry-GOOD');
	assert.deepEqual(restoreOps(r).map((o) => o.op), ['failed-aside', 'live-to-failed', 'prev-to-live']);
});

test('a leftover moved-aside tree blocks the next swap (run recover first); removeTree refuses a symlink', (t) => {
	const p = treesWithAll(t);
	mkdirSync(p.removed);
	assert.throws(() => swap({ p, record: () => {} }), (e) => e.exit === EXIT.RECOVER);
	rmSync(p.removed, { recursive: true });
	const link = path.join(p.root, 'lnk');
	symlinkSync(p.live, link);
	assert.throws(() => removeTree(link), (e) => e.exit === EXIT.ARTIFACT);
	assert.equal(existsSync(path.join(p.live, 'server')), true);
	renameSync(link, path.join(p.root, 'moved-link'));
});

// ------------------------------------------------------------------ review round 1

test('review 3: carry-over never writes through a symlinked directory in the stage', (t) => {
	const p = trees(t);
	writeBuilt(p.live, 'v1', { server: { 'chunks/old.js': 'old' } });
	writeBuilt(p.next, 'v2');
	// stage/server/chunks points into a tree outside the stage (here: the live server directory itself)
	symlinkSync(path.join(p.live, 'server'), path.join(p.next, 'server/chunks'));
	const liveBefore = snapshot(p.live);
	assert.throws(() => carryServer({ live: p.live, stage: p.next }), (e) => e instanceof DeployError && e.exit === EXIT.ARTIFACT && /symlink/.test(e.message));
	assert.ok(equalSnapshots(liveBefore, snapshot(p.live)), 'nothing was written through the link');
	// and an outside directory the link leads to stays empty
	const outside = path.join(p.root, 'outside');
	mkdirSync(outside);
	rmSync(path.join(p.next, 'server/chunks'));
	symlinkSync(outside, path.join(p.next, 'server/chunks'));
	assert.throws(() => carryServer({ live: p.live, stage: p.next }), (e) => e.exit === EXIT.ARTIFACT);
	assert.deepEqual(readdirSync(outside), []);
	// the stage's server directory itself as a symlink
	rmSync(path.join(p.next, 'server'), { recursive: true });
	symlinkSync(outside, path.join(p.next, 'server'));
	assert.throws(() => carryServer({ live: p.live, stage: p.next }), (e) => e.exit === EXIT.ARTIFACT);
	assert.deepEqual(readdirSync(outside), []);
	assert.throws(() => assertNoSymlinkAncestors(p.next, 'server/x.js'), (e) => e.exit === EXIT.ARTIFACT);
});

test('review 3: an artifact check rejects a symlinked server, dist or nested directory', (t) => {
	for (const rel of ['server/chunks', 'dist/build/sub', 'server', 'dist']) {
		const tree = path.join(tmp(t), 'store.next');
		const away = path.join(path.dirname(tree), 'away');
		writeBuilt(tree, 'a', { server: { 'chunks/x.js': 'x' } });
		put(path.join(away, 'f.js'), 'f');
		if (rel === 'server' || rel === 'dist') {
			cpDir(path.join(tree, rel), path.join(away, 'copy'));
			rmSync(path.join(tree, rel), { recursive: true });
			symlinkSync(path.join(away, 'copy'), path.join(tree, rel));
		} else {
			rmSync(path.join(tree, rel), { recursive: true, force: true });
			mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
			symlinkSync(away, path.join(tree, rel));
		}
		const r = checkArtifacts({ tree });
		assert.equal(r.ok, false, rel);
		assert.ok(r.problems.some((x) => /symlink|real directory/.test(x)), `${rel}: ${r.problems.join('; ')}`);
	}
});
const cpDir = (from, to) => {
	for (const n of readdirSync(from, { recursive: true })) {
		const f = path.join(from, n);
		let data;
		try {
			data = readFileSync(f);
		} catch (e) {
			if (e.code === 'EISDIR') continue;
			throw e;
		}
		put(path.join(to, n), data);
	}
};

test('review 5: exactly one of many simultaneous acquisitions wins; the rest are refused, not admitted through a takeover', async (t) => {
	const root = tmp(t);
	const p = pathsFor({ root, storeDir: 'store', layerDir: 'storefront' });
	// a leftover lock file naming a dead process must not matter (the file decides nothing)
	put(path.join(p.stateDir, 'lock'), JSON.stringify({ pid: 2 ** 22 + 12345 }));
	const results = await Promise.allSettled(Array.from({ length: 8 }, async () => takeLock(p)));
	const won = results.filter((r) => r.status === 'fulfilled');
	assert.equal(won.length, 1);
	for (const r of results.filter((x) => x.status === 'rejected')) assert.ok(r.reason instanceof DeployError && r.reason.exit === EXIT.RECOVER);
	await won[0].value();
	// released: the next one succeeds, and the same for the compose lock primitive
	await (await takeLock(p))();
	const dir = path.join(root, 'compose');
	mkdirSync(dir);
	const again = await Promise.allSettled(Array.from({ length: 8 }, () => acquireOsLock(dir, '.compose.lock')));
	assert.equal(again.filter((r) => r.status === 'fulfilled').length, 1);
	for (const r of again.filter((x) => x.status === 'rejected')) assert.ok(r.reason instanceof LockHeldError);
	await again.find((r) => r.status === 'fulfilled').value();
});

test('review 5: a holder killed at any point frees the lock, and a torn or unreadable pid file blocks nothing', async (t) => {
	const root = tmp(t);
	const p = pathsFor({ root, storeDir: 'store', layerDir: 'storefront' });
	const script = path.join(root, 'holder.mjs');
	put(script, `import { takeLock } from ${JSON.stringify(new URL('./lib.mjs', import.meta.url).href)};\nawait takeLock(${JSON.stringify(p)});\nconsole.log('locked');\nsetInterval(() => {}, 1000);\n`);
	const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
	t.after(() => child.kill('SIGKILL'));
	await new Promise((resolve, reject) => {
		child.stdout.once('data', resolve);
		child.once('exit', () => reject(new Error('holder exited early')));
	});
	await assert.rejects(takeLock(p), (e) => e instanceof DeployError && e.exit === EXIT.RECOVER);
	child.kill('SIGKILL');
	await new Promise((r) => child.on('exit', r));
	// the pid file the killed holder left behind, torn or garbage, does not matter
	put(path.join(p.stateDir, 'lock'), '{"pi');
	await (await takeLock(p))();
	put(path.join(p.stateDir, 'lock'), '');
	await (await takeLock(p))();
});

test('review 12: the build guard refuses an environment whose exports differ from the ones recorded, with the hash compose computes', (t) => {
	const g = guardWorld(t);
	const exportsMap = { SOME_API_BASE: 'http://api.example.invalid', A_PATH: '/catalog' };
	const exportsHash = hashJson(Object.entries(exportsMap).sort(([a], [b]) => (a < b ? -1 : 1)));
	put(path.join(g.root, 'store.next/build-config.json'), JSON.stringify({ exportNames: Object.keys(exportsMap).sort(), exportsHash }));
	const quiet = { error: () => {} };
	const token = { SELLRIGHT_DEPLOY_STAGE: 'S1' };
	assert.equal(guardMain(['--script-dir', g.scriptDir], { ...token, ...exportsMap }, quiet), 0, 'the recorded values pass');
	assert.equal(guardMain(['--script-dir', g.scriptDir], { ...token, ...exportsMap, SOME_API_BASE: 'http://other.invalid' }, quiet), 6, 'a different value');
	assert.equal(guardMain(['--script-dir', g.scriptDir], { ...token, A_PATH: '/catalog' }, quiet), 6, 'a missing export');
	assert.equal(guardMain(['--script-dir', g.scriptDir], token, quiet), 6, 'no exports at all');
	put(path.join(g.root, 'store.next/build-config.json'), JSON.stringify({ buildConfigHash: 'x' }));
	assert.equal(guardMain(['--script-dir', g.scriptDir], { ...token, ...exportsMap }, quiet), 6, 'a build-config.json without the export record');
	rmSync(path.join(g.root, 'store.next/build-config.json'));
	assert.equal(guardMain(['--script-dir', g.scriptDir], { ...token, ...exportsMap }, quiet), 6, 'no build-config.json');
});


// ------------------------------------------------------------------ review round 2

test('review 2.5: a symlink AS the stage or live tree root is refused by carry-over, the artifact check, seed and the CLI helper; nothing is written through it', async (t) => {
	const p = trees(t);
	// a valid, complete tree elsewhere: the link target passes every check made on its contents
	const elsewhere = path.join(p.root, 'elsewhere-tree');
	writeBuilt(elsewhere, 'other', { server: { 'keep.js': 'k' } });
	writeBuilt(p.live, 'v1', { server: { 'old-chunk.js': 'old' } });
	symlinkSync(elsewhere, p.next);
	const before = snapshot(elsewhere);
	assert.throws(() => carryServer({ live: p.live, stage: p.next }), (e) => e instanceof DeployError && e.exit === EXIT.ARTIFACT && /symlink/.test(e.message));
	assert.ok(equalSnapshots(before, snapshot(elsewhere)), 'carry-over wrote nothing into the link target');
	const r = checkArtifacts({ tree: p.next });
	assert.equal(r.ok, false);
	assert.ok(r.problems.some((x) => /symlink/.test(x)), r.problems.join('; '));
	assert.throws(() => assertTreesReal(p), (e) => e.exit === EXIT.ARTIFACT);
	assert.throws(() => seed({ live: p.live, stage: p.next }), (e) => e.exit === EXIT.PRECOND, 'a stage path that is a symlink counts as existing');
	// the CLI helper takes the same path through the same checks
	const cfg = path.join(p.root, 'cfg.json');
	put(cfg, JSON.stringify({ root: p.root, productionRoot: '/nonexistent-production-root', compose: ['x'] }));
	const out = { log() {}, error() {} };
	assert.equal(await stageMain(['--config', cfg, 'carry-server'], out).catch((e) => e.exit), EXIT.ARTIFACT);
	assert.equal(await stageMain(['--config', cfg, 'check-artifacts', '--tree', 'next'], out), EXIT.ARTIFACT);
	assert.ok(equalSnapshots(before, snapshot(elsewhere)));
	// a symlinked live root is refused too
	rmSync(p.next);
	writeBuilt(p.next, 'v2');
	const liveReal = path.join(p.root, 'live-real');
	renameSync(p.live, liveReal);
	symlinkSync(liveReal, p.live);
	assert.throws(() => carryServer({ live: p.live, stage: p.next }), (e) => e.exit === EXIT.ARTIFACT);
	assert.equal(checkArtifacts({ tree: p.live }).ok, false);
});
