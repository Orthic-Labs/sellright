#!/usr/bin/env node
// Guarded build entry (plan A D4, §4.6a a; findings C1, C2, C5, C6, C7, C8, C11).
//
//   entry.mjs --config <file> build [--adopt <inventory> --legacy-tag <tag>] [--pull] [--pin <sha>] [--compose-fault <step>]
//   entry.mjs --config <file> activate [--no-restart --smoke-port <p>] [--fault restart|smoke|swap-mid]
//   entry.mjs --config <file> purge [--fault purge]
//   entry.mjs --config <file> deploy [activate and purge flags]
//   entry.mjs --config <file> restore-previous [--no-restart --smoke-port <p>] [--fault restart|smoke|swap-mid]
//   entry.mjs --config <file> resume [--no-restart --smoke-port <p>] [--fault restart|smoke]   (finish an activation or restore whose renames completed)
//   entry.mjs --config <file> recover
//
// One operation per root at a time (kernel-backed lock; `deploy` and every rollback hold it across all their steps).
// The live tree changes only in `activate` and `restore-previous`, by renames, and `activate` renames only after the
// candidate stage, started on its own isolated port, has passed the origin smoke. `build` writes only the stage, the brand repo's compose history and the state directory. A build never
// restarts or purges; a purge only follows a passed origin smoke. Config file: see loadConfig in lib.mjs.
// Exit codes: see EXIT in lib.mjs.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	DeployError,
	EXIT,
	InjectedCrash,
	assertRootRules,
	childEnv,
	clearSmokeChild,
	composeJournalPending,
	killSmokeGroup,
	procStartTicks,
	reapSmokeChild,
	recordSmokeChild,
	sweepStateTemps,
	defaultRun,
	loadConfig,
	logStep,
	makeRunner,
	newStageId,
	newState,
	parseFlags,
	pathsFor,
	readState,
	UNCONFIRMED,
	underLock,
	writeJsonAtomic,
	writeState,
} from './lib.mjs';
import { offendingNames } from './preflight-env.mjs';
import { httpGet, runSmoke } from './origin-smoke.mjs';
import { copyFileDurable, createFile, fsyncTree, makeDir, removeFile } from '../compose/lib/durable.mjs';
import { hashJson } from '../compose/lib/util.mjs';
import { assertTreesReal, carryServer, checkArtifacts, fileSha, removeTree, restoreOps, recoverSwap, runOps, seed, swapOps } from './stage.mjs';

export const ACTIVATE_FAULTS = ['restart', 'smoke', 'swap-mid'];
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ context

/** Default environment-facing behaviour; every member is replaceable so the tests never reach pm2, a CDN or a real server. */
export function defaultDeps() {
	const deps = {
		run: defaultRun,
		env: process.env,
		now: () => new Date(),
		sleep: sleepReal,
		get: httpGet,
		smoke: (base, opts) => runSmoke(base, opts),
		/** `alive()` false means the process this readiness is for has died: whatever answers is not it. */
		async waitReady(url, { timeoutMs, host, alive } = {}) {
			const end = Date.now() + (timeoutMs ?? 15000);
			const up = () => (alive ? alive() : true);
			for (;;) {
				if (!up()) return false;
				try {
					const r = await deps.get(url, { host, timeoutMs: 3000 });
					if (r.status === 200) return up();
				} catch {
					/* not up yet */
				}
				if (Date.now() >= end) return false;
				await deps.sleep(250);
			}
		},
		/** A loopback port nothing listens on, chosen by the kernel. */
		freePort: () =>
			new Promise((resolve, reject) => {
				const s = net.createServer();
				s.once('error', reject);
				s.listen(0, '127.0.0.1', () => {
					const { port } = s.address();
					s.close(() => resolve(port));
				});
			}),
		/**
		 * The server entry on a loopback port, run by a detached supervisor (smoke-supervisor.mjs) that owns it: the supervisor is
		 * its own process group leader, exits with the server, and stops the server when this process dies, so a killed entry
		 * leaves nothing running. `onSpawn({ pid, startTicks })` is called synchronously right after the spawn, before anything
		 * is awaited, so the caller can journal the pid and start time for `recover` before readiness is polled. An occupied
		 * port is refused up front (otherwise readiness could be answered by an unrelated listener), and `alive()` goes false
		 * the moment the child exits so a child that died on startup can never be mistaken for a ready one.
		 */
		async startLocal({ cwd, port, env, inheritFd, onSpawn, parentPollMs = 250 }) {
			await new Promise((resolve, reject) => {
				const probe = net.createServer();
				probe.once('error', (err) => reject(new DeployError(EXIT.FAIL, err.code === 'EADDRINUSE' ? `port ${port} is already in use; refusing to start there` : `port ${port} cannot be probed (${err.code ?? err.message})`)));
				probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
			});
			// the lock descriptor rides along (fd 3, into the supervisor and from there the server): a killed entry leaves the group holding the lock, so nothing can start over its tree
			const supervisor = fileURLToPath(new URL('./smoke-supervisor.mjs', import.meta.url));
			// the candidate and the rehearsal run exactly as pm2 runs production: NODE_ENV=production is not the caller's to drop (the storefront's production-only startup checks key off it)
			env = { ...env, NODE_ENV: 'production' };
			const child = spawn(process.execPath, [supervisor, '--parent', String(process.pid), '--poll', String(parentPollMs), '--', 'node', 'server/entry.express.js'], {
				cwd,
				env,
				detached: true,
				stdio: inheritFd == null ? 'ignore' : ['ignore', 'ignore', 'ignore', inheritFd],
			});
			child.unref();
			let exited = false;
			const gone = new Promise((resolve) => {
				child.once('exit', () => {
					exited = true;
					resolve();
				});
				child.once('error', () => {
					exited = true;
					resolve();
				});
			});
			const pgid = child.pid;
			try {
				onSpawn?.({ pid: pgid, startTicks: procStartTicks(pgid) });
			} catch (e) {
				try {
					process.kill(-pgid, 'SIGKILL');
				} catch {
					/* already gone */
				}
				throw e;
			}
			return {
				pid: pgid,
				alive: () => !exited,
				/** Resolves only once the whole group has exited: SIGTERM first, SIGKILL if anything is still there after `stopTimeoutMs`. Nothing may keep writing into the tree when the swap renames it. */
				async stop(stopTimeoutMs = 5000) {
					if (!exited) {
						try {
							process.kill(-pgid, 'SIGTERM');
						} catch {
							/* already gone */
						}
						const timer = setTimeout(() => {
							try {
								process.kill(-pgid, 'SIGKILL');
							} catch {
								/* already gone */
							}
						}, stopTimeoutMs);
						await gone;
						clearTimeout(timer);
					}
					await killSmokeGroup(pgid, { timeoutMs: stopTimeoutMs });
				},
			};
		},
		async restartProd(ctx) {
			const { pm2 } = ctx.cfg;
			if (!pm2) throw new DeployError(EXIT.USAGE, 'config pm2 is required to restart the production process');
			const info = () => {
				const r = ctx.run('pm2-jlist', ['pm2', 'jlist'], { allowFail: true, detached: true });
				try {
					const proc = JSON.parse(r.stdout).find((x) => x.name === pm2.name);
					return proc ? { status: proc.pm2_env?.status, restarts: proc.pm2_env?.restart_time ?? 0 } : null;
				} catch {
					return null;
				}
			};
			const before = info();
			ctx.run('pm2-restart', ['pm2', 'startOrRestart', pm2.ecosystem, '--only', pm2.name, '--update-env'], { cwd: ctx.paths.live, detached: true });
			const end = Date.now() + (pm2.listenTimeoutMs ?? 15000);
			for (;;) {
				const now = info();
				if (now?.status === 'online' && (before === null || now.restarts > before.restarts)) {
					if (await deps.waitReady(pm2.readyUrl, { timeoutMs: 1000, host: ctx.cfg.smoke.host })) return true;
				}
				if (Date.now() >= end) return false;
				await deps.sleep(250);
			}
		},
	};
	return deps;
}

