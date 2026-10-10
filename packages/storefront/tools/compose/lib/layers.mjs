// layers.json reader and path classifier. Same semantics as scripts/check-imports.mjs
// (classify / matchGlob), re-implemented here because the cold tool home archives
// tools/compose only. Shape (version 1):
//   { "version": 1,
//     "layers": { "L1": { "include": [globs], "exclude": [globs] }, "L2": {...}, "L3": {...} },
//     "assetExceptions": [{ "path": glob, "layer": "L1|L2|L3" }] }
// Globs match per path segment: `*` and `?` never cross `/`, `**` as a whole segment
// matches zero or more segments, `[` and `]` are literal. `exclude` removes a path from
// the layer it is listed under and never assigns it elsewhere. A path claimed by two
// layers (an assetException counts as a claim for its layer) throws; none returns null.
import { ComposeError, readJson } from './util.mjs';

const LAYER_NAMES = ['L1', 'L2', 'L3'];

function checkGlob(g, where) {
	if (typeof g !== 'string' || g === '') throw new ComposeError('bad-layers', `layers.json ${where}: empty glob`);
	if (g.startsWith('/') || g.includes('\\') || g.split('/').some((s) => s === '' || s === '.' || s === '..')) {
		throw new ComposeError('bad-layers', `layers.json ${where}: glob must be relative and normalised: ${g}`);
	}
	for (const seg of g.split('/')) {
		if (seg.includes('**') && seg !== '**') throw new ComposeError('bad-layers', `layers.json ${where}: '**' must be a whole segment: ${g}`);
	}
}

export function parseLayers(raw) {
	if (!raw || typeof raw !== 'object' || raw.version !== 1) throw new ComposeError('bad-layers', 'layers.json must be an object with "version": 1');
	const layers = {};
	for (const n of LAYER_NAMES) {
		const def = raw.layers?.[n];
		if (!def || !Array.isArray(def.include) || def.include.length === 0) throw new ComposeError('bad-layers', `layers.json: layer ${n} needs a non-empty include list`);
		def.include.forEach((g) => checkGlob(g, `${n}.include`));
		(def.exclude ?? []).forEach((g) => checkGlob(g, `${n}.exclude`));
		layers[n] = { include: [...def.include], exclude: [...(def.exclude ?? [])] };
	}
	const exceptions = [];
	for (const e of raw.assetExceptions ?? []) {
		checkGlob(e?.path, 'assetExceptions');
		if (!LAYER_NAMES.includes(e.layer)) throw new ComposeError('bad-layers', `layers.json: assetException ${e.path} has unknown layer ${e.layer}`);
		exceptions.push({ path: e.path, layer: e.layer });
	}
	return { layers, exceptions };
}

export function loadLayers(file) {
	return parseLayers(readJson(file, 'layers.json'));
}

const segmentCache = new Map();
function segmentRegex(seg) {
	let re = segmentCache.get(seg);
	if (!re) {
		const body = seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
		re = new RegExp(`^${body}$`);
		segmentCache.set(seg, re);
	}
	return re;
}

function matchSegments(pats, pi, segs, si) {
	if (pi === pats.length) return si === segs.length;
	if (pats[pi] === '**') {
		for (let k = si; k <= segs.length; k++) if (matchSegments(pats, pi + 1, segs, k)) return true;
		return false;
	}
	if (si === segs.length) return false;
	return segmentRegex(pats[pi]).test(segs[si]) && matchSegments(pats, pi + 1, segs, si + 1);
}

export function matchesPattern(pattern, relPath) {
	return matchSegments(pattern.split('/'), 0, relPath.split('/'), 0);
}

/** 'L1' | 'L2' | 'L3' | null. Throws ComposeError('ambiguous-layer') when two layers claim the path. */
export function layerOf(parsed, relPath) {
	const hit = new Set();
	for (const n of LAYER_NAMES) {
		const def = parsed.layers[n];
		if (!def.include.some((g) => matchesPattern(g, relPath))) continue;
		if (def.exclude.some((g) => matchesPattern(g, relPath))) continue;
		hit.add(n);
	}
	for (const e of parsed.exceptions) if (matchesPattern(e.path, relPath)) hit.add(e.layer);
	if (hit.size > 1) throw new ComposeError('ambiguous-layer', `${relPath} matches more than one layer (${[...hit].join(', ')})`);
	return hit.size === 1 ? [...hit][0] : null;
}
