#!/usr/bin/env node
// Guarded rollback script (plan A §4.5, §4.6a e; findings C1, C4, C8, C9). Three manual procedures, none automatic:
//
//   rollback.mjs --config <file> previous              restore the previous tree: swap back, no rebuild
//   rollback.mjs --config <file> composed [<history-id>]   restore the inputs of a history entry, rebuild into a stage, verify hashes, activate
//   rollback.mjs --config <file> legacy                build the legacy tag in a stage from captured inputs, no compose
//         every mode: [--no-restart --smoke-port <p>] [--fault <point>] [--pin <sha>]
//
// Every mode drives the entry's own steps (restore-previous / build / activate / purge), passes the flags through, and
// follows the same root rule: a non-production root requires --no-restart and --smoke-port, starts its own process
// on that port and never reaches pm2 or the CDN purge (a purge is only attempted there with `--fault purge`, which
// records purge-failed without calling anything).
//
// Legacy input record, as captured by the operator before adoption, under <root>/<legacy.archiveDir>/<tag>/:
//   legacy-input.json   { tag, commit, node, pnpm, files: { "<path under the store dir>": "<sha256>", ... } }
//   closure.json        { files: { "<path under this directory>": "<sha256>", ... } } for the client closure
//   <legacy.clientPath>/  the self-contained client the legacy tree's dependency link resolves to
// The legacy adoption record is <brand repo>/.compose-history/compose-adoption.json (legacyCommit).
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDir, makeTempDir, removeFile, removeTree as removeTempTree } from '../compose/lib/durable.mjs';
import { DeployError, EXIT, InjectedCrash, assertRootRules, loadConfig, logStep, newStageId, newState, parseFlags, readState, underLock, writeJsonAtomic, writeState, writeTextAtomic } from './lib.mjs';
import { ACTIVATE_FAULTS, activate, assertIdle, assertNoUnfinishedSwap, build, flagsToOpts, isCompletedSwap, makeContext, purge, restoreMarker, restorePreviousCommand, resumeActivation, snapshotMarker, stageReplaceable } from './entry.mjs';
import { checkArtifacts, removeTree } from './stage.mjs';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const HISTORY_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{12}(-\d+)?$/;
const HASH_KEYS = ['pin', 'overlayTree', 'manifest', 'lock', 'publicConfig'];

const stepFlags = (opts) => ({ noRestart: opts.noRestart, smokePort: opts.smokePort, fault: ACTIVATE_FAULTS.includes(opts.fault) ? opts.fault : undefined });

/** The purge step of a rollback: always on production, on a non-production root only as the injected failure. */
async function purgeStep(ctx, opts) {
	if (ctx.cfg.production) return purge(ctx, {});
	if (opts.fault === 'purge') return purge(ctx, { fault: 'purge' });
	return { purged: false, note: 'non-production root: purge not reached' };
}

function checkFault(opts) {
	if (opts.fault && !ACTIVATE_FAULTS.includes(opts.fault) && opts.fault !== 'purge') throw new DeployError(EXIT.USAGE, `--fault must be one of ${[...ACTIVATE_FAULTS, 'purge'].join(', ')}`);
}

/**
 * Refuse before any step runs, so nothing is written when the root rule is broken (exit 3). `--fault purge` is the
 * one fault that is judged apart from the activation flags: it only exists on a non-production root.
 */
function rootRuleUpFront(ctx, opts, op) {
	checkFault(opts);
	if (opts.fault === 'purge') {
		if (ctx.cfg.production) throw new DeployError(EXIT.ROOT, `${op}: --fault is refused for the production root`);
		assertRootRules(ctx, { restart: !opts.noRestart, smokePort: opts.smokePort, fault: undefined, op });
		return;
	}
	assertRootRules(ctx, { restart: !opts.noRestart, smokePort: opts.smokePort, fault: opts.fault, op });
}

// ------------------------------------------------------------------ the operation record

// A rollback records WHAT it is doing (kind, target, direction) in `.deploy-state/rollback-op.json` before it acts, and
// removes the record only once the whole operation (swap, smoke and purge) is finished. Every later invocation of the same
// kind resumes that recorded operation: it never selects a target again, rebuilds, or swaps a second time, whichever step
// (restart, smoke, purge) failed. Once the swap is committed, the stages' ids in the state say where the operation stands.
//
//   { version: 1, kind: 'previous' | 'composed' | 'legacy', direction: 'to-previous' | 'to-history' | 'to-legacy-tag',
//     target, from, stageId, createdAt }
//   target   previous: the stage id restored; composed: the history id; legacy: the tag
//   from     the live stage id when the operation was recorded (null when there was none)
//   stageId  the stage this operation put (or will put) live: previous: the restored stage; composed and legacy: set once built

