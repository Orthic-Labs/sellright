// Eject drift: the compose gate (checkDrift), the three-way report (describeDrift)
// and the resolution actions (accept, readopt, migrate). The CLI is
// tools/drift/drift.mjs; compose imports this file, so it lives under tools/compose
// (the wrapper archives only that directory).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createFile, makeDir, makeTempDir, removeTree } from './durable.mjs';
import { scriptEntryId, snapshotKey } from './layer.mjs';
import { layerOf } from './layers.mjs';
import { ComposeError, PIN_RE, Problems, pretty, readJson, safeRemoveFile, safeWrite, sha256 } from './util.mjs';

export const entryId = (e) => (e.kind === 'package-script' ? scriptEntryId(e.key) : e.path);
const isEject = (e) => e.layer === 'L2' || e.kind === 'package-script';

/** Bytes of the base value an entry shadows at the given base, or null when it no longer exists. */
export function baseValueFor(entry, base) {
	if (entry.kind === 'package-script') {
		let scripts;
		try {
			scripts = JSON.parse(base.read('package.json').toString('utf8')).scripts ?? {};
		} catch {
			return null;
		}
		return typeof scripts[entry.key] === 'string' ? Buffer.from(scripts[entry.key], 'utf8') : null;
	}
	return base.read(entry.path);
}

/** Bytes of the brand's current override for an entry, or null. */
export function overrideFor(entry, layer) {
	if (entry.kind === 'package-script') {
		const v = layer.brand?.packageScripts?.[entry.key];
		return typeof v === 'string' ? Buffer.from(v, 'utf8') : null;
	}
	const f = layer.overlay.get(entry.path);
	return f ? readFileSync(f.abs) : null;
}

/**
 * The mandatory drift check (compose step 2). Returns one record per eject entry
 * and adds a problem for every one that is not clean.
 */
export function checkDrift({ layer, base, pin, problems = new Problems() }) {
	const records = [];
	if (!PIN_RE.test(pin ?? '')) {
		problems.add('bad-pin', 'drift check needs a full 40-character pin');
		return records;
	}
	for (const e of layer.manifest.entries ?? []) {
		if (!isEject(e)) continue;
		const id = entryId(e);
		const rec = { id, status: 'unchanged' };
		records.push(rec);
		const snap = layer.snapshots.get(snapshotKey(e));
		if (!snap) {
			rec.status = 'snapshot-missing';
			problems.add('snapshot-missing', `no base snapshot overlay.base/${snapshotKey(e)} for ${id}`, id);
			continue;
		}
		if (snap.sha !== e.baseSnapshotHash) {
			rec.status = 'snapshot-tampered';
			problems.add('snapshot-tampered', `overlay.base/${snapshotKey(e)} does not match baseSnapshotHash`, id);
			continue;
		}
		if (e.baseSnapshotHash !== e.baseHash) {
			rec.status = 'snapshot-mismatch';
			problems.add('snapshot-mismatch', `baseSnapshotHash differs from baseHash for ${id}`, id);
			continue;
		}
		const cur = baseValueFor(e, base);
		if (cur === null) {
			rec.status = 'orphaned';
			problems.add('orphaned-eject', `${id} no longer exists upstream at pin ${pin.slice(0, 12)}; resolve with drift.mjs --migrate or --readopt`, id);
			continue;
		}
		const h = sha256(cur);
		if (h === e.baseHash) continue;
		const r = e.resolution;
		if (r && r.pin === pin && r.baseHash === h) {
			rec.status = 'resolved';
			continue;
		}
		rec.status = 'changed';
		rec.newBaseHash = h;
		problems.add('drift-unresolved', `base changed upstream since ${String(e.fromPin).slice(0, 12)} and has no resolution for pin ${pin.slice(0, 12)}; run drift.mjs`, id);
	}
	return records;
}

