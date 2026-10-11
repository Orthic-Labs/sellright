// The one place compose and the deploy tools change the filesystem.
//
// Every create, replace, append, rename, remove and mkdir goes through here, and each one fsyncs what it changed AND the
// directory entry that records it (the parent of a created, replaced or removed name; both parents of a rename; the
// parent of every directory it creates). A caller that is told an operation finished may therefore treat it as durable:
// a journal can be retired, a state record can say "done", without a host crash resurrecting an unlink or losing a rename.
//
// `tools/compose/lib/durable.test.mjs` fails when any other file in tools/compose or tools/deploy calls a mutating `fs`
// function directly, so a new writer cannot bypass this module unnoticed.
import {
	chmodSync,
	closeSync,
	copyFileSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	openSync,
	renameSync,
	rmSync,
	rmdirSync,
	truncateSync,
	unlinkSync,
	writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Test seams. `onDir(dir)` sees every directory fsync; `onOp(kind, path, extra)` sees every change right after it was made
 * (before its directory fsync), so a test can assert the order: change, then fsync of the directory, then whatever relies on it.
 */
export const fsyncHooks = { onDir: null, onOp: null };

const op = (kind, p, extra) => fsyncHooks.onOp?.(kind, p, extra);

function fsyncFd(fd) {
	fsyncSync(fd);
}

/** fsyncs a directory so the names created, renamed and removed inside it survive a host crash. */
export function fsyncDir(dir) {
	fsyncHooks.onDir?.(dir);
	const fd = openSync(dir, 'r');
	try {
		fsyncFd(fd);
	} finally {
		closeSync(fd);
	}
}

/** fsyncs a file's data. */
export function fsyncFile(file) {
	const fd = openSync(file, 'r');
	try {
		fsyncFd(fd);
	} finally {
		closeSync(fd);
	}
}

/**
 * Makes a whole tree durable: fsyncs every regular file and every directory under `root` (and `root` itself), whoever wrote
 * it (a build, a package manager, a retention helper). A symlink is not followed or opened; its directory entry is made
 * durable by the fsync of the directory that holds it. Returns { files, dirs } counts.
 */
export function fsyncTree(root) {
	const counts = { files: 0, dirs: 0 };
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const abs = path.join(dir, name);
			const st = lstatSync(abs);
			if (st.isDirectory()) walk(abs);
			else if (st.isFile()) {
				fsyncHooks.onOp?.('fsync-file', abs);
				fsyncFile(abs);
				counts.files++;
			}
		}
		fsyncDir(dir);
		counts.dirs++;
	};
	walk(root);
	return counts;
}

const lstatOrNull = (p) => {
	try {
		return lstatSync(p);
	} catch {
		return null;
	}
};

/**
 * Creates `dir` (and, with `recursive`, every missing ancestor), fsyncing the parent of each directory it creates.
 * Returns the directories it created, outermost first. An existing directory is left alone; a non-directory is an error.
 */
export function makeDir(dir, { mode = 0o777, recursive = false } = {}) {
	const missing = [];
	for (let cur = path.resolve(dir); ; cur = path.dirname(cur)) {
		const st = lstatOrNull(cur);
		if (st) {
			if (!st.isDirectory()) throw Object.assign(new Error(`${missing.length ? 'ENOTDIR' : 'EEXIST'}: ${cur} is not a directory`), { code: missing.length ? 'ENOTDIR' : 'EEXIST' });
			break;
		}
		missing.unshift(cur);
		if (!recursive || path.dirname(cur) === cur) break;
	}
	for (const d of missing) {
		mkdirSync(d, { mode });
		op('mkdir', d);
		fsyncDir(path.dirname(d));
	}
	return missing;
}

/** A fresh private temporary directory under the OS temp directory (its name is durable before it is used). */
export function makeTempDir(prefix) {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	op('mkdir', dir);
	fsyncDir(path.dirname(dir));
	return dir;
}

function writeFd(fd, data) {
	if (typeof data === 'string') data = Buffer.from(data);
	let off = 0;
	while (off < data.length) off += writeSync(fd, data, off, data.length - off);
}

