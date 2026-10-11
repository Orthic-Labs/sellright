#!/usr/bin/env node
// Stage tree operations (plan A §4.2, §4.5, §4.6a d, finding C2): seed a stage from the live tree, check a tree's
// build artifacts, carry live server files into the stage, swap, restore the previous tree, undo a half-done swap.
//
// Every tree involved (live, stage, prev, failed, removed) is a child of one root, so a swap is renames on one
// filesystem. Symlinks are refused (lstat everywhere); no path leaves the root. Exactly one prev and one failed
// tree are kept: an older one is moved aside to `<name>.removed` first and deleted only after the swap completed.
//
// CLI (the swap steps are driven by the entry, which records them in its state file):
//   stage.mjs --config <file> seed | check-artifacts [--tree live|next|prev] | carry-server
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileDurable, fsyncDir, makeDir, removeTree as removeTreeDurable, renamePath } from '../compose/lib/durable.mjs';
import { DeployError, EXIT, RUNTIME_NAMES, loadConfig, parseFlags, pathsFor, takeLockOrDelegated } from './lib.mjs';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
export const fileSha = (abs) => sha(readFileSync(abs));

function lstatOrNull(p) {
	try {
		return lstatSync(p);
	} catch {
		return null;
	}
}

/** Throws when `p` exists as a symlink or as something other than a directory. Returns whether it exists. */
export function assertRealTree(p, what) {
	const st = lstatOrNull(p);
	if (!st) return false;
	if (st.isSymbolicLink()) throw new DeployError(EXIT.ARTIFACT, `${what} ${p} is a symlink`);
	if (!st.isDirectory()) throw new DeployError(EXIT.ARTIFACT, `${what} ${p} is not a directory`);
	return true;
}

/**
 * Every tree root of one operation (live, stage, prev, failed) must be a real directory or absent: a root that is a
 * symlink would redirect every later check and write (carry-over, artifact inspection, renames) to another tree.
 * Run before any helper, retention step or carry-over. The roots are direct children of the config root, which
 * loadConfig has already resolved to its realpath, so these are the whole ancestry.
 */
export function assertTreesReal(p, names = ['live', 'next', 'prev', 'failed']) {
	for (const n of names) assertRealTree(p[n], `${n} tree`);
}

/** Removes a tree that is not a symlink. Returns whether anything was removed. */
export function removeTree(p, what = 'tree') {
	if (!assertRealTree(p, what)) return false;
	removeTreeDurable(p);
	return true;
}

/** Regular files below `root` as { rel, abs, mode, size }; a symlink or special file throws. `skip(rel, isDir)` prunes. */
export function listFiles(root, skip = () => false) {
	const out = [];
	const visit = (dirAbs, dirRel) => {
		for (const name of readdirSync(dirAbs).sort()) {
			const rel = dirRel ? `${dirRel}/${name}` : name;
			const abs = path.join(dirAbs, name);
			const st = lstatSync(abs);
			if (skip(rel, st.isDirectory())) continue;
			if (st.isSymbolicLink()) throw new DeployError(EXIT.ARTIFACT, `symlink in tree: ${rel} (under ${root})`);
			if (st.isDirectory()) visit(abs, rel);
			else if (st.isFile()) out.push({ rel, abs, mode: st.mode & 0o777, size: st.size });
			else throw new DeployError(EXIT.ARTIFACT, `special file in tree: ${rel} (under ${root})`);
		}
	};
	visit(root, '');
	return out;
}

/**
 * Throws when `destRoot` or any existing directory between it and `rel`'s parent is a symlink (or not a directory),
 * so a write below `destRoot` can never be redirected out of it. Missing directories are fine: they get created.
 */
export function assertNoSymlinkAncestors(destRoot, rel) {
	assertRealTree(destRoot, 'destination tree');
	let cur = destRoot;
	for (const part of path.dirname(rel).split('/').filter((x) => x && x !== '.')) {
		cur = path.join(cur, part);
		const st = lstatOrNull(cur);
		if (!st) return;
		if (st.isSymbolicLink()) throw new DeployError(EXIT.ARTIFACT, `${path.relative(destRoot, cur)} under ${destRoot} is a symlink; refusing to write through it`);
		if (!st.isDirectory()) throw new DeployError(EXIT.ARTIFACT, `${path.relative(destRoot, cur)} under ${destRoot} is not a directory`);
	}
}

function copyInto(destRoot, f) {
	assertNoSymlinkAncestors(destRoot, f.rel);
	const dest = path.join(destRoot, f.rel);
	makeDir(path.dirname(dest), { recursive: true });
	copyFileDurable(f.abs, dest);
}

/**
 * Creates `stage` from the live tree's non-runtime paths: everything except node_modules, dist*, server*, .cache,
 * tmp, .env*, build-config.json, build-exports.json and test-results at the top level. `afterCopy(rel, n)`, when given,
 * runs after each copied file (a test seam: it can throw to model a failure or a kill halfway through). The stage must not exist (the caller removes a
 * leftover stage only when the state file allows it).
 */