const DIRECTION = { previous: 'to-previous', composed: 'to-history', legacy: 'to-legacy-tag' };

function readOp(ctx) {
	let text;
	try {
		text = readFileSync(ctx.paths.rollbackOp, 'utf8');
	} catch {
		return null;
	}
	try {
		const op = JSON.parse(text);
		if (op?.version === 1 && DIRECTION[op.kind] && typeof op.target === 'string') return op;
	} catch {
		/* reported below */
	}
	throw new DeployError(EXIT.PRECOND, `${ctx.paths.rollbackOp} is unreadable; it records the rollback in progress: the owner decides (nothing was changed)`);
}

const writeOp = (ctx, op) => writeJsonAtomic(ctx.paths.rollbackOp, op);
const clearOp = (ctx) => removeFile(ctx.paths.rollbackOp);
const liveStage = (state) => state?.live?.stageId ?? null;

/** The swap of this operation is committed: its stage is the live one. */
const opSwapped = (op, state) => !!op.stageId && liveStage(state) === op.stageId;

/**
 * Decides what an invocation of `kind` does about the recorded operation. Returns { op, resume }.
 *  - a committed operation of the same kind is resumed (an explicit target that differs is refused, exit 6: it would reverse or
 *    replace the unfinished operation);
 *  - a committed operation of another kind blocks composed and legacy (finish it first), and is superseded by `previous`
 *    (the documented way back from any unconfirmed tree);
 *  - an uncommitted record of the same kind (the process died before the swap, or recovery undid it) is reused for the same
 *    target while the live tree is still the one it was recorded against; any other uncommitted or stale record is replaced.
 * No record is written here for a fresh `previous`/`composed` whose target is chosen by the caller (see `beginOp`).
 */
function claimOp(ctx, kind, wanted) {
	const state = readState(ctx.paths);
	const op = readOp(ctx);
	if (!op) return { op: null, resume: false, state };
	if (opSwapped(op, state)) {
		if (op.kind === kind) {
			if (wanted && wanted !== op.target) throw new DeployError(EXIT.PRECOND, `the live tree ${liveStage(state)} is an unfinished ${kind} rollback to ${op.target} (${state.state}): finish it first (rerun it without a target, or name ${op.target}); nothing was rebuilt and its record is intact`);
			return { op, resume: true, state };
		}
		if (kind !== 'previous') throw new DeployError(EXIT.PRECOND, `the live tree ${liveStage(state)} is an unfinished ${op.kind} rollback to ${op.target} (${state.state}): finish it first (rerun it) or run rollback previous; nothing was changed`);
		return { op: null, resume: false, state };
	}
	const unchanged = (op.from ?? null) === liveStage(state);
	const sameTarget = !wanted || wanted === op.target;
	if (op.kind === kind && unchanged && sameTarget && (kind !== 'previous' || state?.prev?.stageId === op.target)) return { op, resume: false, state };
	return { op: null, resume: false, state };
}

/** Records a fresh operation durably, before anything is restored, built or swapped. */
function beginOp(ctx, kind, target, stageId = null) {
	const op = { version: 1, kind, direction: DIRECTION[kind], target, from: liveStage(readState(ctx.paths)), stageId, createdAt: ctx.deps.now().toISOString() };
	writeOp(ctx, op);
	return op;
}

/**
 * The tail of a committed operation: finish an unconfirmed swap (restart and smoke only), then purge, then retire the record.
 * A settled tree whose purge failed (or whose purge never ran) is only purged: nothing is rebuilt, selected or swapped.
 */
async function finishCommitted(ctx, op, opts) {
	const state = readState(ctx.paths);
	if (isCompletedSwap(state)) await resumeActivation(ctx, stepFlags(opts));
	else {
		const last = state.activations?.at(-1);
		if (!['active', 'purged', 'purge-failed', 'restored-previous'].includes(state.state) || last?.stageId !== op.stageId || last?.smoke !== 'passed') {
			throw new DeployError(EXIT.PRECOND, `the ${op.kind} rollback to ${op.target} is committed but the state ${state.state} does not allow finishing it automatically; nothing was changed`);
		}
	}
	const res = readState(ctx.paths).state === 'purged' ? { purged: true } : await purgeStep(ctx, opts);
	clearOp(ctx);
	return res;
}

