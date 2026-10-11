// Shared pieces of the staged build and swap tools (plan A §4.2, §4.6a): exit codes, config, state file, lock, log,
// command runner, root rules. Node built-ins only; nothing here knows a brand, a path or a URL: every such value
// comes from the config file the caller passes.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { appendFile, fsyncDir, fsyncHooks, makeDir, removeFile, repairTornTail, replaceFile } from '../compose/lib/durable.mjs';
import { LockHeldError, acquireOsLock, holdsInheritedLock } from '../compose/lib/os-lock.mjs';

/** Exit codes of the entry and the rollback script (plan §4.6a "Exit codes"). */
export const EXIT = { OK: 0, FAIL: 1, USAGE: 2, ROOT: 3, ENV: 4, RECOVER: 5, PRECOND: 6, ARTIFACT: 7, SMOKE: 8, PURGE: 9 };

export class DeployError extends Error {
	constructor(exit, message) {
		super(message);
		this.name = 'DeployError';
		this.exit = exit;
	}
}

/** Thrown by a `--fault` point that simulates a killed process: nothing after it runs, no state is tidied. */
export class InjectedCrash extends Error {
	constructor(point) {
		super(`injected crash at ${point}`);
		this.name = 'InjectedCrash';
		this.point = point;
	}
}

/** States in which the stage this operation built is live but its readiness or smoke was never confirmed. */
export const UNCONFIRMED = ['activate-failed', 'smoke-failed'];
export const STATES = ['building', 'built', 'build-failed', 'activating', 'active', 'activate-failed', 'smoke-failed', 'purged', 'purge-failed', 'restored-previous'];
export const STATE_FILE = 'storefront.json';
export const LOG_FILE = 'log.jsonl';
export const MARKER_BEFORE = 'marker-before.json';
/** Present when the retention marker did not exist at snapshot time, so activation restores that absence. */
export const MARKER_ABSENT = 'marker-before.absent';
export const LEGACY_JOURNAL = 'rollback-legacy.json';
/** Names the seed never copies from the live tree, and the runtime paths no tool here touches except the swap. */
export const RUNTIME_NAMES = (n) => n === 'node_modules' || n.startsWith('dist') || n.startsWith('server') || n === '.cache' || n === 'tmp' || n.startsWith('.env') || n === 'build-config.json' || n === 'build-exports.json' || n === 'test-results';

const plainName = (n, what) => {
	if (typeof n !== 'string' || !n || n.includes('/') || n === '.' || n === '..' || n.startsWith('-')) throw new DeployError(EXIT.USAGE, `${what} must be a plain name, got ${JSON.stringify(n)}`);
	return n;
};
const argvOf = (v, what) => {
	if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== 'string' || !x)) throw new DeployError(EXIT.USAGE, `config ${what} must be a non-empty list of strings`);
	return v;
};

/**
 * Config file shape (JSON; every brand value lives here, none in the tools):
 *   root            absolute path of the deploy root (a directory holding the live tree, its stage and the brand layer)
 *   rootEnv         optional name of an environment variable that overrides root (default none)
 *   productionRoot  absolute path; "production" means realpath(root) equals it
 *   storeDir        live tree name under root (default "store"); stage, prev and failed are <name>.next/.prev/.failed
 *   layerDir        brand layer directory name under root (default "storefront")
 *   branch          required git branch of the root checkout, or null
 *   compose         argv prefix of the compose wrapper (layer dir and flags are appended)
 *   envGenerator    argv prefix of the env generator (--source and --out are appended)
 *   install         argv of the frozen install (default pnpm install --frozen-lockfile)
 *   buildScript     path inside the stage of the guarded build script (default scripts/build-production.sh)
 *   retain          { script, archiveDir, marker } of the asset-retention helper, optional
 *   pm2             { ecosystem, name, readyUrl, listenTimeoutMs }, required for production
 *   smoke           { host, paths, redirects }, see origin-smoke.mjs
 *   purge           argv of the CDN purge, production only
 *   envAllow        extra environment names kept for every child (pnpm store variables, for example)
 *   smokeEnv        { NAME: "value" } production runtime configuration given to the candidate and rehearsal servers
 *                   (for example SELLRIGHT_API_URL, which the production start refuses to run without). NODE_ENV, PORT and
 *                   HOST are fixed by the smoke itself and cannot be set here
 *   externals       absolute paths that must exist before a legacy rollback starts
 *   legacy          { archiveDir, clientPath, linkPath }: where captured legacy input records live (default
 *                   ".deploy-backups/legacy-client/<tag>/"), the client closure inside one record, and the
 *                   dependency link in a stage that is repointed to it (see rollback.mjs for the record layout)
 */