export function seed({ live, stage, afterCopy }) {
	if (!assertRealTree(live, 'live tree')) throw new DeployError(EXIT.PRECOND, `live tree ${live} does not exist`);
	// lstat, not existsSync: a dangling symlink at the stage path is "something there" too
	if (lstatOrNull(stage)) throw new DeployError(EXIT.PRECOND, `stage ${stage} already exists`);
	const files = listFiles(live, (rel) => !rel.includes('/') && RUNTIME_NAMES(rel));
	makeDir(stage, { mode: 0o755 });
	let n = 0;
	for (const f of files) {
		copyInto(stage, f);
		afterCopy?.(f.rel, ++n);
	}
	return { copied: files.length };
}

/**
 * Artifact check of a built tree: what `vite build` (client, `dist/`) plus `vite build -c adapters/express/vite.config.mts`
 * (server, `server/`) leave in this checkout. The express adapter prerenders nothing (`ssg: { include: [] }`, so no HTML file
 * exists under dist/ by design: every document is rendered per request and may carry live stock), which means
 * `dist/index.html` is NOT an artifact of this build and is not required. The rendered HTML is verified where it exists, by the
 * origin smoke against the running server. `buildConfigSha`, when given, must equal the hash of `<tree>/build-config.json`
 * (the file written before the build must be unchanged after it).
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function checkArtifacts({ tree, buildConfigSha }) {
	const problems = [];
	const rootStat = lstatOrNull(tree);
	if (!rootStat) return { ok: false, problems: [`${tree} does not exist`] };
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { ok: false, problems: [`${tree} is ${rootStat.isSymbolicLink() ? 'a symlink' : 'not a directory'}, not a real tree`] };
	const kind = (rel) => {
		const st = lstatOrNull(path.join(tree, rel));
		return st ? (st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other') : 'absent';
	};
	for (const rel of ['server', 'dist']) {
		if (kind(rel) !== 'dir') {
			problems.push(`${rel} is missing or not a real directory`);
			continue;
		}
		try {
			listFiles(path.join(tree, rel));
		} catch (e) {
			problems.push(e.message);
		}
	}
	for (const rel of ['server/entry.express.js', 'dist/q-manifest.json']) if (kind(rel) !== 'file') problems.push(`${rel} is missing or not a regular file`);
	if (kind('dist/build') !== 'dir') problems.push('dist/build is missing');
	else if (readdirSync(path.join(tree, 'dist/build')).length === 0) problems.push('dist/build is empty');
	let top = [];
	try {
		top = readdirSync(tree);
	} catch {
		problems.push(`${tree} cannot be read`);
	}
	for (const n of top) if (/^(dist|server)-/.test(n) && kind(n) === 'dir') problems.push(`stray build output directory ${n}`);
	if (buildConfigSha !== undefined) {
		if (kind('build-config.json') !== 'file') problems.push('build-config.json is missing');
		else if (fileSha(path.join(tree, 'build-config.json')) !== buildConfigSha) problems.push('build-config.json changed during the build');
	}
	return { ok: problems.length === 0, problems };
}

/**
 * Copies into `<stage>/server` every `<live>/server` file whose name the stage lacks. Same-name files with
 * different content other than `entry.express.js` are collisions and nothing is copied (the caller exits 7).
 */
export function carryServer({ live, stage }) {
	assertRealTree(live, 'live tree');
	if (!assertRealTree(stage, 'stage tree')) throw new DeployError(EXIT.PRECOND, `stage ${stage} does not exist`);
	const src = path.join(live, 'server');
	if (!assertRealTree(src, 'live server directory')) return { copied: [], collisions: [] };
	const dst = path.join(stage, 'server');
	assertRealTree(dst, 'stage server directory');
	const copied = [];
	const collisions = [];
	const todo = [];
	for (const f of listFiles(src)) {
		assertNoSymlinkAncestors(dst, f.rel);
		const target = path.join(dst, f.rel);
		const st = lstatOrNull(target);
		if (!st) todo.push(f);
		else if (st.isSymbolicLink() || !st.isFile()) collisions.push(f.rel);
		else if (f.rel !== 'entry.express.js' && fileSha(f.abs) !== fileSha(target)) collisions.push(f.rel);
	}
	if (collisions.length) return { copied, collisions };
	for (const f of todo) {
		copyInto(dst, f);
		copied.push(f.rel);
	}
	return { copied, collisions };
}

// ------------------------------------------------------------------ swap

const rel = (p, root) => path.relative(root, p);
const abs = (r, root) => path.join(root, r);

/** The ordered renames of an activation: old prev aside, live to prev, stage to live. */
export function swapOps(p) {
	return [
		{ op: 'prev-aside', from: rel(p.prev, p.root), to: rel(p.removed, p.root), optional: true, status: 'pending' },
		{ op: 'live-to-prev', from: rel(p.live, p.root), to: rel(p.prev, p.root), status: 'pending' },
		{ op: 'next-to-live', from: rel(p.next, p.root), to: rel(p.live, p.root), status: 'pending' },
	];
}