// ------------------------------------------------------------------ 1. previous

export async function rollbackPrevious(ctx, opts = {}) {
	rootRuleUpFront(ctx, opts, 'previous');
	return underLock(ctx, async () => {
		const claimed = claimOp(ctx, 'previous', null);
		if (claimed.resume) return finishCommitted(ctx, claimed.op, opts);
		const state = claimed.state;
		// a restore recorded by the entry's own restore-previous (no record here) whose renames finished is finished, not repeated:
		// there is no previous tree left to swap in, and the one that is live is the one the restore chose
		if (isCompletedSwap(state) && state.inflight.kind === 'restore') {
			await resumeActivation(ctx, stepFlags(opts));
			return purgeStep(ctx, opts);
		}
		// recorded before anything is acted on; a state without a previous tree is refused by the restore itself, with nothing recorded
		let op = claimed.op;
		if (!op && state?.prev?.stageId) op = beginOp(ctx, 'previous', state.prev.stageId, state.prev.stageId);
		await restorePreviousCommand(ctx, stepFlags(opts));
		const res = await purgeStep(ctx, opts);
		if (op) clearOp(ctx);
		return res;
	});
}

// ------------------------------------------------------------------ 2. composed

/** Newest activation whose smoke passed, other than the active one and other than a restore. */
export function pickComposedTarget(state) {
	const active = state?.live?.stageId;
	// a legacy activation also records kind 'activate' and its tag as historyId: only compose-history ids qualify
	const c = (state?.activations ?? []).filter((a) => a.kind === 'activate' && a.smoke === 'passed' && a.stageId !== active && a.historyId && a.origin !== 'legacy' && HISTORY_ID_RE.test(a.historyId));
	return c.at(-1)?.historyId ?? null;
}

const readHistoryMeta = (ctx, id) => {
	const f = path.join(path.dirname(ctx.paths.layer), '.compose-history', id, 'meta.json');
	try {
		return JSON.parse(readFileSync(f, 'utf8'));
	} catch {
		throw new DeployError(EXIT.PRECOND, `history entry ${id} has no readable meta.json`);
	}
};

/**
 * One lock across the whole procedure: restore, rebuild, hash verification, activation and purge all run under the
 * ownership taken here, so no other invocation can replace the verified stage between those steps.
 */
export async function rollbackComposed(ctx, historyId, opts = {}) {
	rootRuleUpFront(ctx, opts, 'composed');
	return underLock(ctx, () => rollbackComposedLocked(ctx, historyId, opts));
}