export function loadConfig(file, env = process.env) {
	let cfg;
	try {
		cfg = JSON.parse(readFileSync(file, 'utf8'));
	} catch (e) {
		throw new DeployError(EXIT.USAGE, `config ${file} cannot be read as JSON (${e.code ?? e.message})`);
	}
	return normaliseConfig(cfg, env);
}

function smokeEnvOf(v) {
	if (v == null) return {};
	if (typeof v !== 'object' || Array.isArray(v) || Object.entries(v).some(([k, x]) => !/^[A-Z_][A-Z0-9_]*$/.test(k) || typeof x !== 'string')) throw new DeployError(EXIT.USAGE, 'config smokeEnv must map variable names to string values');
	for (const k of ['NODE_ENV', 'PORT', 'HOST']) if (k in v) throw new DeployError(EXIT.USAGE, `config smokeEnv must not set ${k}: the smoke fixes it`);
	return { ...v };
}

export function normaliseConfig(cfg, env = process.env) {
	const rootRaw = (cfg.rootEnv && env[cfg.rootEnv]) || cfg.root;
	if (typeof rootRaw !== 'string' || !path.isAbsolute(rootRaw)) throw new DeployError(EXIT.USAGE, 'config root must be an absolute path');
	let root;
	try {
		root = realpathSync(rootRaw);
	} catch {
		throw new DeployError(EXIT.USAGE, `root ${rootRaw} does not exist`);
	}
	if (typeof cfg.productionRoot !== 'string' || !path.isAbsolute(cfg.productionRoot)) throw new DeployError(EXIT.USAGE, 'config productionRoot must be an absolute path');
	let prodRoot = cfg.productionRoot;
	try {
		prodRoot = realpathSync(prodRoot);
	} catch {
		/* a production root that does not exist here can never equal an existing root */
	}
	const storeDir = plainName(cfg.storeDir ?? 'store', 'storeDir');
	return {
		root,
		production: root === prodRoot,
		storeDir,
		layerDir: plainName(cfg.layerDir ?? 'storefront', 'layerDir'),
		branch: cfg.branch ?? null,
		compose: argvOf(cfg.compose, 'compose'),
		envGenerator: cfg.envGenerator ? argvOf(cfg.envGenerator, 'envGenerator') : null,
		install: cfg.install ? argvOf(cfg.install, 'install') : ['pnpm', 'install', '--frozen-lockfile'],
		buildScript: cfg.buildScript ?? 'scripts/build-production.sh',
		retain: cfg.retain ?? null,
		pm2: cfg.pm2 ?? null,
		smoke: cfg.smoke ?? {},
		purge: cfg.purge ? argvOf(cfg.purge, 'purge') : null,
		envAllow: cfg.envAllow ?? [],
		smokeEnv: smokeEnvOf(cfg.smokeEnv),
		externals: cfg.externals ?? [],
		legacy: {
			archiveDir: cfg.legacy?.archiveDir ?? '.deploy-backups/legacy-client',
			clientPath: cfg.legacy?.clientPath ?? 'sellright/packages/storefront-client',
			linkPath: cfg.legacy?.linkPath ?? 'node_modules/@sellright/storefront-client',
		},
	};
}

/** All paths one operation uses. The stage, prev, failed and removed trees are siblings of the live tree. */
export function pathsFor(cfg) {
	const { root, storeDir } = cfg;
	return {
		root,
		live: path.join(root, storeDir),
		next: path.join(root, `${storeDir}.next`),
		prev: path.join(root, `${storeDir}.prev`),
		failed: path.join(root, `${storeDir}.failed`),
		removed: path.join(root, `${storeDir}.removed`),
		layer: path.join(root, cfg.layerDir),
		brandRepo: root,
		stateDir: path.join(root, '.deploy-state'),
		stateFile: path.join(root, '.deploy-state', STATE_FILE),
		logFile: path.join(root, '.deploy-state', LOG_FILE),
		lockFile: path.join(root, '.deploy-state', 'lock'),
		markerBefore: path.join(root, '.deploy-state', MARKER_BEFORE),
		markerAbsent: path.join(root, '.deploy-state', MARKER_ABSENT),
		markerMeta: path.join(root, '.deploy-state', 'marker-before.meta.json'),
		// the retention marker of each release that may become `prev`, one file per release (see entry.mjs keepPrevMarker)
		markerPrevDir: path.join(root, '.deploy-state', 'marker-prev'),
		smokeChild: path.join(root, '.deploy-state', 'smoke-child.json'),
		legacyJournal: path.join(root, '.deploy-state', LEGACY_JOURNAL),
		// the rollback operation in progress: its kind, target and direction, durable before anything is acted on (rollback.mjs)
		rollbackOp: path.join(root, '.deploy-state', 'rollback-op.json'),
	};
}