/** The ordered renames of a restore: old failed aside, live to failed, prev to live. */
export function restoreOps(p) {
	return [
		{ op: 'failed-aside', from: rel(p.failed, p.root), to: rel(p.removed, p.root), optional: true, status: 'pending' },
		{ op: 'live-to-failed', from: rel(p.live, p.root), to: rel(p.failed, p.root), status: 'pending' },
		{ op: 'prev-to-live', from: rel(p.prev, p.root), to: rel(p.live, p.root), status: 'pending' },
	];
}

/**
 * Runs `ops`, recording each as `started` before the rename and `done` after it through `record(ops)` (the entry
 * writes that into its state file). `crashAfter(opName)` may throw InjectedCrash to simulate a killed process.
 * On success the moved-aside tree is deleted.
 */
export function runOps({ p, ops, record, crashAfter }) {
	assertTreesReal(p);
	if (existsSync(p.removed)) throw new DeployError(EXIT.RECOVER, `${p.removed} is left over from an interrupted swap; run recover first`);
	record(ops);
	for (const o of ops) {
		const from = abs(o.from, p.root);
		const to = abs(o.to, p.root);
		if (o.optional && !existsSync(from)) {
			o.status = 'skipped';
			record(ops);
			continue;
		}
		if (!existsSync(from)) throw new DeployError(EXIT.PRECOND, `swap: ${o.from} does not exist`);
		if (existsSync(to)) throw new DeployError(EXIT.PRECOND, `swap: ${o.to} already exists`);
		o.status = 'started';
		record(ops);
		// renamePath fsyncs the directory: the rename is durable before it is recorded as done
		renamePath(from, to);
		o.status = 'done';
		record(ops);
		crashAfter?.(o.op);
	}
	removeTree(p.removed, 'moved-aside tree');
	fsyncDir(p.root);
	return ops;
}

export const swap = (args) => runOps({ ...args, ops: swapOps(args.p) });
export const restorePrevious = (args) => runOps({ ...args, ops: restoreOps(args.p) });

/**
 * Brings a half-done set of renames to a consistent state. The recorded statuses are only the plan: after a host crash the
 * journal and the directory can disagree (a rename persisted without its record, or a record without the rename), so the
 * actual trees decide. The swap is complete when every non-optional destination exists and the last rename's source is gone
 * ('completed': only the moved-aside tree is deleted); otherwise every rename that took effect is reversed, last first
 * ('undone'). Each rename and the deletion is made durable (root fsync) before returning.
 */
export function recoverSwap({ p, ops }) {
	if (ops.length === 0) return { direction: 'undone' };
	const last = ops.at(-1);
	const complete = ops.filter((o) => !o.optional).every((o) => existsSync(abs(o.to, p.root))) && !existsSync(abs(last.from, p.root));
	if (complete) {
		removeTree(p.removed, 'moved-aside tree');
		fsyncDir(p.root);
		return { direction: 'completed' };
	}
	for (const o of [...ops].reverse()) {
		const from = abs(o.from, p.root);
		const to = abs(o.to, p.root);
		// reverse a rename only if it took effect (source gone, destination present), whatever the record says
		if (!existsSync(from) && existsSync(to)) {
			renamePath(to, from);
		}
	}
	return { direction: 'undone' };
}

// -------------------------------------------------------------------- CLI
export async function main(argv, out = console) {
	const a = parseFlags(argv, ['--config', '--tree']);
	const [cmd] = a.positional;
	if (!a.values.has('--config') || !['seed', 'check-artifacts', 'carry-server'].includes(cmd)) {
		out.error('usage: stage.mjs --config <file> (seed | check-artifacts [--tree live|next|prev] | carry-server)');
		return EXIT.USAGE;
	}
	const p = pathsFor(loadConfig(a.values.get('--config')));
	// seed and carry-server write the stage: they take the deployment lock (exit 5 while an operation holds it) unless this
	// process runs inside the operation that holds it
	if (cmd === 'seed' || cmd === 'carry-server') {
		let release;
		try {
			release = await takeLockOrDelegated(p);
		} catch (e) {
			if (e instanceof DeployError) {
				out.error(e.message);
				return e.exit;
			}
			throw e;
		}
		try {
			if (cmd === 'seed') {
				out.log(`seeded ${seed({ live: p.live, stage: p.next }).copied} files`);
				return 0;
			}
			const r = carryServer({ live: p.live, stage: p.next });
			out.log(`carried ${r.copied.length} server files; ${r.collisions.length} collisions${r.collisions.length ? `: ${r.collisions.join(', ')}` : ''}`);
			return r.collisions.length ? EXIT.ARTIFACT : 0;
		} finally {
			await release();
		}
	}
	const tree = p[a.values.get('--tree') ?? 'next'];
	if (!tree) {
		out.error('--tree must be live, next or prev');
		return EXIT.USAGE;
	}
	const r = checkArtifacts({ tree });
	for (const x of r.problems) out.error(x);
	return r.ok ? 0 : EXIT.ARTIFACT;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then(
		(c) => process.exit(c),
		(e) => {
			console.error(e.message);
			process.exit(e instanceof DeployError ? e.exit : 1);
		},
	);
}
