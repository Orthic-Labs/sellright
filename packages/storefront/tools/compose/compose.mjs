#!/usr/bin/env node
// SellRight storefront composition, in place (plan A15, §4.3).
//
//   compose.mjs <brand-layer-dir> --out <build-dir> [--pin <sha>] [--base-dir <dir> | --repo <git repo>]
//               [--layers <layers.json>] [--schema <brand-env.schema.json>] [--require-out-pair]
//               ( --dry-run
//               | --apply [--adopt <adoption-inventory.json>]
//               | --mark-built [--keep <n>]
//               | --restore-inputs <history-id>
//               | --inventory [--dispositions <file>] [--preserve a,b] [--legacy-tag <tag>] [--inventory-out <file>]
//               | --self-check )
//
// Rules the code holds to: never write outside the output root; never follow a
// symlink (lstat everywhere, any symlink in an input tree is an error); never delete a
// file it did not record as managed (plus the inventory's retire list at first
// adoption); never touch node_modules, dist*, server*, .cache, tmp, .env, .env.local,
// the asset-retention archive or anything above the build directory.
import { spawnSync } from 'node:child_process';
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openBase } from './lib/base.mjs';
import { checkClosure } from './closure-check.mjs';
import { checkDrift } from './lib/drift-core.mjs';
import { checkEnv, finalEffectiveHash, loadSchema } from './env-check.mjs';
import { ensureHistoryRoot, entryEffectivePin, historyDirFor, layerHashes, markBuilt, mismatchedHashes, readEntry, replaceLayerWithCopy, verifyEntryCopy, writeEntry } from './lib/history.mjs';
import { buildInventory, checkAdoption, hasNonRuntimeContent } from './lib/inventory.mjs';
import { loadLayer, validateBrand, validateManifest } from './lib/layer.mjs';
import { loadLayers, parseLayers } from './lib/layers.mjs';
import {
	ComposeError,
	Problems,
	hashJson,
	isInside,
	isRuntimeName,
	pretty,
	pruneEmptyDirs,
	readJson,
	realDir,
	safeRemoveFile,
	safeWrite,
	sha256,
	unsafeAncestorReason,
	unsafeRelReason,
} from './lib/util.mjs';

export const TOOL_VERSION = '1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The two overlay checkers, packaged with the tool (byte-identical copies of ../../scripts/, enforced by compose.test.mjs). */
export const CHECKERS_DIR = path.join(HERE, 'checkers');
export const MANAGED = '.compose-managed.json';
export const ADOPTION = '.compose-adoption.json';
export const OVERLAY_LIST = '.compose-overlay-files.txt';
export const REPORT = 'compose-report.json';

/** pnpm-workspace.yaml of the composed tree: one root plus the vendored client, base hardening settings kept. */
export function renderWorkspace(rootYaml) {
	const out = [];
	let skipping = false;
	for (const line of rootYaml.split('\n')) {
		if (/^packages:\s*$/.test(line)) {
			skipping = true;
			continue;
		}
		if (skipping) {
			if (line === '' || /^\s/.test(line)) continue;
			skipping = false;
		}
		out.push(line);
	}
	while (out.length && out[0].trim() === '') out.shift();
	return `packages:\n  - "."\n  - "vendor/storefront-client"\n\n${out.join('\n').replace(/\n*$/, '\n')}`;
}