export function makeContext(cfg, deps = {}) {
	const ctx = { cfg, paths: pathsFor(cfg), deps: { ...defaultDeps(), ...deps } };
	ctx.run = makeRunner(ctx);
	return ctx;
}

const fileExists = (p) => {
	try {
		return lstatSync(p).isFile();
	} catch {
		return false;
	}
};

/** Exit 5 while a compose journal exists or a run was interrupted; the caller holds the lock. */
export function assertIdle(ctx, { allow = [] } = {}) {
	const pending = composeJournalPending(ctx.paths);
	if (pending.length) throw new DeployError(EXIT.RECOVER, `a compose journal is present (${pending.join(', ')}); recover it first`);
	const s = readState(ctx.paths);
	if (s && (s.state === 'building' || s.state === 'activating') && !allow.includes(s.state)) throw new DeployError(EXIT.RECOVER, `state is ${s.state}: a previous run was interrupted; run recover`);
	return s;
}

const save = (ctx, state, patch) => {
	const next = { ...state, ...patch };
	writeState(ctx.paths, next);
	logStep(ctx.paths, 'state', { state: next.state, stageId: next.stageId });
	return next;
};

/**
 * A leftover stage directory may be replaced when the state file accounts for it: the last build failed or was never
 * activated. `stageId` always names the latest build, so after a restore of the previous tree a built-and-never-activated
 * stage (its id is neither live, prev nor failed) is still replaceable rather than blocking every later build.
 */
export function stageReplaceable(state) {
	if (!state) return false;
	if (state.state === 'build-failed' || state.state === 'built') return true;
	const used = [state.live, state.prev, state.failed].map((x) => x?.stageId);
	return !!state.stageId && !used.includes(state.stageId);
}

/**
 * A build (composed or legacy) writes a new state record, which drops the record of the operation in flight. While an
 * activation or restore has finished its renames but never confirmed restart and smoke, that record is what `resume` and the
 * rollback retries work from, so another build is refused (exit 6) until the operation is resumed or restored.
 */
export function assertNoUnfinishedSwap(state) {
	if (isCompletedSwap(state)) throw new DeployError(EXIT.PRECOND, `the ${state.inflight.kind === 'restore' ? 'restored' : 'activated'} tree ${state.live?.stageId} never confirmed its restart and smoke (${state.state}); run resume (or rollback previous) before building: a build now would discard the record of the operation in flight`);
}

const liveName = (s) => (s ? { stageId: s.stageId, source: s.source } : null);

/** Maps a failed compose child's exit status onto the entry's codes. */
function composeFailure(step, err) {
	const map = { 5: EXIT.RECOVER, 6: EXIT.PRECOND, 7: EXIT.ARTIFACT };
	return new DeployError(map[err.status] ?? EXIT.FAIL, err.message.replace(/^[^:]+ failed/, `${step} failed`));
}

// ------------------------------------------------------------------ build

