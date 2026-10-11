// compose-history: one verbatim copy of the complete INPUT set per apply, kept in
// <brand repo>/.compose-history/<UTC timestamp>-<pin12>[-n]/ (git-ignored by the brand).
//   layer/                  the whole brand layer directory, byte for byte
//   meta.json               { id, status: 'applied'|'built', pin, hashes, createdAt, builtAt? }
//   compose-managed.json    the .compose-managed.json this apply produced
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { makeDir, removeTree } from './durable.mjs';
import { ComposeError, hashJson, pretty, readJson, safeRemoveFile, safeWrite, pruneEmptyDirs, sha256, treeHash, walkFiles } from './util.mjs';

const ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{12}(-\d+)?$/;
export const HISTORY_DIRNAME = '.compose-history';

export const historyDirFor = (layerDir) => path.join(path.dirname(layerDir), HISTORY_DIRNAME);

/**
 * lstat-validates the history root before it is created or used: a symlink or a non-directory there
 * would redirect every snapshot write (and the pruning) outside the intended directory.
 * Returns false when it does not exist, true when it is a real directory; throws otherwise.
 */
export function historyRootState(root) {
	let st;
	try {
		st = lstatSync(root);
	} catch {
		return false;
	}
	if (st.isSymbolicLink()) throw new ComposeError('symlink', `history root ${root} is a symlink`);
	if (!st.isDirectory()) throw new ComposeError('not-a-dir', `history root ${root} is not a directory`);
	return true;
}

/** Creates the history root when absent (never recursively: its parent is the real brand repo directory) and validates it. */
export function ensureHistoryRoot(root) {
	if (!historyRootState(root)) makeDir(root);
	historyRootState(root);
	return root;
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** Hash of the brand-only public config (names and values from brand.json), independent of any env state. */
export const publicConfigHash = (brand) => hashJson(Object.entries(brand.publicConfig ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)));
export const layerTreeHash = (layer) => treeHash(layer.files.map((f) => [f.rel, f.sha]));

/**
 * `pin` is the EFFECTIVE pin the output is composed at (a --pin override wins); `brandPin` is the pin
 * written in the layer's brand.json, the part of the layer that restore can recompute and verify.
 */
export function layerHashes({ layer, pin, toolVersion }) {
	return {
		pin,
		brandPin: layer.brand.pin,
		overlayTree: layer.overlayTreeHash,
		manifest: layer.manifestSha,
		lock: layer.lockSha,
		brandPublicConfig: publicConfigHash(layer.brand),
		layerTree: layerTreeHash(layer),
		tool: toolVersion,
	};
}

/** Picks the id the next entry will have; nothing is created. The caller journals it BEFORE `writeEntry` creates any file. */
export function allocateEntryId({ layerDir, hashes, now }) {
	const root = ensureHistoryRoot(historyDirFor(layerDir));
	let id = `${stamp(now)}-${hashes.pin.slice(0, 12)}`;
	for (let n = 2; existsSync(path.join(root, id)); n++) id = `${stamp(now)}-${hashes.pin.slice(0, 12)}-${String(n).padStart(3, '0')}`;
	return id;
}

/** Writes the entry `id` (from `allocateEntryId`, already journaled). meta.json is written last: an entry without it is a partial one. */
export function writeEntry({ layerDir, layer, hashes, managedText, now, id }) {
	const root = ensureHistoryRoot(historyDirFor(layerDir));
	for (const f of layer.files) safeWrite(root, `${id}/layer/${f.rel}`, readFileSync(f.abs), f.mode & 0o111 ? 0o755 : 0o644);
	safeWrite(root, `${id}/compose-managed.json`, managedText);
	safeWrite(root, `${id}/meta.json`, pretty({ id, status: 'applied', hashes, createdAt: now.toISOString(), pin: hashes.pin }));
	return id;
}

export function listEntries(layerDir) {
	const root = historyDirFor(layerDir);
	if (!historyRootState(root)) return [];
	const out = [];
	for (const name of readdirSync(root).sort()) {
		if (!ID_RE.test(name)) continue;
		const meta = path.join(root, name, 'meta.json');
		if (existsSync(meta)) out.push({ id: name, dir: path.join(root, name), meta: readJson(meta, `${name}/meta.json`) });
	}
	return out;
}

export function readEntry(layerDir, id) {
	if (!ID_RE.test(id ?? '')) throw new ComposeError('bad-history-id', `history id ${JSON.stringify(id)} is not a valid entry id`);
	const e = listEntries(layerDir).find((x) => x.id === id);
	if (!e) throw new ComposeError('no-such-history', `no history entry ${id} under ${historyDirFor(layerDir)}`);
	return e;
}