// ------------------------------------------------------------------ state, log, lock

export function ensureStateDir(p) {
	let st = null;
	try {
		st = lstatSync(p.stateDir);
	} catch {
		/* created below */
	}
	if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new DeployError(EXIT.PRECOND, `${p.stateDir} is not a real directory`);
	if (!st) makeDir(p.stateDir, { mode: 0o700 });
}

/** Removes `<file>.tmp-<pid>` leftovers of earlier writers (killed between create and rename). The caller holds the operation lock, so none is in use. */
function dropStaleTemps(file) {
	const dir = path.dirname(file);
	const stem = `${path.basename(file)}.tmp-`;
	try {
		for (const n of readdirSync(dir)) if (n.startsWith(stem) && /^\d+$/.test(n.slice(stem.length))) removeFile(path.join(dir, n));
	} catch {
		/* the directory does not exist yet: nothing to drop */
	}
}

function writeSynced(file, text, mode = 0o600) {
	dropStaleTemps(file);
	replaceFile(file, text, { mode, tmp: `${file}.tmp-${process.pid}` });
}

// the directory fsync (and its test hook) live in compose/lib/durable.mjs, the one module that changes the filesystem
export { fsyncDir, fsyncHooks };

export const writeJsonAtomic = (file, value) => writeSynced(file, `${JSON.stringify(value, null, 2)}\n`);
/** Replaces `file` with `text` in one rename (a kill leaves the old file or the new one, never a torn one). */
export const writeTextAtomic = (file, text, mode = 0o644) => writeSynced(file, text, mode);

export function readState(p) {
	let text;
	try {
		text = readFileSync(p.stateFile, 'utf8');
	} catch {
		return null;
	}
	const s = JSON.parse(text);
	if (s.version !== 1 || !STATES.includes(s.state)) throw new DeployError(EXIT.PRECOND, `${p.stateFile} is malformed`);
	return s;
}

/** Only the entry and the rollback script call this. */
export function writeState(p, state) {
	ensureStateDir(p);
	writeJsonAtomic(p.stateFile, { ...state, version: 1 });
}

export function newState(over = {}) {
	return { version: 1, stageId: null, source: null, state: 'built', buildConfigHash: null, swap: [], prev: null, live: null, activations: [], ...over };
}

export function logStep(p, step, data = {}) {
	ensureStateDir(p);
	appendFile(p.logFile, `${JSON.stringify({ at: new Date().toISOString(), step, ...data })}\n`);
}

/**
 * One operation per brand: a kernel-backed lock (compose/lib/os-lock.mjs) that dies with its holder, so there is no
 * stale lock to take over and no second writer can slip in during a takeover. `lock` in the state directory is a
 * diagnostic pid file only. A held lock is exit 5. Resolves to an async release().
 */
export async function takeLock(p) {
	ensureStateDir(p);
	try {
		return await acquireOsLock(p.stateDir, 'lock');
	} catch (e) {
		if (e instanceof LockHeldError) throw new DeployError(EXIT.RECOVER, `${e.message}; another operation may be running`);
		throw e;
	}
}

/**
 * The lock for a standalone command that writes the stage (stage.mjs seed, carry-server): taken like any operation, except
 * when this process runs inside a deployment operation that already holds it (the runner handed it down as fd 3 and it is
 * verified to be this root's lock), in which case nothing is taken twice.
 */
export async function takeLockOrDelegated(p) {
	ensureStateDir(p);
	if (holdsInheritedLock(p.stateDir, 'lock')) return async () => {};
	return takeLock(p);
}