function adoptionChecks(ctx, opts) {
	const { paths: p, cfg } = ctx;
	const managed = fileExists(path.join(p.live, '.compose-managed.json'));
	let liveNames = [];
	try {
		liveNames = readdirSync(p.live);
	} catch {
		throw new DeployError(EXIT.PRECOND, `live tree ${p.live} does not exist`);
	}
	const legacyTree = !managed && liveNames.some((n) => !(n === 'node_modules' || n.startsWith('dist') || n.startsWith('server') || n === '.cache' || n === 'tmp' || n === '.env' || n === '.env.local'));
	if (!opts.adopt && !opts.legacyTag) {
		if (legacyTree) throw new DeployError(EXIT.PRECOND, 'the live tree is unadopted; the one-time command is: build --adopt <inventory.json> --legacy-tag <tag>');
		return null;
	}
	if (!opts.adopt || !opts.legacyTag) throw new DeployError(EXIT.PRECOND, '--adopt and --legacy-tag are given together');
	if (managed) throw new DeployError(EXIT.PRECOND, '--adopt on an already adopted tree is refused');
	let inv;
	try {
		inv = JSON.parse(readFileSync(opts.adopt, 'utf8'));
	} catch {
		throw new DeployError(EXIT.PRECOND, `adoption inventory ${opts.adopt} cannot be read`);
	}
	if (inv.legacyTag !== opts.legacyTag) throw new DeployError(EXIT.PRECOND, `the inventory is for tag ${inv.legacyTag}, not ${opts.legacyTag}`);
	const git = (step, args) => ctx.run(step, ['git', '-C', p.root, ...args], { allowFail: true });
	const dirty = git('git-status', ['status', '--porcelain', '--untracked-files=all', '--', cfg.storeDir]);
	if (dirty.status !== 0 || dirty.stdout.trim() !== '') throw new DeployError(EXIT.PRECOND, `the ${cfg.storeDir} tree has uncommitted or untracked changes; resolve them before adoption`);
	const tagTree = git('git-tag-tree', ['rev-parse', `${opts.legacyTag}:${cfg.storeDir}`]);
	const headTree = git('git-head-tree', ['rev-parse', `HEAD:${cfg.storeDir}`]);
	if (tagTree.status !== 0 || headTree.status !== 0 || tagTree.stdout.trim() !== headTree.stdout.trim()) throw new DeployError(EXIT.PRECOND, `tag ${opts.legacyTag} does not hold the same ${cfg.storeDir} tree as HEAD`);
	return path.resolve(opts.adopt);
}

/** First path segments an incoming commit may never touch: the live tree and its siblings, the state directory and the archives. */
function protectedRoots(cfg) {
	const s = cfg.storeDir;
	return new Set([s, `${s}.next`, `${s}.prev`, `${s}.failed`, `${s}.removed`, '.deploy-state', cfg.legacy.archiveDir.split('/')[0], (cfg.retain?.archiveDir ?? '.deploy-backups').split('/')[0]]);
}

/**
 * `--pull`: fetch, inspect exactly what would arrive, and fast-forward only to the commit that was inspected. A pull
 * would write the incoming tree into the root checkout during the build, before any smoke or swap; an incoming
 * commit that adds or changes a path in the live tree (tracked or not, ignored or not) would change the running
 * site's source, scripts or runtime files in place. Such a commit is refused (exit 6) before anything is merged.
 */
function fastForward(ctx) {
	const { cfg, paths: p } = ctx;
	const git = (step, args, o = {}) => ctx.run(step, ['git', '-C', p.root, ...args], { allowFail: true, ...o });
	if (git('git-fetch', ['fetch', '--quiet']).status !== 0) throw new DeployError(EXIT.PRECOND, 'git fetch failed; nothing was merged');
	const tip = git('git-upstream', ['rev-parse', '--verify', '@{u}']);
	const sha = tip.stdout.trim();
	if (tip.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) throw new DeployError(EXIT.PRECOND, 'the checkout has no upstream commit to fast-forward to');
	if (git('git-ancestor', ['merge-base', '--is-ancestor', 'HEAD', sha]).status !== 0) throw new DeployError(EXIT.PRECOND, `${sha} is not a fast-forward of HEAD`);
	const diff = git('git-diff', ['diff', '--name-only', '--no-renames', '-z', 'HEAD', sha]);
	if (diff.status !== 0) throw new DeployError(EXIT.PRECOND, 'the incoming change set cannot be listed; nothing was merged');
	const roots = protectedRoots(cfg);
	const hit = diff.stdout.split('\0').filter(Boolean).filter((f) => roots.has(f.split('/')[0]));
	if (hit.length) throw new DeployError(EXIT.PRECOND, `--pull is refused: the incoming commit ${sha.slice(0, 12)} changes live or runtime paths (${hit.slice(0, 5).join(', ')}${hit.length > 5 ? ', ...' : ''}) that a build must not write; nothing was merged`);
	ctx.run('git-merge', ['git', '-C', p.root, 'merge', '--ff-only', sha]);
}

/** Runs one compose wrapper call; failures map to the entry's exit codes. */
function compose(ctx, step, args, { env } = {}) {
	const { cfg, paths: p } = ctx;
	const r = ctx.run(step, [...cfg.compose, p.layer, '--out', p.next, ...args], { env, allowFail: true });
	if (r.status !== 0) throw composeFailure(step, Object.assign(new Error(`${step} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().split('\n').slice(-5).join(' | ')}`), { status: r.status }));
	return r;
}

/**
 * `build`, in the order of plan §4.6a a (b1 to b10). One deviation: the `building` state is written when the stage
 * is seeded (b3), not at b8, so an interruption between b3 and b8 is found by the next run instead of leaving an
 * unrecorded stage.
 */
export async function build(ctx, opts = {}) {
	return underLock(ctx, () => buildLocked(ctx, opts));
}