async function rollbackComposedLocked(ctx, historyId, opts) {
	const { cfg, paths: p } = ctx;
	// a state written before the record existed: an unfinished rollback of this very kind names its target in the in-flight record
	const now = readState(p);
	if (!readOp(ctx) && isCompletedSwap(now) && now.inflight.kind === 'activate' && now.inflight.target) {
		writeOp(ctx, { version: 1, kind: 'composed', direction: DIRECTION.composed, target: now.inflight.target, from: now.prev?.stageId ?? null, stageId: now.inflight.stageId, createdAt: ctx.deps.now().toISOString() });
	}
	const claimed = claimOp(ctx, 'composed', historyId);
	// this very rollback already swapped its rebuilt stage in: resume it (restart and smoke, then purge only), never select a target
	// again, rebuild or swap a second time (that would replace the retained fallback, or reverse the rollback)
	if (claimed.resume) return finishCommitted(ctx, claimed.op, opts);
	if (isCompletedSwap(now)) throw new DeployError(EXIT.PRECOND, `the live tree ${now.live?.stageId} is an unfinished ${now.inflight.kind} (${now.state}): finish it first (rerun it, or resume / rollback previous); nothing was rebuilt and its record is intact`);
	let op = claimed.op;
	const id = op?.target ?? historyId ?? pickComposedTarget(now);
	if (!id) throw new DeployError(EXIT.PRECOND, 'no earlier activation with a passed smoke to roll back to; name a history id');
	if (!HISTORY_ID_RE.test(id)) throw new DeployError(EXIT.USAGE, `${JSON.stringify(id)} is not a history entry id`);
	const meta = readHistoryMeta(ctx, id);
	if (meta.status !== 'built') throw new DeployError(EXIT.PRECOND, `history entry ${id} has status ${meta.status}, not built`);
	// the target and direction are durable before the inputs are restored: every retry from here on resumes THIS operation
	if (!op) op = beginOp(ctx, 'composed', id);

	// (1) restore the inputs: the whole brand layer directory, hashes verified by the compose tool
	assertIdle(ctx);
	const r = ctx.run('compose-restore-inputs', [...cfg.compose, p.layer, '--restore-inputs', id], { allowFail: true });
	if (r.status !== 0) throw new DeployError(r.status === 5 ? EXIT.RECOVER : r.status === 7 ? EXIT.ARTIFACT : EXIT.FAIL, `restoring the inputs of ${id} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}`);
	const pin = opts.pin ?? /--pin ([0-9a-f]{40})/.exec(r.stdout)?.[1];

	// (2) build the restored inputs into a fresh stage (never --adopt)
	await build(ctx, { pin });
	// the requested target, kept with the built stage: an activation of it records it, so a retry after a failed restart or smoke finds it
	writeState(p, { ...readState(p), rollbackTarget: id });
	// the built stage is the one this operation will put live: its id is what tells a retry that the swap is committed
	writeOp(ctx, { ...op, stageId: readState(p).stageId });
	await ctx.deps.checkpoint?.('composed:after-build');

	// (3) before activation: the stage must carry exactly the recorded hashes (C8)
	const report = JSON.parse(readFileSync(path.join(p.next, 'compose-report.json'), 'utf8'));
	const config = JSON.parse(readFileSync(path.join(p.next, 'build-config.json'), 'utf8'));
	const diffs = HASH_KEYS.filter((k) => report.hashes?.[k] !== meta.hashes?.[k]);
	if (!meta.buildConfigHash) diffs.push('buildConfigHash (not recorded in the history entry)');
	else if (config.buildConfigHash !== meta.buildConfigHash) diffs.push('buildConfigHash');
	if (diffs.length) throw new DeployError(EXIT.ARTIFACT, `the rebuilt stage differs from history entry ${id} (${diffs.join(', ')}); the live tree is untouched, report to the owner before activating`);
	await ctx.deps.checkpoint?.('composed:after-verify');

	// (4) activate, (5) purge
	await activate(ctx, stepFlags(opts));
	const res = await purgeStep(ctx, opts);
	clearOp(ctx);
	return res;
}

// ------------------------------------------------------------------ 3. legacy

const readJsonOr = (f, what, exit = EXIT.PRECOND) => {
	try {
		return JSON.parse(readFileSync(f, 'utf8'));
	} catch {
		throw new DeployError(exit, `${what} cannot be read (${f})`);
	}
};

const insideDir = (root, x) => x === root || x.startsWith(`${root}${path.sep}`);

/**
 * The captured closure must be self-contained, and every byte the installation and the build will read from it is
 * checked. Nothing is followed blindly: each directory entry under the closure is lstat-ed, a symlink anywhere in it
 * (the client's own node_modules included) must resolve to a real path inside the closure, a special file is refused, and
 * every regular file reachable from the client directory, symlinks followed, must be listed in closure.json under its real
 * path (an unlisted file would be installed unverified). Each listed path is then walked component by component with lstat (no component may be a symlink) before
 * its bytes are read and hashed. Returns a description of the first problem, or null.
 */
export function closureProblem({ recDir, clientDir, files }) {
	let realRec;
	try {
		if (!lstatSync(recDir).isDirectory()) return `the closure directory ${recDir} is not a real directory`;
		realRec = realpathSync(recDir);
		if (!insideDir(realRec, realpathSync(clientDir))) return `the client directory ${clientDir} resolves outside the closure`;
	} catch {
		return `the closure directory ${recDir} or its client directory cannot be read`;
	}
	const listed = new Set(Object.keys(files));
	let problem = null;
	const visit = (dirAbs, rel) => {
		for (const name of readdirSync(dirAbs).sort()) {
			if (problem) return;
			const abs = path.join(dirAbs, name);
			const r = rel ? `${rel}/${name}` : name;
			const st = lstatSync(abs);
			if (st.isSymbolicLink()) {
				let target;
				try {
					target = realpathSync(abs);
				} catch {
					problem = `closure entry ${r} is a symlink that does not resolve`;
					return;
				}
				if (!insideDir(realRec, target)) problem = `closure entry ${r} is a symlink that resolves outside the closure`;
			} else if (st.isDirectory()) visit(abs, r);
			else if (!st.isFile()) problem = `closure entry ${r} is a special file`;
		}
	};
	try {
		visit(recDir, '');
		if (!problem) problem = unlistedReachable(realRec, realpathSync(clientDir), listed);
	} catch (e) {
		return `the closure cannot be read (${e.code ?? e.message})`;
	}
	if (problem) return problem;
	for (const [rel, want] of Object.entries(files)) {
		const parts = rel.split('/');
		if (path.isAbsolute(rel) || parts.some((x) => x === '' || x === '.' || x === '..')) return `closure.json lists an unsafe path ${rel}`;
		let cur = recDir;
		for (const [i, part] of parts.entries()) {
			cur = path.join(cur, part);
			let st;
			try {
				st = lstatSync(cur);
			} catch {
				return `closure file ${rel} is missing`;
			}
			if (st.isSymbolicLink()) return `closure file ${rel} goes through a symlink (${parts.slice(0, i + 1).join('/')})`;
			if (i < parts.length - 1 ? !st.isDirectory() : !st.isFile()) return `closure file ${rel} is not a regular file`;
		}
		if (sha(readFileSync(cur)) !== want) return `closure file ${rel} does not match closure.json`;
	}
	return null;
}