export async function withLock(p, fn) {
	const release = await takeLock(p);
	try {
		return await fn();
	} finally {
		await release();
	}
}

/**
 * Runs `fn` holding the one operation lock of this context's root. A workflow that spans several operations (deploy,
 * every rollback) wraps the whole thing here; the operations inside find the lock already held by this context and run
 * under it, so ownership is never released between build, verification and activation.
 */
export async function underLock(ctx, fn) {
	if (ctx.lockHeld) return fn();
	const release = await takeLock(ctx.paths);
	ctx.lockHeld = true;
	ctx.lockFd = release.fd ?? undefined;
	try {
		// an append-only log cut short by a kill must not have the next record glued onto its fragment
		repairTornTail(ctx.paths.logFile);
		return await fn();
	} finally {
		ctx.lockHeld = false;
		ctx.lockFd = undefined;
		await release();
	}
}

/** Names of unrecovered compose journals in the brand repo (a `.tmp` directory is a begin that changed nothing, a `.done` one a journal already retired). */
export function composeJournalPending(p) {
	try {
		return readdirSync(path.join(p.brandRepo, '.compose-journal')).filter((n) => !n.endsWith('.tmp') && !n.endsWith('.done'));
	} catch {
		return [];
	}
}

// ------------------------------------------------------------------ commands and the root rule

/** Environment every child runs under: an allowlist only (the equivalent of `env -i` plus these names). */
export function childEnv(cfg, parent = process.env, extra = {}) {
	const keep = ['PATH', 'HOME', 'SELLRIGHT_DEPLOY_STAGE', 'DEPLOY_ROOT', ...cfg.envAllow];
	const out = {};
	for (const k of keep) if (parent[k] !== undefined) out[k] = parent[k];
	return { ...out, ...extra };
}

/** The one place an external command starts. Tests replace it; every call is logged without its environment. */
export function defaultRun({ argv, cwd, env, inheritFd }) {
	// `inheritFd` (the operation lock's descriptor) is handed to the child as fd 3 so the lock outlives a killed entry for as long as the child runs
	const r = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: 'utf8', maxBuffer: 1 << 28, ...(inheritFd == null ? {} : { stdio: ['pipe', 'pipe', 'pipe', inheritFd] }) });
	if (r.error) return { status: 127, stdout: '', stderr: String(r.error.message) };
	return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function makeRunner(ctx) {
	// `detached: true` is for the commands that must not carry the lock descriptor (pm2 may start its daemon from them; the CDN purge writes nothing here)
	return (step, argv, { cwd, env, allowFail = false, detached = false } = {}) => {
		const r = ctx.deps.run({ argv, cwd, env: env ?? childEnv(ctx.cfg, ctx.deps.env), inheritFd: detached ? undefined : ctx.lockFd });
		logStep(ctx.paths, step, { argv0: path.basename(argv[0]), status: r.status });
		if (r.status !== 0 && !allowFail) {
			const err = new DeployError(EXIT.FAIL, `${step} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().split('\n').slice(-5).join(' | ')}`);
			err.status = r.status;
			throw err;
		}
		return r;
	};
}

/**
 * Root rule (exit 3, finding C1): on a non-production root a restart, pm2 or purge is refused and `--no-restart` plus
 * `--smoke-port` are required; on the production root those flags and `--fault` are refused.
 */
export function assertRootRules(ctx, { restart, smokePort, fault, purge = false, op }) {
	const { production } = ctx.cfg;
	if (production) {
		if (!restart || smokePort !== undefined || fault) throw new DeployError(EXIT.ROOT, `${op}: --no-restart, --smoke-port and --fault are refused for the production root`);
		return;
	}
	if (purge) {
		if (fault !== 'purge') throw new DeployError(EXIT.ROOT, `${op}: purge is refused for a non-production root`);
		return;
	}
	if (restart) throw new DeployError(EXIT.ROOT, `${op}: a non-production root requires --no-restart and --smoke-port (pm2 and purge are never reached)`);
	if (!Number.isInteger(smokePort) || smokePort <= 0) throw new DeployError(EXIT.ROOT, `${op}: a non-production root requires --smoke-port <port>`);
}

export const newStageId = (now = new Date()) => `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(3).toString('hex')}`;