async function buildLocked(ctx, opts) {
	const { cfg, paths: p, deps } = ctx;
	// b1: journal and state checks (the lock is held)
	const prior = assertIdle(ctx);
	assertNoUnfinishedSwap(prior);
	// b2: env preflight on the real environment, then children run under the allowlist
	const bad = offendingNames(deps.env);
	if (bad.length) throw new DeployError(EXIT.ENV, `build environment refused: ${bad.join(', ')}`);
	if (opts.composeFault && cfg.production) throw new DeployError(EXIT.ROOT, '--compose-fault is refused for the production root');
	if (cfg.branch) {
		const b = ctx.run('git-branch', ['git', '-C', p.root, 'rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
		if (b.status !== 0 || b.stdout.trim() !== cfg.branch) throw new DeployError(EXIT.PRECOND, `the root checkout must be on branch ${cfg.branch}`);
		if (opts.pull) {
			fastForward(ctx);
		}
	}
	const adoptFile = adoptionChecks(ctx, opts);

	// b3: seed. Ownership of the stage is recorded first: a failure or kill anywhere from here on leaves a `building`
	// state, which recover turns into build-failed and the next build is allowed to replace.
	if (existsSync(p.next)) {
		if (!stageReplaceable(prior)) throw new DeployError(EXIT.PRECOND, `${p.next} exists and the state file does not mark it build-failed or built-and-never-activated`);
	}
	const stageId = newStageId(deps.now());
	let state = newState({ stageId, state: 'building', prev: prior?.prev ?? null, live: prior?.live ?? null, activations: prior?.activations ?? [] });
	state = save(ctx, state, {});

	try {
		removeTree(p.next, 'leftover stage');
		seed({ live: p.live, stage: p.next, afterCopy: deps.afterSeedCopy });
		// b4: env, generated into the stage; the file is never read here, only its mode
		if (cfg.envGenerator) {
			ctx.run('env-generator', [...cfg.envGenerator, '--source', path.join(p.live, '.env'), '--out', path.join(p.next, '.env')]);
			const st = statSync(path.join(p.next, '.env'));
			if ((st.mode & 0o077) !== 0) throw new DeployError(EXIT.ARTIFACT, 'the generated .env is readable by others (mode must be 0600)');
		}
		// b5: compose into the stage
		const faultEnv = !cfg.production && opts.composeFault ? { COMPOSE_FAULT: opts.composeFault } : {};
		const args = ['--live', p.live, '--apply', ...(adoptFile ? ['--adopt', adoptFile] : []), ...(opts.pin ? ['--pin', opts.pin] : []), ...(faultEnv.COMPOSE_FAULT ? ['--allow-fault'] : [])];
		const applied = compose(ctx, 'compose-apply', args, { env: childEnv(cfg, deps.env, faultEnv) });
		const historyId = /history entry (\S+) \(status applied\)/.exec(applied.stdout)?.[1];
		if (!historyId) throw new DeployError(EXIT.FAIL, 'compose did not report a history entry id');
		// b6: check exactly what the build reads, write build-config.json
		compose(ctx, 'compose-check-build-env', ['--check-build-env']);
		const cfgFile = path.join(p.next, 'build-config.json');
		const buildConfig = JSON.parse(readFileSync(cfgFile, 'utf8'));
		const buildConfigSha = fileSha(cfgFile);
		// the build's own exports: one source (build-exports.json, written by compose beside the hash in build-config.json)
		const exportsEnv = readBuildExports(p.next, buildConfig);
		// b7: frozen install in the stage
		ctx.run('install', cfg.install, { cwd: p.next });
		// b8: marker snapshot, then the guarded build script with the deploy token
		snapshotMarker(ctx);
		state = save(ctx, state, { state: 'building', source: `compose:${historyId}`, buildConfigHash: buildConfig.buildConfigHash, buildConfigSha });
		ctx.run('build', ['bash', path.join(p.next, cfg.buildScript)], { cwd: p.next, env: childEnv(cfg, deps.env, { ...exportsEnv, SELLRIGHT_DEPLOY_STAGE: stageId }) });
		// b9: artifacts
		const art = checkArtifacts({ tree: p.next, buildConfigSha });
		if (!art.ok) throw new DeployError(EXIT.ARTIFACT, `artifact check failed: ${art.problems.join('; ')}`);
		// b10: mark built in the history, then the state
		compose(ctx, 'compose-mark-built', ['--mark-built', '--build-config', cfgFile]);
		state = save(ctx, state, { state: 'built' });
		return { stageId, historyId };
	} catch (e) {
		if (e instanceof InjectedCrash) throw e;
		restoreMarker(ctx);
		save(ctx, state, { state: 'build-failed' });
		if (e instanceof DeployError) throw e;
		throw new DeployError(EXIT.FAIL, e.message);
	}
}

/**
 * The brand's build exports as the environment the build script must receive. Refuses (exit 7) when the values on disk
 * do not hash to the exportsHash recorded in build-config.json, or a name would shadow the allowlist or the token.
 */
function readBuildExports(stage, buildConfig) {
	let doc;
	try {
		doc = JSON.parse(readFileSync(path.join(stage, 'build-exports.json'), 'utf8'));
	} catch {
		throw new DeployError(EXIT.ARTIFACT, 'build-exports.json is missing or unreadable in the stage');
	}
	const map = doc?.exports;
	if (!map || typeof map !== 'object' || Array.isArray(map)) throw new DeployError(EXIT.ARTIFACT, 'build-exports.json has no exports object');
	for (const [k, v] of Object.entries(map)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string') throw new DeployError(EXIT.ARTIFACT, `build export ${JSON.stringify(k)} is not a string under an environment variable name`);
		if (['PATH', 'HOME', 'SELLRIGHT_DEPLOY_STAGE', 'DEPLOY_ROOT'].includes(k)) throw new DeployError(EXIT.ARTIFACT, `build export ${k} would shadow a name the entry owns`);
	}
	if (hashJson(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1))) !== buildConfig.exportsHash) throw new DeployError(EXIT.ARTIFACT, 'build-exports.json does not match the exportsHash recorded in build-config.json');
	return map;
}

function markerPath(ctx) {
	const r = ctx.cfg.retain;
	if (!r) return null;
	const dir = path.join(ctx.paths.root, r.archiveDir ?? '.deploy-backups');
	// the marker is written through this directory: a symlink there would redirect the write out of the root
	let st = null;
	try {
		st = lstatSync(dir);
	} catch {
		/* created by the retention helper */
	}
	if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new DeployError(EXIT.ARTIFACT, `${dir} is not a real directory`);
	return path.join(dir, r.marker);
}

const readJsonFile = (f) => {
	try {
		return JSON.parse(readFileSync(f, 'utf8'));
	} catch {
		return null;
	}
};
/** The identity of the live release a marker snapshot describes. */
const liveId = (ctx) => readState(ctx.paths)?.live?.stageId ?? 'legacy';
/** A snapshot is valid only for the live release it was taken for; one left by an earlier live release is ignored. */
const snapshotValid = (ctx) => readJsonFile(ctx.paths.markerMeta)?.live === liveId(ctx) && (fileExists(ctx.paths.markerBefore) || fileExists(ctx.paths.markerAbsent));