/**
 * Every regular file the installation can reach from the client directory, symlinks followed (a dependency link into
 * another directory of the closure included), must be listed in closure.json under its real path relative to the
 * closure; an unlisted one would be installed or run unverified. Returns the first unlisted file's description, or null.
 */
function unlistedReachable(realRec, realClient, listed) {
	const seen = new Set();
	const walk = (realDir) => {
		if (seen.has(realDir)) return null;
		seen.add(realDir);
		for (const name of readdirSync(realDir).sort()) {
			const abs = path.join(realDir, name);
			const real = realpathSync(abs);
			if (!insideDir(realRec, real)) return `closure entry ${path.relative(realRec, abs)} resolves outside the closure`;
			const st = lstatSync(real);
			const rel = path.relative(realRec, real).split(path.sep).join('/');
			if (st.isDirectory()) {
				const inner = walk(real);
				if (inner) return inner;
			} else if (!st.isFile()) return `closure entry ${rel} is a special file`;
			else if (!listed.has(rel)) return `closure file ${rel} is reachable from the client but not listed in closure.json`;
		}
		return null;
	};
	return walk(realClient);
}

/** V: validation, before anything is written. Every failure exits before a stage exists. */
function validateLegacy(ctx, tag, { resuming }) {
	const { cfg, paths: p } = ctx;
	assertIdle(ctx, { allow: resuming ? ['building'] : [] });
	const adoption = readJsonOr(path.join(path.dirname(p.layer), '.compose-history', 'compose-adoption.json'), 'the adoption record');
	const recDir = path.join(p.root, cfg.legacy.archiveDir, tag);
	const record = readJsonOr(path.join(recDir, 'legacy-input.json'), 'the legacy input record');
	const closure = readJsonOr(path.join(recDir, 'closure.json'), 'the closure manifest');

	const commit = ctx.run('git-tag-commit', ['git', '-C', p.root, 'rev-parse', '--verify', `${tag}^{commit}`], { allowFail: true });
	if (commit.status !== 0 || commit.stdout.trim() !== adoption.legacyCommit) throw new DeployError(EXIT.PRECOND, `tag ${tag} does not resolve to the adoption record's legacy commit`);
	if (record.commit !== adoption.legacyCommit || record.tag !== tag) throw new DeployError(EXIT.PRECOND, 'the legacy input record is for another tag or commit');

	const tmp = makeTempDir('legacy-validate-');
	try {
		const tar = path.join(tmp, 'tree.tar');
		ctx.run('git-archive', ['git', '-C', p.root, 'archive', '--format=tar', '-o', tar, tag, cfg.storeDir]);
		ctx.run('tar-extract', ['tar', '-xf', tar, '-C', tmp]);
		for (const [rel, want] of Object.entries(record.files ?? {})) {
			const f = path.join(tmp, cfg.storeDir, rel);
			if (!existsSync(f) || sha(readFileSync(f)) !== want) throw new DeployError(EXIT.ARTIFACT, `${rel} of tag ${tag} does not match the legacy input record`);
		}
	} finally {
		removeTempTree(tmp);
	}
	const clientDir = path.join(recDir, cfg.legacy.clientPath);
	const found = closureProblem({ recDir, clientDir, files: closure.files ?? {} });
	if (found) throw new DeployError(EXIT.ARTIFACT, found);
	const node = ctx.run('node-version', ['node', '--version'], { allowFail: true }).stdout.trim();
	const pnpm = ctx.run('pnpm-version', ['pnpm', '--version'], { allowFail: true }).stdout.trim();
	if (node !== record.node || pnpm !== record.pnpm) throw new DeployError(EXIT.PRECOND, `node/pnpm versions (${node}, ${pnpm}) differ from the recorded ones (${record.node}, ${record.pnpm}); the owner decides`);
	for (const x of cfg.externals) if (!existsSync(x)) throw new DeployError(EXIT.PRECOND, `required external ${x} does not exist`);
	return { recDir, clientDir, files: closure.files ?? {} };
}

