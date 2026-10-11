// Apply journal and per-brand lock (plan §4.3 step 4a, §4.6a b, finding C3).
//
// Before the first retirement, write or removal an apply records, outside the target, the previous bytes, mode and
// presence of every path it may change, plus the intended additions. A journal that is still on disk means the
// apply did not finish: every mode except dry-run and recover refuses (exit 5) until `recover` has put the exact
// previous state back.
//
//   <brand repo>/.compose-journal/<id>/journal.json    { version, id, createdAt, roots, entries[], steps[], history }
//   <brand repo>/.compose-journal/<id>/prev/<n>         previous bytes of entry n (only when it existed)
//   <brand repo>/.compose-journal/<id>/temps.log        one JSON line per temporary file a write is about to create (appended and synced BEFORE it exists)
//   <brand repo>/.compose.lock                          diagnostic pid file; the lock itself is kernel-backed (os-lock.mjs)
//   <brand repo>/.compose-journal/<id>.done             a retired journal: renamed here atomically, then deleted
//
// A journal is assembled in `<id>.tmp`, fsynced, then renamed into place, so a half-written journal never counts:
// nothing has been changed yet when one is found.
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { appendFile, createFile, fsyncDir, makeDir, removeDir, removeFile, removeTree, renamePath, repairTornTail, replaceFile, setMode } from './durable.mjs';
import { LockHeldError, acquireOsLock, holdsInheritedLock } from './os-lock.mjs';
import { ComposeError, assertSafeRel, pretty, safeRemoveFile, safeWrite, setTempRecorder, sha256 } from './util.mjs';

export const JOURNAL_DIRNAME = '.compose-journal';
export const LOCK_NAME = '.compose.lock';
/** Journal step markers, in the order apply reaches them. */
export const STEPS = ['retire', 'write', 'remove', 'manifest', 'adoption'];

export const journalRootFor = (brandRepo) => path.join(brandRepo, JOURNAL_DIRNAME);

// ------------------------------------------------------------------ lock

export const DEPLOY_STATE_DIRNAME = '.deploy-state';
export const DEPLOY_LOCK_NAME = 'lock';

/**
 * One writer per brand repo. Compose takes TWO kernel-backed locks (os-lock.mjs), always in this order: the
 * deployment lock of the brand repo (`.deploy-state/lock`, the one the guarded entry and rollback hold for a whole
 * operation) and its own (`.compose.lock`). A standalone compose therefore cannot run while a deployment operation holds
 * the stage, and no deployment operation can start while a compose does. Compose started BY a deployment operation runs
 * inside that operation's lock: the runner hands the lock's descriptor to the child as fd 3, and `holdsInheritedLock`
 * verifies it is really the deployment lock's socket (nothing is taken twice, nothing is claimed by name alone).
 * `.compose.lock` is a diagnostic pid file only. Resolves to an async release(); a held lock is ComposeError('locked') (exit 5).
 */
export async function acquireLock(brandRepo) {
	const stateDir = path.join(brandRepo, DEPLOY_STATE_DIRNAME);
	let releaseDeploy = null;
	try {
		let st = null;
		try {
			st = lstatSync(stateDir);
		} catch {
			/* created below */
		}
		if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new ComposeError('not-a-dir', `${stateDir} is not a real directory`);
		if (!st) makeDir(stateDir, { mode: 0o700 });
		if (!holdsInheritedLock(stateDir, DEPLOY_LOCK_NAME)) releaseDeploy = await acquireOsLock(stateDir, DEPLOY_LOCK_NAME);
		const own = await acquireOsLock(brandRepo, LOCK_NAME);
		const release = async () => {
			await own();
			await releaseDeploy?.();
		};
		release.fd = own.fd;
		return release;
	} catch (e) {
		await releaseDeploy?.();
		if (e instanceof LockHeldError) throw new ComposeError('locked', `another operation holds ${e.file}${e.holderPid ? ` (pid ${e.holderPid})` : ''}`);
		throw e;
	}
}

// ------------------------------------------------------------------ journal

const DONE_SUFFIX = '.done';
const TMP_SUFFIX = '.tmp';
/** True for a directory that is not an active journal: a begin that never completed, or one already retired. */
export const isInactiveJournalName = (n) => n.endsWith(TMP_SUFFIX) || n.endsWith(DONE_SUFFIX);