/**
 * Records the retention marker of the live release, presence or absence, before the build that may change it. The
 * snapshot is bound to the live release and kept across retries: a build that changed the marker and then failed or
 * was killed does not turn its own changes into the "live" marker on the next attempt. A retry puts the snapshotted
 * marker back first.
 */
export function snapshotMarker(ctx) {
	const m = markerPath(ctx);
	if (!m) return;
	if (snapshotValid(ctx)) return restoreMarker(ctx);
	const p = ctx.paths;
	for (const f of [p.markerMeta, p.markerBefore, p.markerAbsent]) removeFile(f);
	if (fileExists(m)) copyFileDurable(m, p.markerBefore);
	else createFile(p.markerAbsent, '');
	writeJsonAtomic(p.markerMeta, { live: liveId(ctx) });
}

/** Puts the live release's marker (the valid snapshot) back, including its absence. Without a valid snapshot nothing is touched. */
export function restoreMarker(ctx) {
	const m = markerPath(ctx);
	if (!m || !snapshotValid(ctx)) return;
	if (fileExists(ctx.paths.markerBefore)) copyFileDurable(ctx.paths.markerBefore, m);
	else removeFile(m);
}

/** The live transition committed: the snapshot (it described the release that is now `prev`) is retired. */
function clearMarkerSnapshot(ctx) {
	for (const f of [ctx.paths.markerMeta, ctx.paths.markerBefore, ctx.paths.markerAbsent]) removeFile(f);
}

/** File base of the retained marker of release `id` (a hash: ids are arbitrary strings, `legacy` among them). */
const prevMarkerBase = (ctx, id) => path.join(ctx.paths.markerPrevDir, createHash('sha256').update(String(id)).digest('hex').slice(0, 24));

/**
 * Keeps the marker of the release about to become `prev`, one file per release. An activation only ADDS the file of the
 * release it displaces and never touches the one of the release that is `prev` today: if the swap is interrupted and
 * reversed, that release is `prev` again and its marker is still there. Superseded files are pruned only when a transition
 * commits or is reversed (`pruneMarkers`).
 */
function keepPrevMarker(ctx, prevId) {
	if (!markerPath(ctx) || !snapshotValid(ctx)) return;
	const p = ctx.paths;
	let st = null;
	try {
		st = lstatSync(p.markerPrevDir);
	} catch {
		/* created below */
	}
	if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new DeployError(EXIT.ARTIFACT, `${p.markerPrevDir} is not a real directory`);
	if (!st) makeDir(p.markerPrevDir, { mode: 0o700 });
	const base = prevMarkerBase(ctx, prevId);
	for (const f of [`${base}.json`, `${base}.absent`]) removeFile(f);
	if (fileExists(p.markerBefore)) copyFileDurable(p.markerBefore, `${base}.json`);
	else createFile(`${base}.absent`, '');
}

/** Removes the retained markers of every release except those in `keepIds` (the transition that needed the others has committed or was reversed). */
function pruneMarkers(ctx, keepIds) {
	const keep = new Set(keepIds.filter((x) => x != null).map((id) => path.basename(prevMarkerBase(ctx, id))));
	let names = [];
	try {
		names = readdirSync(ctx.paths.markerPrevDir);
	} catch {
		return;
	}
	for (const n of names) if (!keep.has(n.replace(/\.(json|absent)$/, ''))) removeFile(path.join(ctx.paths.markerPrevDir, n));
}

/** After a restore of the previous tree: its own retention marker replaces the one of the release it displaced. */
function restorePrevMarker(ctx, prevId) {
	const m = markerPath(ctx);
	if (!m) return;
	const base = prevMarkerBase(ctx, prevId);
	if (fileExists(`${base}.json`)) copyFileDurable(`${base}.json`, m);
	else if (fileExists(`${base}.absent`)) removeFile(m);
}

// ------------------------------------------------------------------ activate

/** Retention and server carry-over, before the swap (plan §4.5 "Retention and the swap window"). */
function retention(ctx) {
	const { cfg, paths: p } = ctx;
	if (cfg.retain) {
		restoreMarker(ctx);
		const liveHelper = path.join(p.live, cfg.retain.script);
		if (fileExists(liveHelper)) ctx.run('retain-save', ['node', liveHelper, 'save'], { cwd: p.live });
	}
	const carried = carryServer({ live: p.live, stage: p.next });
	if (carried.collisions.length) {
		restoreMarker(ctx);
		throw new DeployError(EXIT.ARTIFACT, `server files with the same name and different content: ${carried.collisions.join(', ')}`);
	}
	if (cfg.retain) {
		const stageHelper = path.join(p.next, cfg.retain.script);
		if (fileExists(stageHelper)) ctx.run('retain-restore', ['node', stageHelper, 'restore'], { cwd: p.next });
	}
}

/**
 * Starts the tree at `cwd` as this process's own child on a loopback `port`, waits for it (and only it) to answer,
 * runs the origin smoke against it and stops it. Throws DeployError(FAIL) when the child cannot start, dies, or never
 * becomes ready, DeployError(SMOKE) when the smoke fails. `smokeFault` makes the smoke fail without calling it.
 */