const journalRead = (ctx) => {
	try {
		return JSON.parse(readFileSync(ctx.paths.legacyJournal, 'utf8'));
	} catch {
		return null;
	}
};

/** True when the extraction produced a tree with a parseable package.json (only checked after the extraction command returned). */
function stageExtracted(dir) {
	try {
		return typeof JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) === 'object';
	} catch {
		return false;
	}
}

/** Journaled build steps, in order. `link` precedes `install`: pnpm resolves the dependency link while it installs. */
const LEGACY_STEPS = ['stage', 'env', 'link', 'install', 'build', 'artifacts'];

/** B: build the tag in a stage. Each completed step is journaled outside every build directory; a rerun rechecks them. */
async function buildLegacy(ctx, tag, closure) {
	const { cfg, paths: p, deps } = ctx;
	let state = readState(p);
	assertNoUnfinishedSwap(state);
	let journal = journalRead(ctx);
	const resumable = journal?.tag === tag && !journal.done && !!state?.stageId && journal.stageId === state.stageId && state?.state === 'building' && state.source === `legacy:${tag}` && existsSync(p.next);
	if (!resumable) journal = null;

	const verify = {
		stage: () => stageExtracted(p.next),
		env: () => !cfg.envGenerator || existsSync(path.join(p.next, '.env')),
		link: () => manifestLinkOk(p, cfg, closure) && lockLinkOk(p, closure),
		install: () => existsSync(path.join(p.next, 'node_modules')) && linkOk(p, cfg, closure),
		build: () => checkArtifacts({ tree: p.next }).ok,
		artifacts: () => checkArtifacts({ tree: p.next }).ok,
	};
	const done = new Set();
	for (const s of journal?.completed ?? []) {
		if (!verify[s]?.()) break;
		done.add(s);
	}
	const mark = (s) => {
		done.add(s);
		writeJsonAtomic(p.legacyJournal, { version: 1, tag, stageId: state.stageId, completed: [...done] });
		logStep(p, 'legacy-step', { step: s });
	};

	if (!done.has('stage')) {
		const prior = readState(p);
		if (existsSync(p.next)) {
			const reusable = stageReplaceable(prior) || (prior && resumable && !done.size);
			if (!reusable) throw new DeployError(EXIT.PRECOND, `${p.next} exists and the state file does not allow replacing it`);
			removeTree(p.next, 'leftover stage');
		}
		const stageId = newStageId(deps.now());
		state = newState({ stageId, source: `legacy:${tag}`, state: 'building', prev: prior?.prev ?? null, live: prior?.live ?? null, activations: prior?.activations ?? [] });
		writeState(p, state);
		// the journal of this stage exists before anything is extracted: a stale journal of an earlier stage can never describe it
		writeJsonAtomic(p.legacyJournal, { version: 1, tag, stageId, completed: [] });
		// the legacy build script restores the shared retention marker as a side effect: capture what is live now, for this stage, first
		snapshotMarker(ctx);
		const tmp = makeTempDir('legacy-stage-');
		try {
			const tar = path.join(tmp, 'tree.tar');
			ctx.run('git-archive', ['git', '-C', p.root, 'archive', '--format=tar', '-o', tar, tag, cfg.storeDir]);
			makeDir(p.next, { mode: 0o755 });
			ctx.run('tar-extract', ['tar', '-xf', tar, '-C', p.next, '--strip-components=1']);
		} finally {
			removeTempTree(tmp);
		}
		if (!stageExtracted(p.next)) throw new DeployError(EXIT.ARTIFACT, `the extracted tree of ${tag} has no readable package.json`);
		mark('stage');
	}
	const fail = (e) => {
		if (e instanceof InjectedCrash) throw e;
		restoreMarker(ctx);
		writeState(p, { ...state, state: 'build-failed' });
		throw e instanceof DeployError ? e : new DeployError(EXIT.FAIL, e.message);
	};
	try {
		if (!done.has('env')) {
			if (cfg.envGenerator) ctx.run('env-generator', [...cfg.envGenerator, '--source', path.join(p.live, '.env'), '--out', path.join(p.next, '.env')]);
			mark('env');
		}
		if (!done.has('link')) {
			prepareClientLink(ctx, closure);
			mark('link');
		}
		if (!done.has('install')) {
			ctx.run('install', cfg.install, { cwd: p.next });
			if (!linkOk(p, cfg, closure)) throw new DeployError(EXIT.ARTIFACT, `the client link ${cfg.legacy.linkPath} does not resolve inside the captured closure`);
			mark('install');
		}
		if (!done.has('build')) {
			ctx.run('legacy-build', ['bash', path.join(p.next, 'scripts/build-production.sh'), '--no-restart'], { cwd: p.next });
			mark('build');
		}
		const art = checkArtifacts({ tree: p.next });
		if (!art.ok) throw new DeployError(EXIT.ARTIFACT, `artifact check failed: ${art.problems.join('; ')}`);
		mark('artifacts');
		state = { ...state, state: 'built' };
		writeState(p, state);
	} catch (e) {
		fail(e);
	}
}