/** `git diff --no-index -U3` of two buffers; '' when equal. Paths are shown as old/<name> and new/<name>. */
export function unifiedDiff(oldBuf, newBuf, name) {
	const tmp = makeTempDir('compose-diff-');
	try {
		for (const [side, buf] of [['old', oldBuf], ['new', newBuf]]) {
			const f = path.join(tmp, side, name);
			makeDir(path.dirname(f), { recursive: true });
			createFile(f, buf ?? Buffer.alloc(0));
		}
		const r = spawnSync('git', ['-c', 'core.quotepath=false', 'diff', '--no-index', '--no-color', '-U3', '--', `old/${name}`, `new/${name}`], {
			cwd: tmp,
			encoding: 'utf8',
			maxBuffer: 1 << 26,
			env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
		});
		if (r.error) throw new ComposeError('git', `git diff failed to start: ${r.error.message}`);
		if (r.status !== 0 && r.status !== 1) throw new ComposeError('git', `git diff exited ${r.status}: ${r.stderr}`);
		return r.stdout;
	} finally {
		removeTree(tmp);
	}
}

/** Three-way detail for one entry: old base (verified), new base, current override, two diffs. */
export function describeDrift({ entry, layer, base }) {
	const id = entryId(entry);
	const snap = layer.snapshots.get(snapshotKey(entry));
	const oldBase = snap ? readFileSync(snap.abs) : null;
	const snapshotOk = oldBase !== null && sha256(oldBase) === entry.baseSnapshotHash;
	const newBase = baseValueFor(entry, base);
	const override = overrideFor(entry, layer);
	const name = snapshotKey(entry);
	return {
		id,
		snapshotOk,
		oldBaseHash: entry.baseSnapshotHash,
		newBaseHash: newBase ? sha256(newBase) : null,
		orphaned: newBase === null,
		upstreamDiff: snapshotOk ? unifiedDiff(oldBase, newBase, name) : '',
		overrideDiff: snapshotOk ? unifiedDiff(oldBase, override, name) : '',
	};
}