async function smokeLocal(ctx, { cwd, port, smokeFault = false }) {
	const { cfg, paths: p, deps } = ctx;
	const base = `http://127.0.0.1:${port}`;
	// the child's pid and start time are journaled (before readiness is awaited) so `recover` can stop it if this process is killed
	const handle = await deps.startLocal({ cwd, port, env: childEnv(cfg, deps.env, { ...cfg.smokeEnv, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1' }), inheritFd: ctx.lockFd, onSpawn: (info) => recordSmokeChild(p, { ...info, port, cwd }) });
	const alive = () => handle?.alive?.() !== false;
	try {
		if (!(await deps.waitReady(`${base}/`, { timeoutMs: cfg.pm2?.listenTimeoutMs ?? 15000, host: cfg.smoke.host, alive }))) {
			throw new DeployError(EXIT.FAIL, alive() ? 'the local process did not become ready' : 'the local process exited during startup');
		}
		if (smokeFault) throw new DeployError(EXIT.SMOKE, 'origin smoke failed (injected)');
		const r = await deps.smoke(base, { host: cfg.smoke.host, paths: cfg.smoke.paths, redirects: cfg.smoke.redirects });
		logStep(p, 'smoke', { ok: r.ok, failed: r.results.filter((x) => !x.ok).map((x) => x.path) });
		if (!alive()) throw new DeployError(EXIT.FAIL, 'the local process exited during the smoke');
		if (!r.ok) throw new DeployError(EXIT.SMOKE, `origin smoke failed: ${r.results.filter((x) => !x.ok).map((x) => `${x.path} (${x.reason ?? x.status})`).join(', ')}`);
	} finally {
		await handle?.stop?.();
		clearSmokeChild(p);
	}
}

/**
 * Before any live rename: the candidate stage runs as its own process on an isolated loopback port and passes the
 * origin smoke, or the activation stops with the live tree untouched. Any failure here is exit 8 and the stage is
 * marked build-failed (its server directory already carries live chunks, so it is rebuilt rather than retried).
 */
async function smokeCandidate(ctx, state) {
	const { paths: p, deps } = ctx;
	try {
		const port = await deps.freePort();
		await smokeLocal(ctx, { cwd: p.next, port });
	} catch (e) {
		if (e instanceof InjectedCrash) throw e;
		restoreMarker(ctx);
		save(ctx, state, { state: 'build-failed' });
		throw new DeployError(EXIT.SMOKE, `the candidate failed its smoke before the swap (${e.message}); the live tree was not touched`);
	}
}

/**
 * Restart (or local start), readiness and origin smoke of the live tree. Returns normally on a pass. Throws
 * DeployError(FAIL) for restart or readiness failure (caller sets activate-failed) and DeployError(SMOKE) for a smoke
 * failure. `fault` simulates one of them without calling anything.
 */
async function bringUp(ctx, { noRestart, smokePort, fault }) {
	const { cfg, paths: p, deps } = ctx;
	if (fault === 'restart') throw new DeployError(EXIT.FAIL, 'restart failed (injected)');
	if (!cfg.production) return smokeLocal(ctx, { cwd: p.live, port: smokePort, smokeFault: fault === 'smoke' });
	const ready = await deps.restartProd(ctx);
	if (!ready) throw new DeployError(EXIT.FAIL, 'the process did not become ready within the listen timeout');
	const base = new URL(cfg.pm2.readyUrl).origin;
	if (fault === 'smoke') throw new DeployError(EXIT.SMOKE, 'origin smoke failed (injected)');
	const r = await deps.smoke(base, { host: cfg.smoke.host, paths: cfg.smoke.paths, redirects: cfg.smoke.redirects });
	logStep(p, 'smoke', { ok: r.ok, failed: r.results.filter((x) => !x.ok).map((x) => x.path) });
	if (!r.ok) throw new DeployError(EXIT.SMOKE, `origin smoke failed: ${r.results.filter((x) => !x.ok).map((x) => `${x.path} (${x.reason ?? x.status})`).join(', ')}`);
}

/** What the state records as live, prev and failed once the pending renames are in effect. */
const afterSwap = (state) => ({
	live: state.pending?.live ?? state.live,
	prev: state.pending ? state.pending.prev : state.prev,
	failed: state.pending?.failed ?? state.failed ?? null,
});

/** Applies the outcome of bringUp to the state file. Returns the resulting state. */
async function settle(ctx, state, opts) {
	// what this operation set out to do was recorded with the swap (`inflight`), so a rerun after a crash resumes the same thing
	const activation = state.inflight;
	if (!activation) throw new DeployError(EXIT.PRECOND, 'the state records no operation in flight to settle');
	// a restore puts the previous release's retention marker back; idempotent, so a resume repeats it safely
	if (activation.kind === 'restore') restorePrevMarker(ctx, activation.stageId);
	const failed = (failState) => {
		const after = afterSwap(state);
		return { ...after, live: { ...after.live, lastState: failState }, pending: null, swap: [] };
	};
	try {
		await bringUp(ctx, opts);
	} catch (e) {
		if (e instanceof InjectedCrash) throw e;
		if (e instanceof DeployError && e.exit === EXIT.SMOKE) {
			save(ctx, state, { state: 'smoke-failed', ...failed('smoke-failed') });
			throw new DeployError(EXIT.SMOKE, `${e.message}. The new tree is live but failed its smoke; run the previous-restore (rollback previous). No purge was issued.`);
		}
		save(ctx, state, { state: 'activate-failed', ...failed('activate-failed') });
		throw e instanceof DeployError ? e : new DeployError(EXIT.FAIL, e.message);
	}
	const after = afterSwap(state);
	// the live transition is committed: the snapshot taken for it has done its job, and only the new `prev`'s retained marker is still needed
	clearMarkerSnapshot(ctx);
	pruneMarkers(ctx, [after.prev?.stageId]);
	return save(ctx, state, {
		state: activation.finalState,
		pending: null,
		swap: [],
		inflight: null,
		inflightBefore: null,
		...after,
		live: { ...after.live, lastState: activation.finalState },
		activations: [...state.activations, { historyId: activation.historyId, stageId: activation.stageId, time: ctx.deps.now().toISOString(), smoke: 'passed', kind: activation.kind, origin: activation.origin ?? null, stageDurable: activation.stageDurable === true }],
	});
}

export async function activate(ctx, opts = {}) {
	return underLock(ctx, () => activateLocked(ctx, opts));
}

async function activateLocked(ctx, opts) {
	const { paths: p } = ctx;
	if (opts.fault && !ACTIVATE_FAULTS.includes(opts.fault)) throw new DeployError(EXIT.USAGE, `--fault must be one of ${ACTIVATE_FAULTS.join(', ')}`);
	assertRootRules(ctx, { restart: !opts.noRestart, smokePort: opts.smokePort, fault: opts.fault, op: 'activate' });
	const state = assertIdle(ctx);
	if (!state || state.state !== 'built') throw new DeployError(EXIT.PRECOND, `activate needs state built, found ${state?.state ?? 'no state file'}`);
	// before the artifact check, any helper or carry-over: a symlinked tree root would redirect all of them
	assertTreesReal(p);
	// a swap moves the live tree to prev and deletes the old prev: never while the live tree is one that never confirmed
	// its restart and smoke, or the last verified release would be the one that is destroyed
	if (UNCONFIRMED.includes(state.live?.lastState)) throw new DeployError(EXIT.PRECOND, `the live tree is in state ${state.live.lastState}: resume it (rollback previous) or restore the previous tree before activating another build; a swap now would delete the last verified release`);
	if (!existsSync(p.next)) throw new DeployError(EXIT.PRECOND, `stage ${p.next} does not exist`);
	const art = checkArtifacts({ tree: p.next, buildConfigSha: state.buildConfigSha });
	if (!art.ok) throw new DeployError(EXIT.ARTIFACT, `artifact recheck failed: ${art.problems.join('; ')}`);
	retention(ctx);
	await smokeCandidate(ctx, state);
	// the whole runnable stage (build output, dependencies, retention results: written by subprocesses, outside durable.mjs) is made durable
	// BEFORE the swap intent is published; the intent records that this happened
	fsyncTree(p.next);

	const oldLive = state.live ?? { stageId: 'legacy', source: 'legacy', lastState: 'unknown' };
	keepPrevMarker(ctx, oldLive.stageId);
	const pending = { live: { stageId: state.stageId, source: state.source }, prev: { ...oldLive } };
	// `target` is the history id a composed rollback was asked for (set by rollback.mjs on the built stage): retries match against it, not against the rebuilt stage's own history id
	const inflight = { kind: 'activate', finalState: 'active', historyId: state.source?.replace(/^[a-z]+:/, ''), stageId: state.stageId, origin: state.source?.split(':')[0] ?? null, target: state.rollbackTarget ?? null, stageDurable: true };
	let st = save(ctx, state, { state: 'activating', swapFrom: 'built', inflightBefore: state.inflight ?? null, inflight, pending, swap: [] });
	runOps({
		p,
		ops: swapOps(p),
		record: (ops) => {
			st = save(ctx, st, { swap: ops.map((o) => ({ ...o })) });
		},
		crashAfter: (op) => {
			if (opts.fault === 'swap-mid' && op === 'live-to-prev') throw new InjectedCrash('swap-mid');
		},
	});
	return settle(ctx, st, opts);
}

// ------------------------------------------------------------------ purge

const PURGEABLE = ['active', 'purged', 'purge-failed', 'restored-previous'];

export async function purge(ctx, opts = {}) {
	return underLock(ctx, () => purgeLocked(ctx, opts));
}

async function purgeLocked(ctx, opts) {
	const { cfg } = ctx;
	if (opts.fault && opts.fault !== 'purge') throw new DeployError(EXIT.USAGE, '--fault must be purge here');
	assertRootRules(ctx, { restart: true, purge: true, fault: opts.fault, op: 'purge' });
	const state = assertIdle(ctx);
	const last = state?.activations?.at(-1);
	if (!state || !PURGEABLE.includes(state.state) || last?.smoke !== 'passed') throw new DeployError(EXIT.PRECOND, `purge needs an active tree whose origin smoke passed (state ${state?.state ?? 'none'})`);
	const fail = (msg) => {
		save(ctx, state, { state: 'purge-failed', live: state.live ? { ...state.live, lastState: 'purge-failed' } : state.live });
		throw new DeployError(EXIT.PURGE, msg);
	};
	if (!cfg.production) return fail('purge failed (injected; nothing was called)');
	if (!cfg.purge) throw new DeployError(EXIT.USAGE, 'config purge is required to purge the production CDN');
	const r = ctx.run('purge', cfg.purge, { allowFail: true, detached: true });
	if (r.status !== 0) return fail(`purge failed (exit ${r.status}); it is safe to rerun`);
	// `activations` is never touched here
	save(ctx, state, { state: 'purged', live: state.live ? { ...state.live, lastState: 'purged' } : state.live });
	return { purged: true };
}

/** `deploy`: build, activate, purge in order; stops at the first failure (which propagates its exit code). */
export async function deploy(ctx, opts = {}) {
	return underLock(ctx, async () => {
		await build(ctx, opts);
		await ctx.deps.checkpoint?.('deploy:after-build');
		await activate(ctx, opts);
		await ctx.deps.checkpoint?.('deploy:after-activate');
		return purge(ctx, { fault: opts.fault === 'purge' ? 'purge' : undefined });
	});
}

/**
 * Resumes an activation whose renames all finished before the process died (recover left it `activate-failed` with
 * the stage already live): restart or local start, readiness and smoke only. Nothing is rebuilt or swapped again, so
 * the retained previous tree stays the original fallback.
 */
export async function resumeActivation(ctx, opts = {}) {
	return underLock(ctx, async () => {
		if (opts.fault && !ACTIVATE_FAULTS.includes(opts.fault)) throw new DeployError(EXIT.USAGE, `--fault must be one of ${ACTIVATE_FAULTS.join(', ')}`);
		assertRootRules(ctx, { restart: !opts.noRestart, smokePort: opts.smokePort, fault: opts.fault, op: 'activate' });
		const state = assertIdle(ctx);
		if (!isCompletedSwap(state)) throw new DeployError(EXIT.PRECOND, 'there is no completed swap to resume');
		assertTreesReal(ctx.paths);
		return settle(ctx, state, opts);
	});
}

/**
 * True when the swap of the operation in flight (an activation or a restore of the previous tree) finished all its
 * renames, so the tree it chose is live, but its restart, readiness or smoke was never confirmed (the process died
 * after the renames, or the check failed). Rerunning that operation must resume it, never swap again.
 */
export const isCompletedSwap = (state) => !!state?.inflight && UNCONFIRMED.includes(state.state) && !state.pending && state.live?.stageId === state.inflight.stageId;

// ------------------------------------------------------------------ restore previous (plan §4.5 procedure 1)

export async function restorePreviousCommand(ctx, opts = {}) {
	return underLock(ctx, () => restoreLocked(ctx, opts));
}

async function restoreLocked(ctx, opts) {
	const { paths: p } = ctx;
	if (opts.fault && !ACTIVATE_FAULTS.includes(opts.fault)) throw new DeployError(EXIT.USAGE, `--fault must be one of ${ACTIVATE_FAULTS.join(', ')}`);
	assertRootRules(ctx, { restart: !opts.noRestart, smokePort: opts.smokePort, fault: opts.fault, op: 'restore-previous' });
	const state = assertIdle(ctx);
	if (!state?.prev) throw new DeployError(EXIT.PRECOND, 'the state file records no previous tree (prev)');
	assertTreesReal(p);
	if (!existsSync(p.prev)) throw new DeployError(EXIT.PRECOND, `${p.prev} does not exist`);
	const art = checkArtifacts({ tree: p.prev });
	if (!art.ok) throw new DeployError(EXIT.ARTIFACT, `the previous tree fails its artifact check: ${art.problems.join('; ')}`);
	const pending = { live: { ...state.prev }, prev: null, failed: liveName(state.live) ?? { stageId: 'unknown', source: 'unknown' } };
	const inflight = { kind: 'restore', finalState: 'restored-previous', historyId: state.prev.source?.replace(/^[a-z]+:/, ''), stageId: state.prev.stageId, origin: state.prev.source?.split(':')[0] ?? null };
	let st = save(ctx, state, { state: 'activating', swapFrom: state.state, inflightBefore: state.inflight ?? null, inflight, pending, swap: [] });
	runOps({
		p,
		ops: restoreOps(p),
		record: (ops) => {
			st = save(ctx, st, { swap: ops.map((o) => ({ ...o })) });
		},
		crashAfter: (op) => {
			if (opts.fault === 'swap-mid' && op === 'live-to-failed') throw new InjectedCrash('swap-mid');
		},
	});
	return settle(ctx, st, opts);
}

// ------------------------------------------------------------------ recover

export async function recover(ctx) {
	// a smoke child left by a killed entry still holds the lock: it is stopped first (only once its recorded parent is gone and its
	// recorded identity matches), then the lock is taken like any operation takes it
	await reapSmokeChild(ctx.paths);
	return underLock(ctx, () => recoverLocked(ctx));
}

/**
 * Completes or reverses a half-done swap from the recorded renames, marks an interrupted build `build-failed`
 * (the stage is kept for inspection), and otherwise writes nothing in the live tree. Never calls pm2.
 */
function recoverLocked(ctx) {
	const { paths: p } = ctx;
	sweepStateTemps(p);
	const state = readState(p);
	if (!state) return { action: 'nothing' };
	if (state.state === 'building') {
		// the build may have changed the shared retention marker: put the live release's back
		restoreMarker(ctx);
		save(ctx, state, { state: 'build-failed' });
		return { action: 'build-failed' };
	}
	if (state.state !== 'activating') return { action: 'nothing' };
	const r = recoverSwap({ p, ops: state.swap });
	if (r.direction === 'completed') {
		const after = afterSwap(state);
		save(ctx, state, { state: 'activate-failed', swap: [], ...after, live: { ...after.live, lastState: 'activate-failed' }, pending: null });
		return { action: 'swap-completed', note: 'the swap finished but readiness and smoke were not confirmed; run rollback previous, or restart the process and verify' };
	}
	// the renames are reversed, so the retention marker (changed by the retention steps) goes back to the live release's too, and the
	// marker kept for the release that would have become `prev` is dropped: the `prev` that is still there keeps its own
	restoreMarker(ctx);
	pruneMarkers(ctx, [state.prev?.stageId]);
	save(ctx, state, { state: state.swapFrom ?? 'built', swap: [], pending: null, inflight: state.inflightBefore ?? null, inflightBefore: null });
	return { action: 'swap-undone', note: 'the renames were reversed; the process was not touched' };
}

// -------------------------------------------------------------------- CLI

export function flagsToOpts(a) {
	const port = a.values.get('--smoke-port');
	return {
		adopt: a.values.get('--adopt'),
		legacyTag: a.values.get('--legacy-tag'),
		pull: a.flags.has('--pull'),
		pin: a.values.get('--pin'),
		composeFault: a.values.get('--compose-fault'),
		noRestart: a.flags.has('--no-restart'),
		smokePort: port === undefined ? undefined : Number(port),
		fault: a.values.get('--fault'),
	};
}

const VALUE_FLAGS = ['--config', '--adopt', '--legacy-tag', '--pin', '--compose-fault', '--smoke-port', '--fault'];
export const COMMANDS = { build, activate, purge, deploy, 'restore-previous': restorePreviousCommand, resume: resumeActivation, recover };

/** Runs one command and returns its exit code (never throws a DeployError). */
export async function runCli(argv, { deps, out = console } = {}) {
	let a;
	try {
		a = parseFlags(argv, VALUE_FLAGS);
		const [cmd] = a.positional;
		if (!a.values.has('--config') || !COMMANDS[cmd]) {
			out.error(`usage: entry.mjs --config <file> (${Object.keys(COMMANDS).join(' | ')}) [flags]`);
			return EXIT.USAGE;
		}
		const cfg = loadConfig(a.values.get('--config'));
		const ctx = makeContext(cfg, deps);
		const opts = flagsToOpts(a);
		if (Number.isNaN(opts.smokePort)) throw new DeployError(EXIT.USAGE, '--smoke-port must be a number');
		const res = await COMMANDS[cmd](ctx, opts);
		out.log(`${cmd}: ok${res?.note ? ` (${res.note})` : ''}`);
		return 0;
	} catch (e) {
		if (e instanceof DeployError) {
			out.error(e.message);
			return e.exit;
		}
		if (e instanceof InjectedCrash) {
			out.error(e.message);
			return 137;
		}
		throw e;
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	runCli(process.argv.slice(2)).then(
		(c) => process.exit(c),
		(e) => {
			console.error(e.stack);
			process.exit(1);
		},
	);
}