/** True when the stage's installed dependency link is a symlink whose realpath lies inside the captured closure (never the dev tree). */
function linkOk(p, cfg, captured) {
	const { recDir, clientDir } = captured;
	const link = path.join(p.next, cfg.legacy.linkPath);
	try {
		// the closure is re-verified here: whatever the installation resolved, it must not have been given (or been able to read) anything outside it
		if (captured.files && closureProblem(captured)) return false;
		if (!lstatSync(link).isSymbolicLink()) return false;
		const inside = (root, x) => x === root || x.startsWith(`${root}${path.sep}`);
		const closure = realpathSync(recDir);
		const client = realpathSync(clientDir);
		return inside(closure, client) && inside(client, realpathSync(link));
	} catch {
		return false;
	}
}

const clientPackageName = (cfg) => {
	const name = cfg.legacy.linkPath.split('node_modules/')[1];
	if (!name) throw new DeployError(EXIT.USAGE, `config legacy.linkPath ${cfg.legacy.linkPath} is not under node_modules/`);
	return name;
};
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const clientSpec = (p, { clientDir }) => `link:${path.relative(p.next, clientDir)}`;

/** True when the stage's lockfile (if any) records the captured client link. */
function lockLinkOk(p, closure) {
	const lockFile = path.join(p.next, 'pnpm-lock.yaml');
	try {
		return !existsSync(lockFile) || readFileSync(lockFile, 'utf8').includes(clientSpec(p, closure));
	} catch {
		return false;
	}
}

/** True when the stage's manifest already names the captured client as the target of the client dependency. */
function manifestLinkOk(p, cfg, closure) {
	try {
		const pkg = JSON.parse(readFileSync(path.join(p.next, 'package.json'), 'utf8'));
		const name = clientPackageName(cfg);
		const specs = DEP_SECTIONS.map((s) => pkg[s]?.[name]).filter((v) => v !== undefined);
		return specs.length > 0 && specs.every((v) => v === clientSpec(p, closure));
	} catch {
		return false;
	}
}

/**
 * Before pnpm runs: the manifest's `link:` dependency on the client is pointed at the captured closure (in the
 * manifest and in the lockfile that records it), so the installation itself resolves inside the closure and the
 * development tree is never read. pnpm would otherwise resolve the archived target path at install time. Exit 7 when
 * the manifest has no such link or the lockfile does not record the one being replaced.
 */