/** Parses `--flag value` and bare `--flag` arguments. `valueFlags` lists the flags that take a value. */
export function parseFlags(argv, valueFlags) {
	const out = { positional: [], flags: new Set(), values: new Map() };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (valueFlags.includes(a)) {
			if (i + 1 >= argv.length) throw new DeployError(EXIT.USAGE, `${a} needs a value`);
			out.values.set(a, argv[++i]);
		} else if (a.startsWith('--')) out.flags.add(a);
		else out.positional.push(a);
	}
	return out;
}

export const exists = (p) => existsSync(p);

// ------------------------------------------------------------------ the smoke child (review round 3, finding 2)

/** Start time of process `pid` in clock ticks since boot (field 22 of /proc/<pid>/stat), or null when it does not exist. Identifies a process across pid reuse. */
export function procStartTicks(pid) {
	try {
		const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
		return text.slice(text.lastIndexOf(')') + 2).split(' ')[19] ?? null;
	} catch {
		return null;
	}
}

const groupAlive = (pgid) => {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (e) {
		return e.code === 'EPERM';
	}
};
const signalGroup = (pgid, sig) => {
	try {
		process.kill(-pgid, sig);
	} catch {
		/* already gone */
	}
};

/** Journals the smoke child (a detached supervisor: its pid is also its process group id) with the identities that make a later kill safe. Written before readiness is awaited. */
export function recordSmokeChild(p, info) {
	ensureStateDir(p);
	writeJsonAtomic(p.smokeChild, { version: 1, ...info, parentPid: process.pid, parentStartTicks: procStartTicks(process.pid), at: new Date().toISOString() });
}

export function clearSmokeChild(p) {
	removeFile(p.smokeChild);
}

/** Signals a smoke child's whole group and waits until no member is left (SIGKILL after `timeoutMs`). Throws when something survives SIGKILL. */
export async function killSmokeGroup(pgid, { timeoutMs = 5000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
	signalGroup(pgid, 'SIGTERM');
	for (const [sig, ms] of [['SIGKILL', timeoutMs], [null, timeoutMs]]) {
		const end = Date.now() + ms;
		while (groupAlive(pgid) && Date.now() < end) await sleep(20);
		if (!groupAlive(pgid)) return;
		if (sig) signalGroup(pgid, sig);
	}
	throw new DeployError(EXIT.RECOVER, `the smoke child's process group ${pgid} survived SIGKILL`);
}

/**
 * Stops a smoke child left behind by an entry that died (the entry journaled it before waiting for readiness). It only acts
 * on a child whose recorded parent is gone and whose recorded identity still matches: a live parent means the operation is
 * running (nothing is touched; the lock refuses the caller), a pid with another start time means the child is long gone and
 * the pid was reused (the record is dropped, nothing is signalled). Returns { reaped, pid?, note? }.
 */
export async function reapSmokeChild(p, opts = {}) {
	let rec;
	try {
		rec = JSON.parse(readFileSync(p.smokeChild, 'utf8'));
	} catch {
		return { reaped: false };
	}
	if (!Number.isInteger(rec?.pid) || rec.pid <= 1 || typeof rec.startTicks !== 'string') {
		clearSmokeChild(p);
		return { reaped: false, note: 'unreadable smoke child record dropped' };
	}
	if (rec.parentPid && procStartTicks(rec.parentPid) === rec.parentStartTicks) return { reaped: false, note: `the entry (pid ${rec.parentPid}) that started the smoke child is still running` };
	const leader = procStartTicks(rec.pid);
	// a live process with another start time is a reused pid; a missing leader with a living group is the child's own orphaned members (a group id cannot be reused while it has members)
	if (leader !== null && leader !== rec.startTicks) {
		clearSmokeChild(p);
		return { reaped: false, note: 'the recorded pid was reused; nothing signalled' };
	}
	if (!groupAlive(rec.pid)) {
		clearSmokeChild(p);
		return { reaped: false };
	}
	await killSmokeGroup(rec.pid, opts);
	clearSmokeChild(p);
	logStep(p, 'smoke-child-reaped', { pid: rec.pid });
	return { reaped: true, pid: rec.pid };
}

/** Removes leftover `*.tmp-<pid>` files that atomic state writes can leave in the state directory when killed between create and rename. */
export function sweepStateTemps(p) {
	try {
		for (const n of readdirSync(p.stateDir)) if (/\.tmp-\d+$/.test(n)) removeFile(path.join(p.stateDir, n));
	} catch {
		/* no state directory */
	}
}
