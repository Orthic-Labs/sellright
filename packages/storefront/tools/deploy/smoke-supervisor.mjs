#!/usr/bin/env node
// Supervisor of the candidate/rehearsal server the entry starts for its origin smoke (review round 3, finding 2).
//
//   node smoke-supervisor.mjs --parent <pid> [--poll <ms>] -- <command> [args...]
//
// The entry starts this process detached (its own session and process group, group id = its pid) and journals that pid and
// start time before it waits for readiness. This process runs the server as its child and keeps the lock descriptor
// (fd 3, when open) alive in both. It exits, taking the server with it, as soon as
//   - the server exits (with the server's status), or
//   - its parent is gone: the parent pid no longer exists or this process was reparented. A SIGKILLed entry therefore never
//     leaves a server running, and the lock it handed down is released when the group has exited, or
//   - it is sent SIGTERM (forwarded to the server first, SIGKILL if the server is still there after 5s).
// If this supervisor is itself killed, the server is left in the journaled process group, which `recover` terminates.
import { spawn } from 'node:child_process';
import { fstatSync } from 'node:fs';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const flags = sep === -1 ? argv : argv.slice(0, sep);
const command = sep === -1 ? [] : argv.slice(sep + 1);
const flag = (name) => flags[flags.indexOf(name) + 1];
const parent = Number(flag('--parent'));
const pollMs = Number(flag('--poll') ?? 250);
if (!command.length || !Number.isInteger(parent) || parent <= 1) {
	console.error('usage: smoke-supervisor.mjs --parent <pid> [--poll <ms>] -- <command> [args...]');
	process.exit(2);
}

let hasLockFd = false;
try {
	fstatSync(3);
	hasLockFd = true;
} catch {
	/* no lock descriptor was handed down */
}
const child = spawn(command[0], command.slice(1), { stdio: hasLockFd ? ['ignore', 'ignore', 'ignore', 3] : 'ignore' });
let stopping = false;

const parentAlive = () => {
	if (process.ppid !== parent) return false;
	try {
		process.kill(parent, 0);
		return true;
	} catch (e) {
		return e.code === 'EPERM';
	}
};

function stop() {
	if (stopping) return;
	stopping = true;
	child.kill('SIGTERM');
	setTimeout(() => {
		child.kill('SIGKILL');
		process.exit(1);
	}, 5000).unref();
}

child.once('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.once('error', () => process.exit(127));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
if (pollMs > 0) {
	const timer = setInterval(() => {
		if (!parentAlive()) stop();
	}, pollMs);
	if (!parentAlive()) stop();
	void timer;
}