function prepareClientLink(ctx, closure) {
	const { paths: p, cfg } = ctx;
	const name = clientPackageName(cfg);
	const want = clientSpec(p, closure);
	const pkgFile = path.join(p.next, 'package.json');
	const lockFile = path.join(p.next, 'pnpm-lock.yaml');
	const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
	// the original specs, from the manifest as archived; a manifest already rewritten (an earlier attempt got that far) has none left
	const olds = new Set();
	for (const s of DEP_SECTIONS) {
		const v = pkg[s]?.[name];
		if (typeof v !== 'string') continue;
		if (v === want) continue;
		if (!v.startsWith('link:')) throw new DeployError(EXIT.ARTIFACT, `the legacy manifest's ${s}.${name} is not a link: dependency`);
		olds.add(v);
	}
	const hasLink = DEP_SECTIONS.some((s) => typeof pkg[s]?.[name] === 'string');
	if (!hasLink) throw new DeployError(EXIT.ARTIFACT, `the legacy manifest has no link: dependency named ${name}`);
	// The lockfile is rewritten first, the manifest last, each by one rename: whichever write a kill interrupts, the state on
	// disk is "lockfile done, manifest not yet" or "both done", and this function carries on from either without the archived spec.
	if (existsSync(lockFile)) {
		let text = readFileSync(lockFile, 'utf8');
		for (const old of olds) {
			if (text.includes(old)) text = text.split(old).join(want);
			else if (!text.includes(want)) throw new DeployError(EXIT.ARTIFACT, `the legacy lockfile does not record ${old}`);
		}
		if (text !== readFileSync(lockFile, 'utf8')) writeTextAtomic(lockFile, text);
	}
	ctx.deps.afterLinkLock?.();
	if (olds.size) {
		for (const s of DEP_SECTIONS) if (typeof pkg[s]?.[name] === 'string') pkg[s][name] = want;
		writeTextAtomic(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
	}
	if (!manifestLinkOk(p, cfg, closure)) throw new DeployError(EXIT.ARTIFACT, `the client link ${name} could not be pointed at the captured closure`);
	if (existsSync(lockFile) && !readFileSync(lockFile, 'utf8').includes(want)) throw new DeployError(EXIT.ARTIFACT, `the legacy lockfile does not record the captured client link ${want}`);
}

export async function rollbackLegacy(ctx, tag, opts = {}) {
	const { paths: p } = ctx;
	rootRuleUpFront(ctx, opts, 'legacy');
	if (!tag) throw new DeployError(EXIT.USAGE, 'legacy needs --legacy-tag <tag>');

	// one lock across validation, build, activation and purge
	return underLock(ctx, async () => {
		// a committed rollback of another kind blocks this one; a different tag than an unfinished legacy rollback's is refused
		const claimed = claimOp(ctx, 'legacy', tag);
		const state = readState(p);
		const journal = journalRead(ctx);
		const resumeBuilding = journal?.tag === tag && !!state?.stageId && journal.stageId === state.stageId && state?.state === 'building' && state.source === `legacy:${tag}`;
		// a legacy build interrupted earlier is the one case where `building` is not a recovery refusal
		const v = validateLegacy(ctx, tag, { resuming: resumeBuilding });
		// this legacy stage already is the live tree (the swap finished, readiness and smoke did not): resume, never rebuild or swap again
		const swapped = state?.source === `legacy:${tag}` && isCompletedSwap(state) && state.inflight.kind === 'activate' && state.inflight.stageId === state.stageId;
		const already = state?.source === `legacy:${tag}` && ['built', 'active', 'purged', 'purge-failed'].includes(state.state) && journal?.stageId === state.stageId && journal?.completed?.includes('artifacts');
		// the target is recorded durably before the build starts; the built stage's id is added once it exists
		const op = claimed.op ?? beginOp(ctx, 'legacy', tag);
		if (!swapped && !already) await buildLegacy(ctx, tag, v);
		if (!op.stageId) writeOp(ctx, { ...op, stageId: readState(p)?.stageId ?? null });
		await ctx.deps.checkpoint?.('legacy:after-build');
		const after = readState(p);
		if (swapped) await resumeActivation(ctx, stepFlags(opts));
		else if (!(after?.source === `legacy:${tag}` && ['active', 'purged', 'purge-failed'].includes(after.state))) await activate(ctx, stepFlags(opts));
		const res = await purgeStep(ctx, opts);
		clearOp(ctx);
		return res;
	});
}

// -------------------------------------------------------------------- CLI

const VALUE_FLAGS = ['--config', '--smoke-port', '--fault', '--pin', '--legacy-tag'];

export async function runCli(argv, { deps, out = console } = {}) {
	try {
		const a = parseFlags(argv, VALUE_FLAGS);
		const [mode, arg] = a.positional;
		if (!a.values.has('--config') || !['previous', 'composed', 'legacy'].includes(mode)) {
			out.error('usage: rollback.mjs --config <file> (previous | composed [<history-id>] | legacy --legacy-tag <tag>) [--no-restart --smoke-port <p>] [--fault <point>] [--pin <sha>]');
			return EXIT.USAGE;
		}
		const ctx = makeContext(loadConfig(a.values.get('--config')), deps);
		const opts = flagsToOpts(a);
		if (Number.isNaN(opts.smokePort)) throw new DeployError(EXIT.USAGE, '--smoke-port must be a number');
		if (mode === 'previous') await rollbackPrevious(ctx, opts);
		else if (mode === 'composed') await rollbackComposed(ctx, arg, opts);
		else await rollbackLegacy(ctx, opts.legacyTag, opts);
		out.log(`${mode}: ok`);
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