export function formatDriftReport(details, pin) {
	const out = [];
	for (const d of details) {
		const state = !d.snapshotOk ? 'SNAPSHOT TAMPERED OR MISSING' : d.orphaned ? 'ORPHANED (gone upstream)' : d.oldBaseHash === d.newBaseHash ? 'unchanged' : 'CHANGED';
		out.push(`== ${d.id} [${state}] pin ${pin.slice(0, 12)}`);
		if (!d.snapshotOk) continue;
		out.push('-- upstream change (old base snapshot -> new base)', d.upstreamDiff || '(none)');
		out.push('-- brand override vs old base', d.overrideDiff || '(override equals old base)');
	}
	return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------- actions

function loadMutable(layerDir) {
	const manifestPath = path.join(layerDir, 'overlay.manifest.json');
	const manifest = readJson(manifestPath, 'overlay.manifest.json');
	if (manifest?.version !== 1 || !Array.isArray(manifest.entries)) throw new ComposeError('bad-manifest', 'overlay.manifest.json must be { "version": 1, "entries": [...] }');
	return manifest;
}
const writeManifest = (layerDir, manifest) => safeWrite(layerDir, 'overlay.manifest.json', pretty(manifest));

function findEntry(manifest, idOrPath) {
	const e = manifest.entries.find((x) => entryId(x) === idOrPath || (x.kind === 'package-script' && x.key === idOrPath));
	if (!e) throw new ComposeError('no-such-entry', `no manifest entry for ${idOrPath}`);
	if (!isEject(e)) throw new ComposeError('not-an-eject', `${idOrPath} is not an L2 eject`);
	return e;
}

function verifySnapshot(layerDir, e) {
	let buf;
	try {
		buf = readFileSync(path.join(layerDir, 'overlay.base', snapshotKey(e)));
	} catch {
		throw new ComposeError('snapshot-missing', `no base snapshot for ${entryId(e)}`);
	}
	if (sha256(buf) !== e.baseSnapshotHash) throw new ComposeError('snapshot-tampered', `base snapshot of ${entryId(e)} does not match baseSnapshotHash`);
}

/** Record the new upstream base as reviewed: new hashes, new fromPin, new snapshot, resolution text. */
export function accept({ layerDir, base, pin, id, text, now = new Date() }) {
	if (!text || !String(text).trim()) throw new ComposeError('resolution-required', '--accept needs a non-empty --resolution text');
	const manifest = loadMutable(layerDir);
	const e = findEntry(manifest, id);
	verifySnapshot(layerDir, e);
	const nb = baseValueFor(e, base);
	if (nb === null) throw new ComposeError('orphaned-eject', `${id} is gone upstream; use --migrate or --readopt`);
	const h = sha256(nb);
	if (h === e.baseHash) throw new ComposeError('nothing-to-accept', `${id} is unchanged at pin ${pin.slice(0, 12)}`);
	safeWrite(layerDir, `overlay.base/${snapshotKey(e)}`, nb);
	e.baseHash = h;
	e.baseSnapshotHash = h;
	e.fromPin = pin;
	e.resolution = { action: 'accept', at: now.toISOString(), baseHash: h, pin, text: String(text).trim() };
	writeManifest(layerDir, manifest);
	return { id: entryId(e), baseHash: h };
}

/** Drop the override: the base file (or script) is used again; the eject entry and its snapshot are removed. */
export function readopt({ layerDir, pin, id, text = 'readopted base', now = new Date() }) {
	const manifest = loadMutable(layerDir);
	const e = findEntry(manifest, id);
	const eid = entryId(e);
	if (e.kind === 'package-script') {
		const brandPath = path.join(layerDir, 'brand.json');
		const brand = readJson(brandPath, 'brand.json');
		if (brand.packageScripts) delete brand.packageScripts[e.key];
		safeWrite(layerDir, 'brand.json', pretty(brand));
	} else {
		safeRemoveFile(layerDir, `overlay/${e.path}`);
	}
	safeRemoveFile(layerDir, `overlay.base/${snapshotKey(e)}`);
	manifest.entries = manifest.entries.filter((x) => x !== e);
	manifest.resolutions = [...(manifest.resolutions ?? []), { action: 'readopt', at: now.toISOString(), id: eid, pin, text }];
	writeManifest(layerDir, manifest);
	return { id: eid };
}

/** Follow an eject whose base file moved: the override and snapshot move with it, rebased on the new file. */
export function migrate({ layerDir, layers, base, pin, from, to, now = new Date() }) {
	const manifest = loadMutable(layerDir);
	const e = findEntry(manifest, from);
	if (e.kind === 'package-script') throw new ComposeError('not-migratable', 'package-script entries cannot be migrated; use --accept or --readopt');
	if (base.has(from)) throw new ComposeError('not-orphaned', `${from} still exists upstream; use --accept or --readopt`);
	if (!base.has(to)) throw new ComposeError('no-such-base-file', `${to} does not exist in the base at pin ${pin.slice(0, 12)}`);
	if (layerOf(layers, to) !== 'L2') throw new ComposeError('not-l2', `${to} is not an L2 path, so it cannot be an eject target`);
	if (manifest.entries.some((x) => entryId(x) === to)) throw new ComposeError('duplicate-entry', `${to} already has a manifest entry`);
	verifySnapshot(layerDir, e);
	const override = readFileSync(path.join(layerDir, 'overlay', from));
	const nb = base.read(to);
	safeWrite(layerDir, `overlay/${to}`, override);
	safeWrite(layerDir, `overlay.base/${to}`, nb);
	safeRemoveFile(layerDir, `overlay/${from}`);
	safeRemoveFile(layerDir, `overlay.base/${from}`);
	const h = sha256(nb);
	e.path = to;
	e.baseHash = h;
	e.baseSnapshotHash = h;
	e.fromPin = pin;
	e.resolution = { action: 'migrate', at: now.toISOString(), baseHash: h, from, pin, text: `migrated from ${from}` };
	writeManifest(layerDir, manifest);
	return { id: to };
}
