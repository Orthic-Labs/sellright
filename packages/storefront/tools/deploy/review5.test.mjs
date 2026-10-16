// node --test tools/deploy/review5.test.mjs   (cwd: packages/storefront)
// Review round 5 regression tests: one durable filesystem helper for every change (5.1), the smoke runs with the production
// runtime mode (5.2), closure validation checks every path component (5.3). Recovery of created directories (5.4) is in
// tools/compose/journal.test.mjs.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { activate, build, defaultDeps } from './entry.mjs';
import { EXIT, normaliseConfig } from './lib.mjs';
import { closureProblem, rollbackLegacy } from './rollback.mjs';
import { appendFile, copyFileDurable, createFile, fsyncHooks, makeDir, removeDir, removeFile, removeTree, renamePath, replaceFile } from '../compose/lib/durable.mjs';
import { makeWorld, sha } from './fixtures/world.mjs';

const NP = { noRestart: true, smokePort: 4555 };
const toolsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = (t, prefix = 'r5-') => {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
};

// ------------------------------------------------------------------ 5.1

test('review 5.1: every create, replace, append, rename, unlink, rmdir, mkdir and tree removal fsyncs the directory entry before the next change', (t) => {
	const root = scratch(t);
	const events = [];
	fsyncHooks.onOp = (kind, p, extra) => events.push({ op: kind, p, from: extra?.from });
	fsyncHooks.onDir = (d) => events.push({ dir: d });
	t.after(() => {
		fsyncHooks.onOp = null;
		fsyncHooks.onDir = null;
	});
	makeDir(path.join(root, 'a/b'), { recursive: true });
	createFile(path.join(root, 'a/b/one'), 'x');
	replaceFile(path.join(root, 'a/b/one'), 'y');
	appendFile(path.join(root, 'a/log'), 'l\n');
	copyFileDurable(path.join(root, 'a/b/one'), path.join(root, 'a/copy'));
	renamePath(path.join(root, 'a/b/one'), path.join(root, 'a/moved'));
	removeFile(path.join(root, 'a/moved'));
	removeDir(path.join(root, 'a/b'));
	removeTree(path.join(root, 'a'));
	// after each change: the first directory fsyncs name the parents of what changed (both parents for a rename), before any other change
	for (const [i, e] of events.entries()) {
		if (!e.op) continue;
		const want = e.op === 'rename' ? [path.dirname(e.p), path.dirname(e.from)] : [path.dirname(e.p)];
		const dirs = [];
		for (let j = i + 1; j < events.length && !events[j].op; j++) dirs.push(events[j].dir);
		for (const d of new Set(want)) assert.ok(dirs.includes(d), `${e.op} ${path.relative(root, e.p)} is followed by an fsync of ${path.relative(root, d) || '.'} (saw ${dirs.map((x) => path.relative(root, x) || '.')})`);
	}
	const kinds = events.filter((e) => e.op).map((e) => e.op);
	for (const k of ['mkdir', 'create', 'replace', 'rename', 'unlink', 'rmdir', 'rmtree']) assert.ok(kinds.includes(k), `${k} was exercised`);
	// every directory created on the way is fsynced into its parent (a/ into root, a/b into a/)
	const mk = events.filter((e) => e.op === 'mkdir').map((e) => path.relative(root, e.p));
	assert.deepEqual(mk, ['a', 'a/b']);
});