/**
 * Retires a journal in two steps: one atomic rename to `<id>.done` (from then on it no longer counts as a journal,
 * and nothing in it is needed), then the deletion. A kill during the deletion leaves a `.done` directory that
 * blocks nothing and is swept by the next recover. `rm` is injectable so a test can die halfway through it.
 */
export function retireJournal(dir, jroot, removeWith = removeTree) {
	const done = `${dir}${DONE_SUFFIX}`;
	removeTree(done);
	renamePath(dir, done);
	removeWith(done, { recursive: true, force: true });
	fsyncDir(jroot);
}

/** Names of finished journals (a `.tmp` directory is a begin that never completed and changed nothing). */
export function pendingJournals(brandRepo) {
	const root = journalRootFor(brandRepo);
	let names;
	try {
		names = readdirSync(root);
	} catch {
		return [];
	}
	return names.filter((n) => !isInactiveJournalName(n)).sort();
}

/** Throws ComposeError('journal-present') (exit 5) when an unrecovered journal exists. */
export function assertNoJournal(brandRepo) {
	const p = pendingJournals(brandRepo);
	if (p.length) throw new ComposeError('journal-present', `an interrupted apply left a journal (${p.join(', ')}); run --recover before any other mode`);
}

const rootDir = (roots, name) => {
	const d = roots[name];
	if (!d) throw new ComposeError('bad-journal', `journal root ${name} is not defined`);
	return d;
};

function snapshotEntry(dir, rel) {
	assertSafeRel(rel, 'journal path');
	const abs = path.join(dir, rel);
	let st;
	try {
		st = lstatSync(abs);
	} catch {
		return { present: false };
	}
	if (st.isSymbolicLink() || !st.isFile()) throw new ComposeError('not-a-file', `${rel} is not a regular file; refusing to journal it`);
	return { present: true, mode: st.mode & 0o777, sha256: sha256(readFileSync(abs)) };
}

/**
 * Directory presence of every ancestor (and the root itself) of the journaled paths, recorded before anything changes:
 * { root, rel ('' = the root), present, mode? }. A directory absent here was created by the composition, so recovery
 * removes it again (once empty, with rmdir); one present keeps its recorded mode. Only a plainly missing directory is
 * recorded absent; anything else (a symlink, a file) is left for the write that meets it to refuse.
 */
function snapshotDirs(roots, entries) {
	const wanted = new Map();
	for (const { root, rel } of entries) {
		wanted.set(`${root}\0`, { root, rel: '' });
		const parts = rel.split('/');
		for (let i = 1; i < parts.length; i++) wanted.set(`${root}\0${parts.slice(0, i).join('/')}`, { root, rel: parts.slice(0, i).join('/') });
	}
	const dirs = [];
	for (const { root, rel } of wanted.values()) {
		let st = null;
		try {
			st = lstatSync(path.join(rootDir(roots, root), rel));
		} catch (e) {
			if (e.code === 'ENOENT') dirs.push({ root, rel, present: false });
			continue;
		}
		if (st.isDirectory()) dirs.push({ root, rel, present: true, mode: st.mode & 0o777 });
	}
	return dirs.sort((a, b) => (a.root === b.root ? a.rel.localeCompare(b.rel) : a.root.localeCompare(b.root)));
}

/**
 * Writes the journal. `roots` maps a root name to its directory ('out' = build dir or stage, 'history' =
 * <brand repo>/.compose-history). `paths` is a list of { root, rel } the apply may retire, write or remove.
 * Returns a handle with mark(step), setHistory(id) and finish().
 */