/** Creates a new file (fails when the name exists), fsyncs its data and its directory. */
export function createFile(file, data, mode = 0o600) {
	const fd = openSync(file, 'wx', mode);
	try {
		writeFd(fd, data);
		fsyncFd(fd);
	} finally {
		closeSync(fd);
	}
	chmodSync(file, mode);
	op('create', file);
	fsyncDir(path.dirname(file));
}

/**
 * Replaces `file` with `data` in one rename: a crash leaves the old file or the new one, never a torn one, and the
 * replace is durable (data, then the rename, then the directory) before this returns. `tmp` names the temporary;
 * `beforeTemp(tmp)` runs before it exists (a transaction records it there) and `afterTemp(tmp)` once it is complete,
 * before the rename (a kill there leaves exactly that file).
 */
export function replaceFile(file, data, { mode = 0o644, tmp = `${file}.tmp-${process.pid}`, beforeTemp = null, afterTemp = null } = {}) {
	beforeTemp?.(tmp);
	const fd = openSync(tmp, 'wx', mode);
	try {
		writeFd(fd, data);
		fsyncFd(fd);
	} finally {
		closeSync(fd);
	}
	chmodSync(tmp, mode);
	afterTemp?.(tmp);
	renameSync(tmp, file);
	op('replace', file);
	fsyncDir(path.dirname(file));
}

/** Appends one record (creating the file when needed), fsyncing the data and, when the name is new, its directory. */
export function appendFile(file, data, mode = 0o600) {
	const created = lstatOrNull(file) === null;
	const fd = openSync(file, 'a', mode);
	try {
		writeFd(fd, data);
		fsyncFd(fd);
	} finally {
		closeSync(fd);
	}
	if (created) {
		op('create', file);
		fsyncDir(path.dirname(file));
	}
}

/**
 * An append-only line log (every record ends in "\n") whose last append was cut short ends in a torn fragment. Appending to it
 * would glue the next record onto the fragment and corrupt both, so the file is truncated to its last complete record (data
 * and size fsynced) before anything is appended. Returns the number of bytes dropped; a missing or intact file drops 0.
 */
export function repairTornTail(file) {
	let buf;
	try {
		buf = readFileSync(file);
	} catch {
		return 0;
	}
	const keep = buf.lastIndexOf(0x0a) + 1;
	if (keep === buf.length) return 0;
	truncateSync(file, keep);
	fsyncFile(file);
	op('truncate', file, { keep });
	return buf.length - keep;
}

/** Copies a file (the destination is replaced), fsyncing the data and the directory. */
export function copyFileDurable(from, to) {
	copyFileSync(from, to);
	fsyncFile(to);
	op('create', to);
	fsyncDir(path.dirname(to));
}

/** Removes one file or symlink (never a directory); no error when it is absent. Returns whether it existed. The directory is fsynced either way. */
export function removeFile(file) {
	let existed = true;
	try {
		unlinkSync(file);
	} catch (e) {
		if (e.code !== 'ENOENT') throw e;
		existed = false;
	}
	if (existed) op('unlink', file);
	if (lstatOrNull(path.dirname(file))) fsyncDir(path.dirname(file));
	return existed;
}

/** Removes one empty directory (ENOTEMPTY and ENOENT surface to the caller). */
export function removeDir(dir) {
	rmdirSync(dir);
	op('rmdir', dir);
	fsyncDir(path.dirname(dir));
}

/** Removes a file or a whole tree; no error when it is absent. The parent directory is fsynced after. */
export function removeTree(target) {
	rmSync(target, { recursive: true, force: true });
	op('rmtree', target);
	if (lstatOrNull(path.dirname(target))) fsyncDir(path.dirname(target));
}

/** Renames `from` to `to`, then fsyncs both parent directories (the destination's first). */
export function renamePath(from, to) {
	renameSync(from, to);
	op('rename', to, { from });
	fsyncDir(path.dirname(to));
	if (path.dirname(from) !== path.dirname(to)) fsyncDir(path.dirname(from));
}

/** Sets a directory's or file's permission bits and makes the change durable. */
export function setMode(target, mode) {
	chmodSync(target, mode);
	op('chmod', target);
	fsyncDir(lstatOrNull(target)?.isDirectory() ? target : path.dirname(target));
}