const SOURCES = ['compose', 'compose/lib', 'compose/checkers', 'deploy'];
const MUTATORS = /\b(?:writeFileSync|appendFileSync|renameSync|unlinkSync|mkdirSync|mkdtempSync|rmSync|rmdirSync|copyFileSync|cpSync|symlinkSync|linkSync|truncateSync|ftruncateSync|chmodSync|chownSync|utimesSync|futimesSync|fsyncSync|fdatasyncSync|writeSync|writevSync)\b|\bopenSync\([^)]*,\s*(?:'[wa+]|"[wa+]|fsConstants\.O_(?:WRONLY|RDWR|CREAT|APPEND|TRUNC))|node:fs\/promises|\bfs\.promises\b|\b(?:writeFile|appendFile|rename|unlink|mkdir|mkdtemp|rm|rmdir|copyFile|cp|symlink|truncate|chmod)\(\s*(?:path|['"`/])/;

test('review 5.1: no file in tools/compose or tools/deploy changes the filesystem except through durable.mjs', () => {
	const offenders = [];
	for (const dir of SOURCES) {
		for (const name of readdirSync(path.join(toolsDir, dir))) {
			if (!name.endsWith('.mjs') || name.endsWith('.test.mjs') || (dir === 'compose/lib' && name === 'durable.mjs')) continue;
			const lines = readFileSync(path.join(toolsDir, dir, name), 'utf8').split('\n');
			lines.forEach((line, i) => {
				const code = line.trim();
				if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
				if (MUTATORS.test(code)) offenders.push(`${dir}/${name}:${i + 1}: ${code.slice(0, 100)}`);
			});
		}
	}
	assert.deepEqual(offenders, [], 'route these through compose/lib/durable.mjs');
});

test('review 5.1: the lint finds a direct write (the check is not vacuous)', () => {
	assert.ok(MUTATORS.test("renameSync(a, b);"));
	assert.ok(MUTATORS.test("const fd = openSync(tmp, 'wx', mode);"));
	assert.ok(!MUTATORS.test("fd = openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);"));
	assert.ok(MUTATORS.test("await rm(path.join(a, b))"));
});

test('review 5.1: a retired journal waits for the durability of every undo: unlinks and rmdirs are fsynced before the journal is renamed away', async (t) => {
	const { beginJournal, recoverJournals } = await import('../compose/lib/journal.mjs');
	const { safeWrite } = await import('../compose/lib/util.mjs');
	const repo = scratch(t);
	const out = path.join(repo, 'out');
	mkdirSync(out);
	const history = path.join(repo, '.compose-history');
	mkdirSync(history);
	const roots = { out, history };
	const j = beginJournal({ brandRepo: repo, roots, paths: [{ root: 'out', rel: 'x/y/new.txt' }] });
	safeWrite(out, 'x/y/new.txt', 'added');
	assert.ok(existsSync(path.join(out, 'x/y/new.txt')));
	const events = [];
	fsyncHooks.onOp = (kind, p) => events.push(`${kind}:${path.relative(repo, p)}`);
	fsyncHooks.onDir = (d) => events.push(`fsync:${path.relative(repo, d)}`);
	t.after(() => {
		fsyncHooks.onOp = null;
		fsyncHooks.onDir = null;
	});
	const done = recoverJournals({ brandRepo: repo, roots });
	assert.equal(done[0].removed, 1);
	assert.equal(done[0].dirs, 2, 'the two directories the composition created are removed');
	const at = (e) => events.findIndex((x) => x === e);
	const retire = events.findIndex((x) => x.startsWith('rename:.compose-journal/') && x.endsWith('.done'));
	assert.ok(retire > 0, `the journal is retired: ${events.join(' ')}`);
	for (const [op, dir] of [['unlink:out/x/y/new.txt', 'fsync:out/x/y'], ['rmdir:out/x/y', 'fsync:out/x'], ['rmdir:out/x', 'fsync:out']]) {
		assert.ok(at(op) >= 0 && at(op) < retire, `${op} precedes the retirement`);
		assert.ok(events.indexOf(dir, at(op)) > at(op) && events.indexOf(dir, at(op)) < retire, `${dir} follows ${op} and precedes the retirement`);
	}
	assert.equal(j.id.length > 0, true);
});

test('review 5.1: tree renames, the deploy state writes and the retention marker copies all go through the helper (hook sees them)', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	const ops = [];
	fsyncHooks.onOp = (kind) => ops.push(kind);
	t.after(() => (fsyncHooks.onOp = null));
	const ctx = w.ctx();
	await build(ctx, {});
	await activate(ctx, NP);
	for (const k of ['mkdir', 'create', 'replace', 'rename', 'unlink']) assert.ok(ops.includes(k), `a build and an activation performed ${k} through the helper (saw ${[...new Set(ops)]})`);
});

// ------------------------------------------------------------------ 5.2

/** A server that, like the storefront, refuses to start in production mode without its runtime configuration. */
function strictServer(t) {
	const dir = scratch(t, 'r5-srv-');
	mkdirSync(path.join(dir, 'server'));
	writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
	writeFileSync(
		path.join(dir, 'server/entry.express.js'),
		`import http from 'node:http';
if (process.env.NODE_ENV === 'production' && !process.env.SELLRIGHT_API_URL) { console.error('production without SELLRIGHT_API_URL'); process.exit(3); }
http.createServer((q, s) => s.end(JSON.stringify({ mode: process.env.NODE_ENV ?? null }))).listen(Number(process.env.PORT), '127.0.0.1');
`,
	);
	return dir;
}
const until = async (f, ms = 5000) => {
	for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (await f()) return true;
	return false;
};

