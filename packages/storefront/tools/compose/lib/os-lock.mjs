// Kernel-backed mutual exclusion shared by the compose tool and the deploy tools (review finding: stale-lock takeover).
//
// The lock is a Linux abstract-namespace unix socket bound by the holder: bind is atomic, exactly one process can hold
// the name, and the kernel drops it the moment the holder dies, however it dies. There is no stale state to detect,
// so no takeover step to race, and no window between "created" and "owner recorded".
//
// `<dir>/<name>` is a diagnostic file only (the holder's pid, written by rename so it is never torn). It decides
// nothing: a leftover or unreadable file does not block, and a missing one does not admit a second holder. The
// socket name is derived from the realpath of `dir` plus `name`, so every path to the same directory shares one lock.
//
// Ownership follows the process tree: `release.fd` is the listening socket's descriptor. Handing it to a child (a
// spawn `stdio` entry) keeps the name bound until that child, and every descendant that inherited it, has exited, even
// if the holder is killed first. A recovering process then cannot take the lock while a writer is still running.
//
// Linux only (abstract sockets). Anything else throws rather than fall back to a lock that can admit two writers.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { makeDir, removeFile, replaceFile } from './durable.mjs';

export class LockHeldError extends Error {
	constructor(file, holderPid) {
		super(`another operation holds ${file}${holderPid ? ` (pid ${holderPid})` : ''}`);
		this.name = 'LockHeldError';
		this.file = file;
		this.holderPid = holderPid ?? null;
	}
}

const socketName = (dir, name) => `\0sellright-lock:${createHash('sha256').update(`${realpathSync(dir)}\0${name}`).digest('hex').slice(0, 40)}`;

function writeInfo(file) {
	const tmp = `${file}.tmp-${process.pid}`;
	try {
		// the lock is ours, so a `<name>.tmp-<pid>` of an earlier holder killed mid-write is stale
		const stem = `${path.basename(file)}.tmp-`;
		for (const n of readdirSync(path.dirname(file))) if (n.startsWith(stem) && /^\d+$/.test(n.slice(stem.length))) removeFile(path.join(path.dirname(file), n));
		replaceFile(file, JSON.stringify({ pid: process.pid }), { mode: 0o644, tmp });
	} catch {
		removeFile(tmp);
	}
}

function readHolder(file) {
	try {
		const pid = JSON.parse(readFileSync(file, 'utf8')).pid;
		return Number.isInteger(pid) ? pid : null;
	} catch {
		return null;
	}
}

/**
 * Takes the lock `name` in `dir` (which must exist). Resolves to an async release(); rejects with LockHeldError when
 * another holder, in this process or another, has it.
 */
export async function acquireOsLock(dir, name) {
	if (process.platform !== 'linux') throw new Error('the kernel-backed lock needs Linux abstract sockets; refusing to fall back to a weaker lock');
	makeDir(dir, { recursive: true });
	const file = path.join(dir, name);
	const server = net.createServer();
	await new Promise((resolve, reject) => {
		server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new LockHeldError(file, readHolder(file)) : e));
		server.listen(socketName(dir, name), () => {
			server.removeAllListeners('error');
			resolve();
		});
	});
	server.unref();
	writeInfo(file);
	let released = false;
	const release = async () => {
		if (released) return;
		released = true;
		if (readHolder(file) === process.pid) removeFile(file);
		await new Promise((r) => server.close(() => r()));
	};
	// The socket stays bound while ANY process holds a descriptor for it, not only this one. A child that is handed
	// `release.fd` (spawn stdio) therefore keeps the lock after this process is killed, until the child (and everything
	// it started with the descriptor) has exited: the lock is owned by the whole process tree that can still write.
	release.fd = server._handle?.fd ?? null;
	return release;
}

/**
 * True when descriptor `fd` of this process (3 by convention: the runner hands the lock there) is the listening socket
 * bound to the lock `name` in `dir`. This is how a child of an operation proves it runs inside the lock its parent holds
 * (delegation) instead of claiming it: the descriptor's socket inode must appear in /proc/net/unix under exactly that
 * abstract name, so an environment variable or an unrelated open descriptor cannot pose as the lock.
 */
export function holdsInheritedLock(dir, name, fd = 3) {
	if (process.platform !== 'linux') return false;
	try {
		const ino = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/self/fd/${fd}`))?.[1];
		if (!ino) return false;
		const want = `@${socketName(dir, name).slice(1)}`;
		for (const line of readFileSync('/proc/net/unix', 'utf8').split('\n')) {
			const cols = line.trim().split(/\s+/);
			if (cols[6] === ino) return cols[7] === want;
		}
	} catch {
		/* no such descriptor, or no /proc: not delegated */
	}
	return false;
}