/** Flip the newest `applied` entry whose managed file equals the one now in the build directory to `built`. */
export function markBuilt({ layerDir, outDir, now, keepBuilt = 3, buildConfigHash }) {
	let managed;
	try {
		managed = readFileSync(path.join(outDir, '.compose-managed.json'));
	} catch {
		throw new ComposeError('no-managed', 'build directory has no .compose-managed.json; nothing to mark built');
	}
	const want = sha256(managed);
	const cands = listEntries(layerDir)
		.filter((e) => e.meta.status === 'applied')
		.filter((e) => sha256(readFileSync(path.join(e.dir, 'compose-managed.json'))) === want);
	const e = cands.at(-1);
	if (!e) throw new ComposeError('no-matching-history', 'no applied history entry matches the build directory\'s .compose-managed.json');
	const root = historyDirFor(layerDir);
	safeWrite(root, `${e.id}/meta.json`, pretty({ ...e.meta, status: 'built', builtAt: now.toISOString(), ...(buildConfigHash ? { buildConfigHash } : {}) }));
	pruneHistory({ layerDir, keepBuilt });
	return e.id;
}

/**
 * Settles an entry whose apply was interrupted and rolled back by --recover. A complete entry (meta.json present) is marked
 * `abandoned`; a partial one (the apply died while creating it: no readable meta.json, which is written last) is removed
 * entirely, because nothing can use it and nothing else would ever clean it. Missing entries are ignored (idempotent).
 * Returns 'abandoned', 'removed' or false.
 */
export function abandonEntry({ layerDir, id, now = new Date() }) {
	if (!ID_RE.test(id ?? '')) return false;
	const root = historyDirFor(layerDir);
	if (!historyRootState(root)) return false;
	const dir = path.join(root, id);
	let st;
	try {
		st = lstatSync(dir);
	} catch {
		return false;
	}
	if (st.isSymbolicLink() || !st.isDirectory()) return false;
	let meta = null;
	try {
		meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
	} catch {
		/* partial */
	}
	if (!meta || typeof meta !== 'object') {
		removeTree(dir);
		return 'removed';
	}
	safeWrite(root, `${id}/meta.json`, pretty({ ...meta, status: 'abandoned', abandonedAt: now.toISOString() }));
	return 'abandoned';
}

/** Keep the newest `keepBuilt` built entries and anything newer than the oldest kept one; remove only this tool's own entry directories. */
export function pruneHistory({ layerDir, keepBuilt }) {
	const all = listEntries(layerDir);
	const built = all.filter((e) => e.meta.status === 'built');
	if (built.length <= keepBuilt) return [];
	const oldestKept = built[built.length - keepBuilt].id;
	const removed = [];
	for (const e of all) {
		if (e.id < oldestKept) {
			const st = lstatSync(e.dir);
			if (st.isSymbolicLink() || !st.isDirectory()) continue;
			removeTree(e.dir);
			removed.push(e.id);
		}
	}
	return removed;
}

/** The brand.json pin the entry's layer copy carries (entries written before brandPin existed recorded it as `pin`). */
export const entryBrandPin = (entry) => entry.meta.hashes.brandPin ?? entry.meta.hashes.pin;
/** The effective pin the entry's output was composed at; recomposition after a restore must use it. */
export const entryEffectivePin = (entry) => entry.meta.hashes.pin;

const COPY_KEYS = ['overlayTree', 'manifest', 'lock', 'brandPublicConfig', 'layerTree'];

/** Names of the recorded hashes that `got` (computed from a layer directory) does not match. */
export function mismatchedHashes(entry, got) {
	const bad = [];
	if (got.brandPin !== entryBrandPin(entry)) bad.push('brandPin');
	for (const k of COPY_KEYS) if (got[k] !== entry.meta.hashes[k]) bad.push(k);
	return bad;
}

/** Verifies the history copy against the entry's recorded hashes without touching anything. */
export function verifyEntryCopy(entry, computeFromDir) {
	return mismatchedHashes(entry, computeFromDir(path.join(entry.dir, 'layer')));
}

/** Replaces layerDir's content with the entry's layer copy (extra files removed). Writes only inside layerDir. */
export function replaceLayerWithCopy({ layerDir, entry }) {
	const src = path.join(entry.dir, 'layer');
	const copy = walkFiles(src);
	const keep = new Set(copy.map((f) => f.rel));
	for (const f of copy) safeWrite(layerDir, f.rel, readFileSync(f.abs), f.mode & 0o111 ? 0o755 : 0o644);
	for (const f of walkFiles(layerDir)) {
		if (!keep.has(f.rel)) {
			safeRemoveFile(layerDir, f.rel);
			pruneEmptyDirs(layerDir, f.rel);
		}
	}
}