test('review 5.2: a real candidate child runs in production mode even when the caller\'s environment has no NODE_ENV (or another one)', async (t) => {
	const dir = strictServer(t);
	const startLocal = defaultDeps().startLocal;
	for (const env of [{ PATH: process.env.PATH }, { PATH: process.env.PATH, NODE_ENV: 'development' }]) {
		const port = await defaultDeps().freePort();
		// without the production runtime configuration the production-only check kills the child: the smoke cannot pass by running in a weaker mode
		const bad = await startLocal({ cwd: dir, port, env: { ...env, PORT: String(port) } });
		assert.ok(await until(() => !bad.alive()), 'a candidate without SELLRIGHT_API_URL exits at startup in production mode');
		const good = await startLocal({ cwd: dir, port, env: { ...env, PORT: String(port), SELLRIGHT_API_URL: 'https://api.example.test' } });
		t.after(() => good.stop());
		let body = null;
		assert.ok(await until(async () => {
			try {
				body = await (await fetch(`http://127.0.0.1:${port}/`)).json();
				return true;
			} catch {
				return false;
			}
		}));
		assert.equal(body.mode, 'production');
		await good.stop();
	}
});

test('review 5.2: the activation smoke starts the candidate and the live tree with NODE_ENV=production and the configured runtime variables; the caller cannot override the mode, port or host', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	const envs = [];
	w.deps.startLocal = (o) => {
		envs.push(o.env);
		o.onSpawn?.({ pid: 4242424, startTicks: '77' });
		return { alive: () => true, stop: async () => {} };
	};
	w.deps.waitReady = async () => true;
	const ctx = w.ctx();
	ctx.cfg.smokeEnv = { SELLRIGHT_API_URL: 'https://api.example.test' };
	delete ctx.deps.env.NODE_ENV;
	await build(ctx, {});
	await activate(ctx, NP);
	assert.equal(envs.length, 2, 'candidate smoke and live smoke');
	for (const e of envs) {
		assert.equal(e.NODE_ENV, 'production');
		assert.equal(e.SELLRIGHT_API_URL, 'https://api.example.test');
		assert.equal(e.HOST, '127.0.0.1');
		assert.match(e.PORT, /^\d+$/);
	}
	const base = { root: w.root, productionRoot: '/nonexistent/prod', compose: ['x'] };
	for (const bad of [{ NODE_ENV: 'development' }, { PORT: '1' }, { HOST: '0.0.0.0' }, { 'lower': 'x' }, { SELLRIGHT_API_URL: 5 }]) {
		assert.throws(() => normaliseConfig({ ...base, smokeEnv: bad }), (e) => e.exit === EXIT.USAGE, JSON.stringify(bad));
	}
	assert.deepEqual(normaliseConfig({ ...base, smokeEnv: { A_B: 'c' } }).smokeEnv, { A_B: 'c' });
});

// ------------------------------------------------------------------ 5.3

function closureDir(t) {
	const rec = scratch(t, 'r5-closure-');
	const clientRel = 'sellright/packages/storefront-client';
	const files = {};
	const put = (rel, text) => {
		mkdirSync(path.dirname(path.join(rec, rel)), { recursive: true });
		writeFileSync(path.join(rec, rel), text);
		files[rel] = sha(text);
	};
	put(`${clientRel}/package.json`, '{"name":"client"}');
	put(`${clientRel}/dist/index.js`, 'export {};');
	return { rec, recDir: rec, clientRel, clientDir: path.join(rec, clientRel), files, put };
}

test('review 5.3: a clean closure passes; a symlink inside the closure that stays inside is allowed', (t) => {
	const c = closureDir(t);
	assert.equal(closureProblem(c), null);
	mkdirSync(path.join(c.clientDir, 'node_modules'));
	symlinkSync(path.join(c.clientDir, 'dist'), path.join(c.clientDir, 'node_modules/self-dist'));
	assert.equal(closureProblem(c), null);
});

