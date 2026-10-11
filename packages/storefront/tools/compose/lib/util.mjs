// Shared primitives for the compose, drift and env tools. Node built-ins only.
import { createHash } from 'node:crypto';
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	writeSync,
} from 'node:fs';
import path from 'node:path';

export class ComposeError extends Error {
	constructor(code, message, details) {
		super(`${code}: ${message}`);
		this.name = 'ComposeError';
		this.code = code;
		this.details = details;
	}
}

/** Collects validation problems so one run reports every one of them. */
export class Problems {
	constructor() {
		this.list = [];
	}
	add(code, message, file) {
		this.list.push(file === undefined ? { code, message } : { code, message, file });
	}
	get any() {
		return this.list.length > 0;
	}
	codes() {
		return [...new Set(this.list.map((p) => p.code))];
	}
	throwIfAny(code = 'validation') {
		if (!this.any) return;
		const lines = this.list.map((p) => `  [${p.code}] ${p.file ? `${p.file}: ` : ''}${p.message}`);
		throw new ComposeError(code, `${this.list.length} problem(s)\n${lines.join('\n')}`, this.list);
	}
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
export const SHA_RE = /^[0-9a-f]{64}$/;
export const PIN_RE = /^[0-9a-f]{40}$/;

function sortKeys(v) {
	if (Array.isArray(v)) return v.map(sortKeys);
	if (v && typeof v === 'object') {
		const out = {};
		for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
		return out;
	}
	return v;
}
/** Compact, key-sorted JSON: the form that is hashed. */
export const canonical = (v) => JSON.stringify(sortKeys(v));
/** Key-sorted, 2-space JSON with a trailing newline: the form that is written. */
export const pretty = (v) => `${JSON.stringify(sortKeys(v), null, 2)}\n`;
export const hashJson = (v) => sha256(canonical(v));

export function readJson(file, what = file) {
	let text;
	try {
		text = readFileSync(file, 'utf8');
	} catch (e) {
		throw new ComposeError('missing-file', `${what} cannot be read (${e.code ?? e.message})`);
	}
	try {
		return JSON.parse(text);
	} catch (e) {
		throw new ComposeError('bad-json', `${what} is not valid JSON (${e.message})`);
	}
}

/**
 * A relative path that is safe to join under a root: posix separators, no
 * empty, `.` or `..` segments, not absolute, no NUL or backslash.
 * Returns the reason it is unsafe, or null.
 */
export function unsafeRelReason(p) {
	if (typeof p !== 'string' || p === '') return 'empty or non-string path';
	if (p.includes('\0')) return 'NUL in path';
	if (p.includes('\\')) return 'backslash in path';
	if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'absolute path';
	for (const seg of p.split('/')) {
		if (seg === '' ) return 'empty segment';
		if (seg === '.' || seg === '..') return `'${seg}' segment`;
	}
	return null;
}
export function assertSafeRel(p, what = 'path') {
	const r = unsafeRelReason(p);
	if (r) throw new ComposeError('unsafe-path', `${what} ${JSON.stringify(p)}: ${r}`);
	return p;
}

export function isInside(root, target) {
	const rel = path.relative(root, target);
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Canonical (symlink-resolved) directory path; throws when it is not a real directory. */
export function realDir(p, what = 'directory') {
	let st;
	try {
		st = lstatSync(p);
	} catch {
		throw new ComposeError('missing-dir', `${what} ${p} does not exist`);
	}
	if (st.isSymbolicLink()) throw new ComposeError('symlink', `${what} ${p} is a symlink`);
	if (!st.isDirectory()) throw new ComposeError('missing-dir', `${what} ${p} is not a directory`);
	return realpathSync(p);
}

/** Realpath of the deepest existing ancestor of `p` plus the missing tail, so a path not created yet still resolves. */
export function canonicalPath(p) {
	let cur = path.resolve(p);
	const tail = [];
	for (;;) {
		try {
			return path.join(realpathSync(cur), ...tail.reverse());
		} catch {
			const parent = path.dirname(cur);
			if (parent === cur) return path.resolve(p);
			tail.push(path.basename(cur));
			cur = parent;
		}
	}
}

/**
 * Validates an output file path before anything is created. Every existing component is lstat-checked (a symlink or
 * non-directory ancestor, and a symlink or directory target, are refused, so nothing is created through a link) and the
 * canonical destination is checked against every input root, existing or not. Returns { root, rel, abs }: `root` is the
 * deepest existing real directory and `rel` the missing remainder, ready for `safeWrite`.
 */
export function resolveOutputPath(out, inputRoots, what = 'output') {
	const abs = path.resolve(out);
	const { root: fsRoot } = path.parse(abs);
	const parts = abs.slice(fsRoot.length).split(path.sep).filter(Boolean);
	if (parts.length === 0) throw new ComposeError('not-a-file', `${what} path ${out} has no file name`);
	let cur = fsRoot;
	let existing = 0;
	for (let i = 0; i < parts.length; i++) {
		const next = path.join(cur, parts[i]);
		let st;
		try {
			st = lstatSync(next);
		} catch {
			break;
		}
		const last = i === parts.length - 1;
		if (st.isSymbolicLink()) throw new ComposeError('symlink', `${what} path ${out} goes through a symlink: ${next}`);
		if (last && st.isDirectory()) throw new ComposeError('not-a-file', `${what} path ${out} is a directory`);
		if (!last && !st.isDirectory()) throw new ComposeError('not-a-dir', `${what} path ${out}: ${next} is not a directory`);
		cur = next;
		existing = i + 1;
	}
	const dest = canonicalPath(abs);
	for (const d of inputRoots.filter(Boolean)) {
		if (isInside(canonicalPath(d), dest) || isInside(path.resolve(d), abs)) throw new ComposeError('out-inside-input', `${out} is inside ${d}; the inputs are read only`);
	}
	// A file that already exists is its own last component: its directory is the write root.
	const rootParts = Math.min(existing, parts.length - 1);
	const root = path.join(fsRoot, ...parts.slice(0, rootParts));
	return { root, rel: parts.slice(rootParts).join('/'), abs };
}

/** Writes `data` to a validated output path; missing directories are created only below its real root. */
export function writeOutputFile(out, inputRoots, data, what = 'output') {
	const r = resolveOutputPath(out, inputRoots, what);
	safeWrite(r.root, r.rel, data);
	return r.abs;
}

/**
 * Lists regular files below root without following symlinks. A symlink or a
 * special file anywhere in the walked set throws. `skip(rel, isDir)` prunes
 * entries before they are inspected.
 */
export function walkFiles(root, skip = () => false) {
	const out = [];
	const visit = (dirAbs, dirRel) => {
		const names = readdirSync(dirAbs).sort();
		for (const name of names) {
			const rel = dirRel ? `${dirRel}/${name}` : name;
			const abs = path.join(dirAbs, name);
			const st = lstatSync(abs);
			const isDir = st.isDirectory();
			if (skip(rel, isDir)) continue;
			if (st.isSymbolicLink()) throw new ComposeError('symlink', `symlink in tree: ${rel} (under ${root})`);
			if (isDir) visit(abs, rel);
			else if (st.isFile()) out.push({ rel, abs, size: st.size, mode: st.mode });
			else throw new ComposeError('special-file', `non-regular file in tree: ${rel} (under ${root})`);
		}
	};
	visit(root, '');
	return out;
}

/** Hash of a path -> sha256 map (order independent). */
export function treeHash(entries) {
	const rows = [...entries].map(([p, h]) => `${p}\0${h}`).sort();
	return sha256(rows.join('\n'));
}

export function fileSha(abs) {
	return sha256(readFileSync(abs));
}

/** The root of every write and removal must itself be a real directory: lstat, never a symlink. */
export function assertRealRoot(root) {
	let st;
	try {
		st = lstatSync(root);
	} catch {
		throw new ComposeError('missing-dir', `root ${root} does not exist`);
	}
	if (st.isSymbolicLink()) throw new ComposeError('symlink', `root ${root} is a symlink`);
	if (!st.isDirectory()) throw new ComposeError('not-a-dir', `root ${root} is not a directory`);
}

/**
 * Why the existing ancestors of `rel` under `root` are not safe to act through, or null. A missing
 * ancestor is safe (nothing to act on). Checks every directory between root and the file, by lstat.
 */
export function unsafeAncestorReason(root, rel) {
	const parts = rel.split('/');
	let cur = root;
	for (let i = 0; i < parts.length - 1; i++) {
		cur = path.join(cur, parts[i]);
		let st;
		try {
			st = lstatSync(cur);
		} catch {
			return null;
		}
		if (st.isSymbolicLink()) return `ancestor is a symlink: ${parts.slice(0, i + 1).join('/')}`;
		if (!st.isDirectory()) return `ancestor is not a directory: ${parts.slice(0, i + 1).join('/')}`;
	}
	return null;
}

/**
 * Writes one file under `root`. Refuses `..`, absolute paths, any symlink on
 * the way (existing ancestors or the target itself) and directories at the
 * target. Writes to a temp name and renames, so a crash never leaves a half file.
 */
export function safeWrite(root, rel, data, mode = 0o644) {
	assertRealRoot(root);
	assertSafeRel(rel, 'output path');
	const abs = path.join(root, rel);
	if (!isInside(root, abs)) throw new ComposeError('outside-root', `${rel} resolves outside ${root}`);
	const parts = rel.split('/');
	let cur = root;
	for (let i = 0; i < parts.length - 1; i++) {
		cur = path.join(cur, parts[i]);
		let st = null;
		try {
			st = lstatSync(cur);
		} catch {
			/* missing: created below */
		}
		if (st === null) mkdirSync(cur);
		else if (st.isSymbolicLink()) throw new ComposeError('symlink', `output ancestor is a symlink: ${parts.slice(0, i + 1).join('/')}`);
		else if (!st.isDirectory()) throw new ComposeError('not-a-dir', `output ancestor is not a directory: ${parts.slice(0, i + 1).join('/')}`);
	}
	try {
		const st = lstatSync(abs);
		if (st.isSymbolicLink()) throw new ComposeError('symlink', `output target is a symlink: ${rel}`);
		if (st.isDirectory()) throw new ComposeError('not-a-file', `output target is a directory: ${rel}`);
	} catch (e) {
		if (e instanceof ComposeError) throw e;
	}
	const tmp = `${abs}.compose-tmp-${process.pid}`;
	const fd = openSync(tmp, 'wx', mode);
	try {
		writeSync(fd, data);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	chmodSync(tmp, mode);
	renameSync(tmp, abs);
}

/** Removes one regular file under root (never a symlink target or a file behind a symlinked or non-directory ancestor, never a directory). */
export function safeRemoveFile(root, rel) {
	assertRealRoot(root);
	assertSafeRel(rel, 'removal path');
	const abs = path.join(root, rel);
	if (!isInside(root, abs)) throw new ComposeError('outside-root', `${rel} resolves outside ${root}`);
	const bad = unsafeAncestorReason(root, rel);
	if (bad) throw new ComposeError(bad.includes('symlink') ? 'symlink' : 'not-a-dir', `refusing to remove ${rel}: ${bad}`);
	let st;
	try {
		st = lstatSync(abs);
	} catch {
		return false;
	}
	if (st.isSymbolicLink()) throw new ComposeError('symlink', `refusing to remove symlink ${rel}`);
	if (!st.isFile()) throw new ComposeError('not-a-file', `refusing to remove non-file ${rel}`);
	rmSync(abs);
	return true;
}

/** Removes now-empty parent directories of rel, stopping at root. Never removes root. */
export function pruneEmptyDirs(root, rel) {
	let dir = path.posix.dirname(rel);
	while (dir && dir !== '.') {
		const abs = path.join(root, dir);
		try {
			if (!lstatSync(abs).isDirectory() || readdirSync(abs).length > 0) return;
			rmSync(abs, { recursive: false });
		} catch {
			return;
		}
		dir = path.posix.dirname(dir);
	}
}

export const exists = (p) => existsSync(p);

/** Names compose and its removal logic never touch, at the root of the build directory. */
export function isRuntimeName(name) {
	return (
		name === 'node_modules' ||
		name.startsWith('dist') ||
		name.startsWith('server') ||
		name === '.cache' ||
		name === 'tmp' ||
		name === '.env' ||
		name === '.env.local'
	);
}