export function beginJournal({ brandRepo, roots, paths, now = new Date(), rm: removeWith = removeTree }) {
	const jroot = journalRootFor(brandRepo);
	try {
		const st = lstatSync(jroot);
		if (st.isSymbolicLink() || !st.isDirectory()) throw new ComposeError('not-a-dir', `${jroot} is not a directory`);
	} catch (e) {
		if (e instanceof ComposeError) throw e;
		makeDir(jroot);
	}
	const id = `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${process.pid}`;
	const tmp = path.join(jroot, `${id}.tmp`);
	const final = path.join(jroot, id);
	removeTree(tmp);
	makeDir(path.join(tmp, 'prev'), { recursive: true });
	const seen = new Set();
	const entries = [];
	for (const { root, rel } of paths) {
		const key = `${root}\0${rel}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const snap = snapshotEntry(rootDir(roots, root), rel);
		const n = entries.length;
		if (snap.present) createFile(path.join(tmp, 'prev', String(n)), readFileSync(path.join(rootDir(roots, root), rel)));
		entries.push({ n, root, rel, ...snap });
	}
	const doc = { version: 1, id, createdAt: now.toISOString(), roots, entries, dirs: snapshotDirs(roots, entries), steps: [], history: null };
	createFile(path.join(tmp, 'journal.json'), pretty(doc));
	renamePath(tmp, final);

	const dir = final;
	// from here on every temporary file a write creates is named in temps.log first (a torn last line names nothing: the append precedes the creation)
	setTempRecorder(tempRecorderFor(dir));
	const rewrite = (mut) => {
		mut(doc);
		const t = path.join(dir, 'journal.json.tmp');
		removeFile(t);
		replaceFile(path.join(dir, 'journal.json'), pretty(doc), { mode: 0o600, tmp: t });
	};
	return {
		id,
		dir,
		mark: (step) => rewrite((d) => d.steps.push(step)),
		setHistory: (historyId) => rewrite((d) => {
			d.history = historyId;
		}),
		/** Retired last, on success: renamed to `<id>.done` atomically, then deleted. */
		finish: () => {
			setTempRecorder(null);
			retireJournal(dir, jroot, removeWith);
		},
	};
}

/** A recorder that appends each temporary about to be created to `<journal>/temps.log` and fsyncs it before the file exists. */
function tempRecorderFor(dir) {
	const tempsLog = path.join(dir, 'temps.log');
	return (tmpAbs) => {
		appendFile(tempsLog, `${JSON.stringify({ p: tmpAbs })}\n`);
	};
}

function readJournal(brandRepo, id) {
	const dir = path.join(journalRootFor(brandRepo), id);
	let doc;
	try {
		doc = JSON.parse(readFileSync(path.join(dir, 'journal.json'), 'utf8'));
	} catch (e) {
		throw new ComposeError('bad-journal', `journal ${id} cannot be read (${e.code ?? e.message}); not touching anything`);
	}
	if (doc?.version !== 1 || !Array.isArray(doc.entries)) throw new ComposeError('bad-journal', `journal ${id} is malformed`);
	return { dir, doc };
}

/**
 * Puts every journaled path back to its previous bytes, mode or absence, deletes intended additions (paths that were
 * absent), marks the history entry `abandoned`, deletes the journal. Idempotent: with no journal it does nothing.
 * `roots` is checked against the journal's recorded roots so a recover run against another tree is refused.
 */
export function recoverJournals({ brandRepo, roots, markAbandoned, rm: removeWith = removeTree }) {
	setTempRecorder(null);
	try {
		return recoverEach({ brandRepo, roots, markAbandoned, removeWith });
	} finally {
		setTempRecorder(null);
	}
}

function recoverEach({ brandRepo, roots, markAbandoned, removeWith }) {
	const done = [];
	for (const name of readdirOrEmpty(journalRootFor(brandRepo))) {
		if (isInactiveJournalName(name)) {
			removeWith(path.join(journalRootFor(brandRepo), name), { recursive: true, force: true });
			continue;
		}
		const { dir, doc } = readJournal(brandRepo, name);
		for (const [k, v] of Object.entries(doc.roots)) {
			if (roots[k] !== v) throw new ComposeError('journal-root-mismatch', `journal ${name} was taken for ${k}=${v}, not ${roots[k]}; refusing to recover it here`);
		}
		// a record cut short by the kill names nothing, but the recorder below APPENDS: the fragment goes first, or the next record would be glued onto it
		repairTornTail(path.join(dir, 'temps.log'));
		const temps = removeRecordedTemps(dir, doc.roots);
		// recovery's own writes (restores and the abandoned mark) are recorded in the journal being recovered before each temporary
		// exists, so a recovery killed inside a write leaves a recorded temporary that the next recovery removes
		setTempRecorder(tempRecorderFor(dir));
		const restored = [];
		const removed = [];
		for (const e of doc.entries) {
			const dirAbs = rootDir(doc.roots, e.root);
			if (e.present) {
				// the root held this file at begin: if it is gone now (lost, or removed by an earlier recovery attempt) it is recreated
				if (!lstatSync(dirAbs, { throwIfNoEntry: false })) makeDir(dirAbs, { recursive: true });
				const buf = readFileSync(path.join(dir, 'prev', String(e.n)));
				if (sha256(buf) !== e.sha256) throw new ComposeError('bad-journal', `journal ${name} copy of ${e.rel} fails its hash; not touching anything further`);
				safeWrite(dirAbs, e.rel, buf, e.mode);
				restored.push(e.rel);
			} else if (!lstatSync(dirAbs, { throwIfNoEntry: false })) {
				// the root was absent at begin and an earlier attempt already removed it (or the apply died before creating it): nothing to remove.
				// A root that exists is still checked by safeRemoveFile (a symlink or a non-directory is refused).
			} else if (safeRemoveFile(dirAbs, e.rel)) {
				removed.push(e.rel);
			}
		}
		const dirsRemoved = restoreDirs(dir, doc);
		if (doc.history && markAbandoned) markAbandoned(doc.history);
		setTempRecorder(null);
		retireJournal(dir, journalRootFor(brandRepo), removeWith);
		done.push({ id: name, restored: restored.length, removed: removed.length, dirs: dirsRemoved, temps, history: doc.history });
	}
	return done;
}

/**
 * Removes the directories the interrupted composition created (recorded absent at begin), deepest first and only while
 * empty (rmdir: a directory holding anything else is not ours to delete), and puts a recorded mode back on a directory
 * recovery had to recreate. Returns how many directories it removed.
 */
function restoreDirs(dir, doc) {
	const dirs = Array.isArray(doc.dirs) ? doc.dirs : [];
	let n = 0;
	for (const d of [...dirs].filter((x) => !x.present).sort((a, b) => b.rel.split('/').length - a.rel.split('/').length || (a.rel < b.rel ? 1 : -1))) {
		const abs = d.rel ? path.join(rootDir(doc.roots, d.root), d.rel) : rootDir(doc.roots, d.root);
		try {
			if (!lstatSync(abs).isDirectory() || readdirSync(abs).length > 0) continue;
			removeDir(abs);
			n++;
		} catch {
			/* never created, or no longer empty */
		}
	}
	for (const d of dirs.filter((x) => x.present && x.rel && Number.isInteger(x.mode))) {
		const abs = path.join(rootDir(doc.roots, d.root), d.rel);
		try {
			const st = lstatSync(abs);
			if (st.isDirectory() && (st.mode & 0o777) !== d.mode) setMode(abs, d.mode);
		} catch {
			/* gone: nothing to restore */
		}
	}
	return n;
}

/**
 * Deletes the temporary files this transaction recorded before creating them (a write killed between creating its
 * temporary and renaming it). Only regular files named like a compose temporary and inside one of the journal's own roots
 * are touched; anything else on the list is ignored, and unrelated files are never looked at. Returns how many were removed.
 */
function removeRecordedTemps(dir, roots) {
	let text;
	try {
		text = readFileSync(path.join(dir, 'temps.log'), 'utf8');
	} catch {
		return 0;
	}
	const rootDirs = Object.values(roots).map((r) => path.resolve(r));
	let n = 0;
	// only complete lines count: a torn last line was never followed by the creation it announced
	for (const line of text.split('\n').slice(0, -1)) {
		let p;
		try {
			p = JSON.parse(line).p;
		} catch {
			continue;
		}
		if (typeof p !== 'string' || !path.isAbsolute(p) || !path.basename(p).includes('.compose-tmp-')) continue;
		const abs = path.resolve(p);
		if (!rootDirs.some((r) => abs.startsWith(`${r}${path.sep}`))) continue;
		try {
			if (!lstatSync(abs).isFile()) continue;
			removeFile(abs);
			n++;
		} catch {
			/* never created */
		}
	}
	return n;
}

function readdirOrEmpty(p) {
	try {
		return readdirSync(p).sort();
	} catch {
		return [];
	}
}