test('review 5.3: a nested dependency symlink into the development tree is refused even though the target bytes match the manifest', (t) => {
	const c = closureDir(t);
	const dev = scratch(t, 'r5-dev-');
	mkdirSync(path.join(dev, 'openapi-fetch'));
	writeFileSync(path.join(dev, 'openapi-fetch/index.js'), 'dev bytes');
	mkdirSync(path.join(c.clientDir, 'node_modules'));
	symlinkSync(path.join(dev, 'openapi-fetch'), path.join(c.clientDir, 'node_modules/openapi-fetch'));
	// even if the manifest lists a file reached through the link, and its bytes match
	c.files['sellright/packages/storefront-client/node_modules/openapi-fetch/index.js'] = sha('dev bytes');
	assert.match(closureProblem(c), /symlink that resolves outside the closure/);
});

test('review 5.3: a listed file behind a symlinked ancestor, a dangling or looping symlink, a special file and an unlisted client file are refused', (t) => {
	let c = closureDir(t);
	rmSync(path.join(c.clientDir, 'dist'), { recursive: true });
	mkdirSync(path.join(c.clientDir, 'real-dist'));
	writeFileSync(path.join(c.clientDir, 'real-dist/index.js'), 'export {};');
	symlinkSync(path.join(c.clientDir, 'real-dist'), path.join(c.clientDir, 'dist'));
	c.files[`${c.clientRel}/real-dist/index.js`] = sha('export {};');
	assert.match(closureProblem(c), /goes through a symlink/, 'a listed path whose ancestor is an (internal) symlink');

	c = closureDir(t);
	symlinkSync(path.join(c.rec, 'does-not-exist'), path.join(c.clientDir, 'dangling'));
	assert.match(closureProblem(c), /does not resolve/);

	c = closureDir(t);
	symlinkSync(path.join(c.clientDir, 'loop'), path.join(c.clientDir, 'loop'));
	assert.match(closureProblem(c), /does not resolve/);

	c = closureDir(t);
	execFileSync('mkfifo', [path.join(c.clientDir, 'pipe')]);
	assert.match(closureProblem(c), /special file/);

	c = closureDir(t);
	writeFileSync(path.join(c.clientDir, 'extra.js'), 'unverified');
	assert.match(closureProblem(c), /not listed in closure\.json/);

	c = closureDir(t);
	c.files['../escape'] = sha('x');
	assert.match(closureProblem(c), /unsafe path/);

	c = closureDir(t);
	writeFileSync(path.join(c.clientDir, 'package.json'), 'tampered');
	assert.match(closureProblem(c), /does not match closure\.json/);

	c = closureDir(t);
	c.files[`${c.clientRel}/missing.js`] = sha('x');
	assert.match(closureProblem(c), /is missing/);
});

test('review 5.3: a legacy rollback whose captured client holds a nested symlink out of the closure is refused at validation: no stage, no state, no build', async (t) => {
	const w = makeWorld();
	t.after(w.cleanup);
	const tag = 'tag-1';
	w.write(path.join(w.root, '.compose-history/compose-adoption.json'), JSON.stringify({ legacyCommit: w.tagCommit, legacyTag: tag }));
	const rec = path.join(w.root, '.deploy-backups/legacy-client', tag);
	w.write(path.join(rec, 'legacy-input.json'), JSON.stringify({ tag, commit: w.tagCommit, node: w.versions.node, pnpm: w.versions.pnpm, files: Object.fromEntries(Object.entries(w.legacyFiles).map(([k, v]) => [k, sha(v)])) }));
	const clientRel = 'sellright/packages/storefront-client';
	w.write(path.join(rec, clientRel, 'package.json'), '{"name":"client"}');
	w.write(path.join(rec, 'closure.json'), JSON.stringify({ files: { [`${clientRel}/package.json`]: sha('{"name":"client"}') } }));
	const dev = path.join(w.base, 'dev-tree');
	mkdirSync(dev);
	writeFileSync(path.join(dev, 'index.js'), 'dev');
	mkdirSync(path.join(rec, clientRel, 'node_modules'));
	symlinkSync(dev, path.join(rec, clientRel, 'node_modules/openapi-fetch'));
	const err = await rollbackLegacy(w.ctx(), tag, NP).catch((e) => e);
	assert.equal(err.exit, EXIT.ARTIFACT);
	assert.match(err.message, /resolves outside the closure/);
	assert.equal(existsSync(path.join(w.root, 'store.next')), false, 'no stage was created');
	assert.equal(w.called('legacy-build'), false);
	assert.equal(w.called('install'), false);
});