function patchPackageJson(baseText, scripts, problems, entryKeys) {
	let pkg;
	try {
		pkg = JSON.parse(baseText);
	} catch {
		problems.add('bad-base', 'base package.json is not valid JSON', 'package.json');
		return { text: baseText, patched: [] };
	}
	const indent = /^\{\n(\t+|\s+)"/.exec(baseText)?.[1] ?? '  ';
	const patched = [];
	pkg.scripts ??= {};
	for (const [k, v] of Object.entries(scripts)) {
		if (!entryKeys.has(k)) {
			problems.add('script-undeclared', `packageScripts.${k} has no package-script entry in overlay.manifest.json`, 'brand.json');
			continue;
		}
		if (v === null) delete pkg.scripts[k];
		else pkg.scripts[k] = v;
		patched.push(k);
	}
	for (const k of entryKeys) {
		if (!(k in scripts)) problems.add('script-entry-orphan', `manifest has a package-script entry for ${k} but brand.json packageScripts does not patch it`, 'overlay.manifest.json');
	}
	return { text: `${JSON.stringify(pkg, null, indent)}\n`, patched: patched.sort() };
}

function canonicalOut(p, what) {
	const abs = path.resolve(p);
	if (existsSync(abs)) return realDir(abs, what);
	return path.join(realDir(path.dirname(abs), `parent of ${what}`), path.basename(abs));
}

/**
 * Reads a path in ONE open so nothing can be swapped in between a check and the read: O_NOFOLLOW refuses a
 * symlink atomically (ELOOP), O_NONBLOCK keeps a FIFO from hanging the open, and the type is taken from the
 * opened descriptor. Returns { kind: 'absent' | 'symlink' | 'other' | 'file', buf? }.
 */
function readRegularNoFollow(abs) {
	let fd;
	try {
		fd = openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
	} catch (e) {
		if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { kind: 'absent' };
		if (e.code === 'ELOOP') return { kind: 'symlink' };
		throw e;
	}
	try {
		if (!fstatSync(fd).isFile()) return { kind: 'other' };
		return { kind: 'file', buf: readFileSync(fd) };
	} finally {
		closeSync(fd);
	}
}

function readManaged(outDir) {
	const f = path.join(outDir, MANAGED);
	const got = readRegularNoFollow(f);
	if (got.kind === 'absent') return null;
	if (got.kind !== 'file') throw new ComposeError('bad-managed', `${MANAGED} is not a regular file`);
	const m = JSON.parse(got.buf.toString('utf8'));
	if (m?.version !== 1 || !Array.isArray(m.files)) throw new ComposeError('bad-managed', `${MANAGED} is malformed`);
	return m;
}

async function loadChecker(dir, name, needed) {
	const file = path.join(dir, name);
	if (!existsSync(file)) return { error: `${name} is not packaged with the tool (looked in ${dir})` };
	let mod;
	try {
		mod = await import(pathToFileURL(file).href);
	} catch (e) {
		return { error: `${name} could not be loaded: ${e.message}` };
	}
	const missing = needed.filter((n) => typeof mod[n] !== 'function');
	if (missing.length) return { error: `${name} lacks ${missing.join(', ')}` };
	return { mod };
}

const SHAPE_KEYS = ['definitionCalls', 'networkGlobals', 'networkMethods', 'globalObjects', 'orchestrationCalls', 'gatewayNamePattern'];

/**
 * Import/layer check (A14) and code-shape check (A14) on every overlay-origin file, run on a scratch
 * materialisation of the planned tree so the resolver sees the base files too. Both checkers ship
 * inside the tool (tools/compose/checkers), so the cold tool home has them. A checker that cannot
 * run is a PROBLEM (apply and dry-run both fail), never a pass and never a skip.
 * Deploy files (brand.json deployFiles, already validated by validateManifest) are the one place an
 * overlay code file may sit in no layer; every storefront source file stays strictly classified.
 */
async function runCheckers({ outputs, layersPath, layersText, deployFiles, checkersDir, problems }) {
	const dir = checkersDir ?? CHECKERS_DIR;
	const result = { importCheck: { status: 'unavailable' }, shapeCheck: { status: 'unavailable' } };
	const unavailable = (key, code, file, note) => {
		result[key] = { status: 'unavailable', note };
		problems.add(code, note, file);
	};
	const imports = await loadChecker(dir, 'check-imports.mjs', ['checkOverlayImports', 'loadLayers']);
	const shape = await loadChecker(dir, 'check-code-shape.mjs', ['checkOverlayShape']);
	if (imports.error) unavailable('importCheck', 'import-check-unavailable', 'check-imports.mjs', imports.error);
	if (shape.error) unavailable('shapeCheck', 'shape-check-unavailable', 'check-code-shape.mjs', shape.error);
	if (imports.error || shape.error) return result;

	const tmp = mkdtempSync(path.join(tmpdir(), 'compose-imports-'));
	try {
		for (const [rel, o] of outputs) safeWrite(tmp, rel, o.buf, o.mode);
		let layersFile = layersPath;
		if (!layersFile) {
			layersFile = path.join(tmp, '.compose-checker-layers.json');
			writeFileSync(layersFile, layersText);
		}
		let layers;
		try {
			layers = imports.mod.loadLayers(layersFile);
		} catch (e) {
			const note = `layers.json is not in the checkers' format: ${e.message}`;
			unavailable('importCheck', 'import-check-unavailable', 'layers.json', note);
			unavailable('shapeCheck', 'shape-check-unavailable', 'layers.json', note);
			return result;
		}
		const files = [...outputs].filter(([, o]) => o.origin === 'overlay' || o.origin === 'eject').map(([k]) => k).sort();

		try {
			const res = imports.mod.checkOverlayImports({ root: tmp, layers, files, deployFiles });
			for (const f of res.findings ?? []) problems.add('import-check', `${f.rule}: ${f.message}`, f.file);
			result.importCheck = { status: res.findings?.length ? 'failed' : 'passed', checked: res.checked ?? files.length };
		} catch (e) {
			unavailable('importCheck', 'import-check-unavailable', 'check-imports.mjs', `check-imports.mjs failed to run: ${e.message}`);
		}

		const cs = layers.codeShape;
		const missingKeys = SHAPE_KEYS.filter((k) => cs?.[k] === undefined);
		if (missingKeys.length) {
			unavailable('shapeCheck', 'shape-check-unavailable', 'layers.json', `layers.json codeShape lacks ${missingKeys.join(', ')}`);
			return result;
		}
		try {
			const res = shape.mod.checkOverlayShape({ root: tmp, layers, files });
			for (const f of res.findings ?? []) problems.add('shape-check', `${f.rule}: ${f.message}`, f.file);
			result.shapeCheck = { status: res.findings?.length ? 'failed' : 'passed', checked: res.checked ?? files.length };
		} catch (e) {
			unavailable('shapeCheck', 'shape-check-unavailable', 'check-code-shape.mjs', `check-code-shape.mjs failed to run: ${e.message}`);
		}
		return result;
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/** Builds the full plan in memory and validates it. Writes nothing. */
export async function plan(opts) {
	const mode = opts.mode ?? 'dry-run';
	const now = opts.now ?? new Date();
	const layer = loadLayer(opts.layerDir);
	const problems = new Problems();
	validateBrand(layer.brand, problems);
	problems.throwIfAny();
	const brand = layer.brand;
	const pin = opts.pin ?? brand.pin;
	const base = openBase({ baseDir: opts.baseDir, repo: opts.repo ?? '/home/vendure/sites/sellright', pin, baseExclude: brand.baseExclude });
	try {
		const outDir = canonicalOut(opts.outDir, 'output directory');
		if (isInside(layer.dir, outDir) || isInside(outDir, layer.dir)) problems.add('overlap', `output ${outDir} and layer ${layer.dir} overlap`);
		if (isInside(base.root, outDir) || isInside(outDir, base.root)) problems.add('overlap', `output ${outDir} and base ${base.root} overlap`);
		if (opts.requireOutPair && outDir !== path.join(path.dirname(layer.dir), brand.buildDir)) {
			problems.add('out-mismatch', `--out must equal ${path.join(path.dirname(layer.dir), brand.buildDir)}`);
		}
		problems.throwIfAny();

		let layers;
		let layersText = null;
		if (opts.layersPath) layers = loadLayers(opts.layersPath);
		else {
			const b = base.read('layers.json');
			if (!b) throw new ComposeError('missing-file', 'no --layers given and the base has no layers.json');
			layersText = b.toString('utf8');
			layers = parseLayers(JSON.parse(layersText));
		}
		let schema;
		if (opts.schemaPath) schema = loadSchema(opts.schemaPath);
		else {
			const b = base.read('brand-env.schema.json');
			if (!b) throw new ComposeError('missing-file', 'no --schema given and the base has no brand-env.schema.json');
			schema = JSON.parse(b.toString('utf8'));
		}

		validateManifest({ layer, layers, base, problems });
		const drift = checkDrift({ layer, base, pin, problems });
		const env = await checkEnv({ schema, brand, buildDir: outDir, loadEnv: opts.loadEnv, problems });
		const workspaceYaml = base.readRoot('pnpm-workspace.yaml');
		if (!workspaceYaml) problems.add('bad-base', 'base has no root pnpm-workspace.yaml', 'pnpm-workspace.yaml');
		problems.throwIfAny();

		// ---- outputs: path -> { buf, mode, origin }
		const outputs = new Map();
		for (const [rel, f] of base.files) {
			if (rel === 'package.json') continue;
			outputs.set(rel, { buf: readFileSync(f.abs), mode: f.mode & 0o111 ? 0o755 : 0o644, origin: 'base' });
		}
		const ejectPaths = new Set((layer.manifest.entries ?? []).filter((e) => (e.kind ?? 'file') === 'file' && e.layer === 'L2').map((e) => e.path));
		for (const [rel, f] of layer.overlay) {
			outputs.set(rel, { buf: readFileSync(f.abs), mode: f.mode & 0o111 ? 0o755 : 0o644, origin: ejectPaths.has(rel) ? 'eject' : 'overlay' });
		}
		const entryKeys = new Set((layer.manifest.entries ?? []).filter((e) => e.kind === 'package-script').map((e) => e.key));
		const pj = patchPackageJson(base.read('package.json').toString('utf8'), brand.packageScripts ?? {}, problems, entryKeys);
		outputs.set('package.json', { buf: Buffer.from(pj.text), mode: 0o644, origin: 'generated' });
		if (workspaceYaml) outputs.set('pnpm-workspace.yaml', { buf: Buffer.from(renderWorkspace(workspaceYaml.toString('utf8'))), mode: 0o644, origin: 'generated' });
		outputs.set('pnpm-lock.yaml', { buf: layer.lockBuf, mode: 0o644, origin: 'overlay' });
		outputs.set('.env.production', { buf: Buffer.from(env.envProduction), mode: 0o600, origin: 'generated' });
		const overlayList = [...outputs].filter(([, o]) => o.origin === 'overlay' || o.origin === 'eject').map(([k]) => k).filter((k) => k !== 'pnpm-lock.yaml').sort();
		outputs.set(OVERLAY_LIST, { buf: Buffer.from(overlayList.length ? `${overlayList.join('\n')}\n` : ''), mode: 0o644, origin: 'generated' });
		for (const rel of outputs.keys()) {
			const top = rel.split('/')[0];
			if (rel !== '.env.production' && (isRuntimeName(top) || top.startsWith('.env'))) problems.add('protected-path', `${rel} is runtime state and may not be composed`, rel);
		}
		problems.throwIfAny();

		// ---- closure (in memory, before anything is written)
		const fileBufs = new Map([...outputs].map(([k, v]) => [k, v.buf]));
		const closure = checkClosure({
			files: fileBufs,
			brand,
			problems,
			externalExists: (x) => existsSync(x.startsWith('/') ? x : path.join(outDir, x)),
		});
		const { importCheck, shapeCheck } = await runCheckers({ outputs, layersPath: opts.layersPath, layersText, deployFiles: brand.deployFiles ?? [], checkersDir: opts.checkersDir, problems });

		// ---- disk state and the adoption guard
		const managed = readManaged(outDir);
		const prev = new Map((managed?.files ?? []).map((f) => [f.path, f.sha256]));
		for (const p of prev.keys()) {
			const r = unsafeRelReason(p);
			if (r) problems.add('bad-managed', `${MANAGED} lists an unsafe path ${JSON.stringify(p)}: ${r}`, MANAGED);
		}
		problems.throwIfAny();
		let inventory = null;
		const notes = [];
		const legacy = !managed && hasNonRuntimeContent(outDir);
		if (legacy) {
			if (opts.adoptFile) {
				inventory = readJson(opts.adoptFile, 'adoption inventory');
				const composedShas = new Map([...outputs].map(([k, v]) => [k, sha256(v.buf)]));
				const adoptProblems = new Problems();
				checkAdoption({ inventory, outDir, composed: composedShas, problems: adoptProblems });
				for (const p of adoptProblems.list) (mode === 'apply' ? problems : { add: (c, m, f) => notes.push(`[${c}] ${f ? `${f}: ` : ''}${m}`) }).add(p.code, p.message, p.file);
			} else if (mode === 'apply') {
				problems.add('adoption-required', `${outDir} holds a legacy or foreign tree (no ${MANAGED}); --apply refuses without --adopt <inventory.json>`);
			} else {
				notes.push('adoption required: the build directory holds a legacy tree; a plain --apply will refuse without --adopt');
			}
		}
		const changes = [];
		const dirOk = new Set();
		for (const [rel, o] of [...outputs].sort(([a], [b]) => (a < b ? -1 : 1))) {
			const abs = path.join(outDir, rel);
			const found = readRegularNoFollow(abs);
			const want = sha256(o.buf);
			let action = 'add';
			if (found.kind !== 'absent') {
				if (found.kind === 'symlink') problems.add('symlink', `output target is a symlink: ${rel}`, rel);
				else if (found.kind !== 'file') problems.add('not-a-file', `output target is not a regular file: ${rel}`, rel);
				else {
					const have = sha256(found.buf);
					if (have === want) action = 'unchanged';
					else if (prev.has(rel)) action = 'change';
					else {
						action = 'overwrite-unmanaged';
						if (!inventory && mode === 'apply') problems.add('unmanaged-collision', `${rel} exists, is not managed and differs from the composed content`, rel);
					}
				}
			}
			const parts = rel.split('/');
			for (let i = 1; i < parts.length; i++) {
				const d = parts.slice(0, i).join('/');
				if (dirOk.has(d)) continue;
				try {
					const s = lstatSync(path.join(outDir, d));
					if (s.isSymbolicLink()) problems.add('symlink', `output ancestor is a symlink: ${d}`, rel);
					else if (!s.isDirectory()) problems.add('not-a-dir', `output ancestor is not a directory: ${d}`, rel);
				} catch {
					/* absent: created at write time */
				}
				dirOk.add(d);
			}
			if (action !== 'unchanged') changes.push({ path: rel, action });
		}
		const removals = [...prev.keys()].filter((p) => !outputs.has(p) && p !== REPORT && !isRuntimeName(p.split('/')[0])).sort();
		const retire = inventory?.retire ?? [];
		// every path apply may delete is validated now, ancestors included, before any mutation
		for (const rel of [...retire, ...removals]) {
			const bad = unsafeRelReason(rel) ?? unsafeAncestorReason(outDir, rel);
			if (bad) problems.add(bad.includes('symlink') ? 'symlink' : bad.includes('ancestor') ? 'not-a-dir' : 'unsafe-path', `refusing to remove ${rel}: ${bad}`, rel);
		}

		// ---- report (deterministic: no timestamps)
		const counts = {};
		for (const o of outputs.values()) counts[o.origin] = (counts[o.origin] ?? 0) + 1;
		const hashes = {
			pin,
			overlayTree: layer.overlayTreeHash,
			manifest: layer.manifestSha,
			lock: layer.lockSha,
			publicConfig: env.hash,
			brandPublicConfig: layerHashes({ layer, pin, toolVersion: TOOL_VERSION }).brandPublicConfig,
			settings: env.settingsHash,
			baseTree: base.treeHash,
			tool: TOOL_VERSION,
		};
		const report = {
			version: 1,
			brand: brand.brand,
			pin,
			hashes,
			patchedScriptKeys: pj.patched,
			originCounts: counts,
			optionalInputs: { '.npmrc': { present: base.has('.npmrc') } },
			env: { names: env.names, settings: env.settings, warnings: env.warnings },
			drift: drift.map((d) => ({ id: d.id, status: d.status })),
			closure: { scanned: closure.scanned.length, usedExternals: closure.usedExternals, externalsMissing: closure.externalsMissing, unresolved: closure.unresolved, generatedArtifacts: closure.generatedArtifacts, excludedTooling: closure.excludedTooling },
			importCheck,
			shapeCheck,
		};
		outputs.set(REPORT, { buf: Buffer.from(pretty(report)), mode: 0o644, origin: 'generated' });
		const managedFiles = [...outputs].map(([p, o]) => ({ path: p, sha256: sha256(o.buf), origin: o.origin })).sort((a, b) => (a.path < b.path ? -1 : 1));
		const managedText = pretty({ version: 1, pin, files: managedFiles });
		if (!changes.some((c) => c.path === REPORT)) {
			const rp = path.join(outDir, REPORT);
			let same = false;
			try {
				same = sha256(readFileSync(rp)) === sha256(outputs.get(REPORT).buf);
			} catch {
				/* absent */
			}
			if (!same) changes.push({ path: REPORT, action: existsSync(rp) ? (prev.has(REPORT) ? 'change' : 'overwrite-unmanaged') : 'add' });
		}
		problems.throwIfAny();
		return { mode, now, layer, brand, pin, base, outDir, layers, schema, outputs, env, hashes, report, managed, managedFiles, managedText, changes, removals, retire, inventory, notes, legacy, problems, closure, drift };
	} catch (e) {
		base.cleanup();
		throw e;
	}
}

function writeAll(ctx) {
	const { outDir, outputs } = ctx;
	for (const [rel, o] of [...outputs].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const abs = path.join(outDir, rel);
		try {
			const cur = readRegularNoFollow(abs);
			if (cur.kind === 'file' && sha256(cur.buf) === sha256(o.buf)) continue;
		} catch {
			/* absent */
		}
		safeWrite(outDir, rel, o.buf, o.mode);
	}
}

/** --apply */
export async function apply(opts) {
	const ctx = await plan({ ...opts, mode: 'apply' });
	try {
		ensureHistoryRoot(historyDirFor(ctx.layer.dir));
		if (!existsSync(ctx.outDir)) mkdirSync(ctx.outDir);
		const hashes = { ...layerHashes({ layer: ctx.layer, pin: ctx.pin, toolVersion: TOOL_VERSION }), publicConfig: ctx.env.hash, settings: ctx.hashes.settings };
		const historyId = writeEntry({ layerDir: ctx.layer.dir, layer: ctx.layer, hashes, managedText: ctx.managedText, now: ctx.now });

		// first adoption: retire only the inventory's list (checked tracked legacy files)
		const retired = [];
		for (const rel of ctx.retire) {
			if (safeRemoveFile(ctx.outDir, rel)) {
				retired.push(rel);
				pruneEmptyDirs(ctx.outDir, rel);
			}
		}
		writeAll(ctx);
		const removed = [];
		for (const rel of ctx.removals) {
			if (safeRemoveFile(ctx.outDir, rel)) {
				removed.push(rel);
				pruneEmptyDirs(ctx.outDir, rel);
			}
		}
		safeWrite(ctx.outDir, MANAGED, ctx.managedText);

		for (const [rel, o] of ctx.outputs) {
			if (sha256(readFileSync(path.join(ctx.outDir, rel))) !== sha256(o.buf)) throw new ComposeError('write-verify', `${rel} on disk differs from the plan after writing`);
		}

		// adoption record: written at first adoption, additions recomputed on every apply
		const adoptionPath = path.join(ctx.outDir, ADOPTION);
		let adoption = null;
		if (ctx.inventory) {
			adoption = {
				version: 1,
				legacyTag: ctx.inventory.legacyTag,
				legacyCommit: ctx.inventory.legacyCommit,
				inventoryHash: hashJson(ctx.inventory),
				legacyTreePaths: ctx.inventory.legacyTreePaths,
				retired,
				preserved: ctx.inventory.rows.filter((r) => r.class === 'runtime-preserved').map((r) => r.path).sort(),
			};
		} else if (existsSync(adoptionPath)) {
			adoption = JSON.parse(readFileSync(adoptionPath, 'utf8'));
		}
		if (adoption) {
			const legacy = new Set(adoption.legacyTreePaths ?? []);
			const written = new Set([...ctx.outputs.keys(), MANAGED, ADOPTION]);
			adoption.additions = [...written].filter((p) => !legacy.has(p)).sort();
			const text = pretty(adoption);
			safeWrite(ctx.outDir, ADOPTION, text);
			safeWrite(historyDirFor(ctx.layer.dir), 'compose-adoption.json', text);
		}

		const finalHash = await finalEffectiveHash({ buildDir: ctx.outDir, loadEnv: opts.loadEnv });
		if (finalHash !== ctx.env.hash) throw new ComposeError('effective-config-mismatch', 'the effective public config read back from the build directory differs from the planned one');
		return { historyId, changes: ctx.changes, removed, retired, hashes, report: ctx.report };
	} finally {
		ctx.base.cleanup();
	}
}

/** --dry-run */
export async function dryRun(opts) {
	const ctx = await plan({ ...opts, mode: 'dry-run' });
	try {
		return { changes: ctx.changes, removals: ctx.removals, notes: ctx.notes, hashes: ctx.hashes, report: ctx.report, legacy: ctx.legacy };
	} finally {
		ctx.base.cleanup();
	}
}

/** --restore-inputs: replaces the brand layer with a history copy; composes nothing, writes no output tree. */
export function restoreInputs({ layerDir, historyId, toolVersion = TOOL_VERSION }) {
	const layerReal = realDir(layerDir, 'brand layer');
	const entry = readEntry(layerReal, historyId);
	const fromDir = (dir) => {
		const l = loadLayer(dir);
		return layerHashes({ layer: l, pin: l.brand.pin, toolVersion });
	};
	const bad = verifyEntryCopy(entry, fromDir);
	if (bad.length) throw new ComposeError('history-tampered', `history copy ${historyId} does not match its recorded hashes (${bad.join(', ')}); the brand layer was not touched`);
	replaceLayerWithCopy({ layerDir: layerReal, entry });
	const after = fromDir(layerReal);
	const badAfter = mismatchedHashes(entry, after);
	if (badAfter.length) throw new ComposeError('restore-mismatch', `restored layer does not match ${historyId} (${badAfter.join(', ')})`);
	// the pin the saved output was composed at; it can differ from brand.json's pin (a --pin override)
	const pin = entryEffectivePin(entry);
	return { id: historyId, hashes: after, pin, pinOverride: pin !== after.brandPin };
}

/** --inventory: classify the build directory against the composed set (A25a step 2). */
export async function inventory(opts) {
	const ctx = await plan({ ...opts, mode: 'inventory' });
	try {
		const composed = new Map([...ctx.outputs].map(([k, v]) => [k, sha256(v.buf)]));
		let tracked = null;
		let dirty = false;
		let legacyTreePaths = [];
		let legacyCommit = null;
		const git = (args) => spawnSync('git', ['-C', ctx.outDir, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
		if (git(['rev-parse', '--is-inside-work-tree']).stdout?.trim() === 'true') {
			tracked = new Set(git(['ls-files', '-z', '--', '.']).stdout.split('\0').filter(Boolean));
			dirty = git(['status', '--porcelain', '--', '.']).stdout.trim() !== '';
			if (opts.legacyTag) {
				const t = git(['ls-tree', '-r', '--name-only', opts.legacyTag, '--', '.']);
				if (t.status !== 0) throw new ComposeError('bad-tag', `legacy tag ${opts.legacyTag} not usable: ${t.stderr}`);
				legacyTreePaths = t.stdout.split('\n').filter(Boolean);
				legacyCommit = git(['rev-parse', `${opts.legacyTag}^{commit}`]).stdout.trim();
			}
		}
		const dispositions = opts.dispositions ? readJson(opts.dispositions, 'dispositions') : {};
		const inv = buildInventory({ outDir: ctx.outDir, composed, dispositions, preserved: opts.preserve ?? [], tracked, legacyTreePaths, legacyTag: opts.legacyTag, legacyCommit, dirty });
		const out = opts.inventoryOut ?? path.join(historyDirFor(ctx.layer.dir), 'adoption-inventory.json');
		if (path.dirname(out) === historyDirFor(ctx.layer.dir)) ensureHistoryRoot(path.dirname(out));
		else mkdirSync(path.dirname(out), { recursive: true });
		safeWrite(path.dirname(out), path.basename(out), pretty(inv));
		return { inventory: inv, file: out, unexplained: inv.rows.filter((r) => r.class === 'unexplained').length };
	} finally {
		ctx.base.cleanup();
	}
}

/** typescript and vite must resolve inside the tool home (the directory holding compose.mjs). */
export function selfCheck({ resolve = (s) => import.meta.resolve(s), toolHome = HERE } = {}) {
	const home = realpathSync(toolHome);
	const result = { toolHome: home, ok: true, resolved: {} };
	for (const name of ['typescript', 'vite']) {
		let p;
		try {
			p = fileURLToPath(resolve(name));
			p = realpathSync(p);
		} catch (e) {
			result.ok = false;
			result.resolved[name] = `unresolvable (${e.code ?? e.message})`;
			continue;
		}
		result.resolved[name] = p;
		if (!isInside(path.join(home, 'node_modules'), p) && !isInside(home, p)) result.ok = false;
	}
	return result;
}

// -------------------------------------------------------------------- CLI
function parseArgs(argv) {
	const o = { positional: [], flags: new Set(), values: new Map() };
	const withValue = new Set(['--out', '--pin', '--base-dir', '--repo', '--layers', '--schema', '--adopt', '--restore-inputs', '--keep', '--dispositions', '--preserve', '--legacy-tag', '--inventory-out']);
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (withValue.has(a)) {
			if (i + 1 >= argv.length) throw new ComposeError('bad-args', `${a} needs a value`);
			o.values.set(a, argv[++i]);
		} else if (a.startsWith('--')) o.flags.add(a);
		else o.positional.push(a);
	}
	return o;
}

function printChanges(r) {
	for (const c of r.changes) console.log(`${c.action.padEnd(20)} ${c.path}`);
	for (const p of r.removals ?? []) console.log(`${'remove'.padEnd(20)} ${p}`);
	for (const n of r.notes ?? []) console.log(`note: ${n}`);
	console.log(`pin ${r.hashes.pin}  overlay ${r.hashes.overlayTree.slice(0, 12)}  manifest ${r.hashes.manifest.slice(0, 12)}  lock ${r.hashes.lock.slice(0, 12)}  publicConfig ${r.hashes.publicConfig.slice(0, 12)}`);
}

export async function main(argv) {
	const a = parseArgs(argv);
	if (a.flags.has('--self-check')) {
		const r = selfCheck();
		console.log(`tool home: ${r.toolHome}`);
		for (const [k, v] of Object.entries(r.resolved)) console.log(`${k}: ${v}`);
		return r.ok ? 0 : 1;
	}
	const [layerDir] = a.positional;
	const modes = ['--dry-run', '--apply', '--mark-built', '--inventory'].filter((f) => a.flags.has(f)).concat(a.values.has('--restore-inputs') ? ['--restore-inputs'] : []);
	if (!layerDir || modes.length !== 1) {
		console.error('usage: compose.mjs <brand-layer-dir> --out <build-dir> (--dry-run | --apply [--adopt f] | --mark-built | --restore-inputs <id> | --inventory | --self-check)');
		return 2;
	}
	const common = {
		layerDir,
		outDir: a.values.get('--out'),
		pin: a.values.get('--pin'),
		baseDir: a.values.get('--base-dir'),
		repo: a.values.get('--repo'),
		layersPath: a.values.get('--layers'),
		schemaPath: a.values.get('--schema'),
		requireOutPair: a.flags.has('--require-out-pair'),
	};
	const needOut = !a.values.has('--restore-inputs');
	if (needOut && !common.outDir) {
		console.error('--out is mandatory');
		return 2;
	}
	const mode = modes[0];
	if (mode === '--dry-run') {
		const r = await dryRun(common);
		printChanges(r);
		console.log('dry run: nothing written');
		return 0;
	}
	if (mode === '--apply') {
		const r = await apply({ ...common, adoptFile: a.values.get('--adopt') });
		printChanges({ changes: r.changes, removals: r.removed.map((p) => p), notes: [], hashes: r.hashes });
		console.log(`history entry ${r.historyId} (status applied); run --mark-built after the build succeeds`);
		return 0;
	}
	if (mode === '--mark-built') {
		const layerReal = realDir(layerDir, 'brand layer');
		const id = markBuilt({ layerDir: layerReal, outDir: realDir(common.outDir, 'output directory'), now: new Date(), keepBuilt: Number(a.values.get('--keep') ?? 3) });
		console.log(`history entry ${id} marked built`);
		return 0;
	}
	if (mode === '--restore-inputs') {
		const r = restoreInputs({ layerDir, historyId: a.values.get('--restore-inputs') });
		console.log(`brand layer restored from ${r.id}; hashes verified (pin ${r.pin.slice(0, 12)}). Run the build entry to compose these inputs${r.pinOverride ? ` with --pin ${r.pin} (the saved output was composed at a pin different from brand.json's ${r.hashes.brandPin.slice(0, 12)})` : ''}.`);
		return 0;
	}
	const r = await inventory({
		...common,
		dispositions: a.values.get('--dispositions'),
		preserve: a.values.get('--preserve')?.split(',').filter(Boolean),
		legacyTag: a.values.get('--legacy-tag'),
		inventoryOut: a.values.get('--inventory-out'),
	});
	console.log(`inventory written to ${r.file}: ${r.inventory.rows.length} rows, ${r.unexplained} unexplained, status ${r.inventory.status}`);
	return r.unexplained > 0 || r.inventory.status !== 'ok' ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then(
		(c) => process.exit(c),
		(e) => {
			console.error(e instanceof ComposeError ? e.message : e.stack);
			process.exit(1);
		},
	);
}
