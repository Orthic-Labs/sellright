// The union of a brand build directory and the base (plan A23): every file, export and route with one status each.
//
//   status: identical | diverged | brand-only | base-only | renamed
//   file rows are keyed by the brand path (a renamed pair is ONE row: path = brand path, counterpart = base path)
//   export rows: one per export name of files that are diverged, renamed or brand-only (base-only too with exportsAll)
//   route rows: one per Qwik City route entry (src/routes/**), by route pattern
//
// Rename rule (v3, plan A23): content similarity >= 0.6 (Dice over normalised non-trivial lines) AND export-name
// overlap (Jaccard over named exports > 0). Two exceptions, both stated: byte-identical content at another path is a
// rename without any export check; a code file with no named export on either side needs similarity >= 0.8. Non-code
// text files need similarity >= 0.8; binaries only match by hash.
import { isRuntimeName } from '../compose/lib/util.mjs';
import { layerOf } from '../compose/lib/layers.mjs';
import { D7_EXTENSIONS, analyzeModule, dice, extOf, formatHits, isCodePath, jaccard, lineBag, routeOf, strictTokenHits } from './analyze.mjs';
import { readText } from './tree.mjs';

export const SIM_CODE = 0.6;
export const SIM_NO_EXPORTS = 0.8;
export const SIM_TEXT = 0.8;
const MAX_RELATED = 3;

const sortStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function safeLayer(layers, rel) {
	if (!layers) return '';
	try {
		return layerOf(layers, rel) ?? '';
	} catch {
		return 'ambiguous';
	}
}

const extClass = (rel) => (isCodePath(rel) ? 'code' : extOf(rel));

/**
 * @param {{ brand: Map, base: Map, layers?: object|null, git?: { inside: boolean, tracked: Set<string> }|null, exportsAll?: boolean }} o
 */
export function buildUnion({ brand, base, layers = null, git = null, exportsAll = false }) {
	const textCache = new Map();
	const text = (side, rel) => {
		const k = `${side}\0${rel}`;
		if (!textCache.has(k)) textCache.set(k, readText((side === 'brand' ? brand : base).get(rel)));
		return textCache.get(k);
	};
	const anaCache = new Map();
	const analysis = (side, rel) => {
		const k = `${side}\0${rel}`;
		if (!anaCache.has(k)) {
			const t = isCodePath(rel) ? text(side, rel) : null;
			let a = null;
			if (t !== null) {
				try {
					a = analyzeModule(rel, t);
				} catch {
					a = null;
				}
			}
			anaCache.set(k, a);
		}
		return anaCache.get(k);
	};
	const bagCache = new Map();
	const bag = (side, rel) => {
		const k = `${side}\0${rel}`;
		if (!bagCache.has(k)) {
			const t = text(side, rel);
			bagCache.set(k, t === null ? null : lineBag(t));
		}
		return bagCache.get(k);
	};
	const namedExports = (side, rel) => {
		const a = analysis(side, rel);
		return new Set(a ? [...a.exports.keys()].filter((n) => n !== 'default') : []);
	};

	// ---- file statuses -------------------------------------------------------------------------------------------
	const status = new Map(); // brand path -> { status, counterpart, similarity, exportOverlap }
	const brandOnly = [];
	const baseOnly = [];
	for (const [p, b] of brand) {
		const a = base.get(p);
		if (!a) brandOnly.push(p);
		else if (b.sha256 !== null && b.sha256 === a.sha256) status.set(p, { status: 'identical', counterpart: '', similarity: 1, exportOverlap: null });
		else status.set(p, { status: 'diverged', counterpart: '', similarity: null, exportOverlap: null });
	}
	for (const p of base.keys()) if (!brand.has(p)) baseOnly.push(p);
	brandOnly.sort(sortStr);
	baseOnly.sort(sortStr);

	const renamableBrand = brandOnly.filter((p) => brand.get(p).kind === 'file' && !brand.get(p).env && brand.get(p).size > 0);
	const usedBrand = new Set();
	const usedBase = new Set();
	const pairs = new Map(); // brand path -> base path

	// 1) byte-identical content at another path
	const baseBySha = new Map();
	for (const p of baseOnly) {
		const s = base.get(p).sha256;
		if (s && base.get(p).size > 0) (baseBySha.get(s) ?? baseBySha.set(s, []).get(s)).push(p);
	}
	for (const p of renamableBrand) {
		const cands = (baseBySha.get(brand.get(p).sha256) ?? []).filter((c) => !usedBase.has(c));
		if (cands.length === 0) continue;
		const stem = p.split('/').at(-1);
		const pick = cands.find((c) => c.split('/').at(-1) === stem) ?? cands[0];
		pairs.set(p, { base: pick, similarity: 1, exportOverlap: null });
		usedBrand.add(p);
		usedBase.add(pick);
	}

	// 2) similar content with the export rule
	const baseByClass = new Map();
	for (const p of baseOnly) {
		if (usedBase.has(p) || base.get(p).size === 0) continue;
		(baseByClass.get(extClass(p)) ?? baseByClass.set(extClass(p), []).get(extClass(p))).push(p);
	}
	const cands = [];
	for (const p of renamableBrand) {
		if (usedBrand.has(p)) continue;
		const bb = bag('brand', p);
		if (!bb) continue;
		const bsize = brand.get(p).size;
		const code = isCodePath(p);
		const bExports = code ? namedExports('brand', p) : null;
		for (const q of baseByClass.get(extClass(p)) ?? []) {
			const ab = bag('base', q);
			if (!ab) continue;
			const ratio = Math.min(bsize, base.get(q).size) / Math.max(bsize, base.get(q).size);
			if (ratio < 0.3) continue;
			const sim = dice(bb, ab);
			if (sim < SIM_CODE) continue;
			if (code) {
				const aExports = namedExports('base', q);
				const overlap = jaccard(bExports, aExports);
				const noNamed = bExports.size === 0 && aExports.size === 0;
				if (!(overlap > 0 || (noNamed && sim >= SIM_NO_EXPORTS))) continue;
				cands.push({ p, q, sim, overlap });
			} else if (sim >= SIM_TEXT) cands.push({ p, q, sim, overlap: null });
		}
	}
	cands.sort((x, y) => y.sim - x.sim || (y.overlap ?? 0) - (x.overlap ?? 0) || sortStr(x.p, y.p) || sortStr(x.q, y.q));
	for (const c of cands) {
		if (usedBrand.has(c.p) || usedBase.has(c.q)) continue;
		pairs.set(c.p, { base: c.q, similarity: c.sim, exportOverlap: c.overlap });
		usedBrand.add(c.p);
		usedBase.add(c.q);
	}
	for (const [p, v] of pairs) status.set(p, { status: 'renamed', counterpart: v.base, similarity: v.similarity, exportOverlap: v.exportOverlap });
	for (const p of brandOnly) if (!status.has(p)) status.set(p, { status: 'brand-only', counterpart: '', similarity: null, exportOverlap: null });

	// ---- related (split / merge candidates by export-name overlap) --------------------------------------------------
	const index = (side, map) => {
		const idx = new Map();
		for (const p of map.keys()) {
			for (const n of namedExports(side, p)) (idx.get(n) ?? idx.set(n, new Set()).get(n)).add(p);
		}
		return idx;
	};
	let brandIdx = null;
	let baseIdx = null;
	const related = (side, p) => {
		const mine = namedExports(side, p);
		if (mine.size === 0) return [];
		const idx = side === 'brand' ? (baseIdx ??= index('base', base)) : (brandIdx ??= index('brand', brand));
		const tally = new Map();
		for (const n of mine) for (const q of idx.get(n) ?? []) tally.set(q, (tally.get(q) ?? 0) + 1);
		return [...tally]
			.filter(([, shared]) => shared >= 2 || shared / mine.size >= 0.5)
			.sort((x, y) => y[1] - x[1] || sortStr(x[0], y[0]))
			.slice(0, MAX_RELATED)
			.map(([q, shared]) => `${q}[shared=${shared}/${mine.size}]`);
	};

	// ---- rows ---------------------------------------------------------------------------------------------------
	const trackedOf = (rel) => (git?.inside ? (git.tracked.has(rel) ? 'yes' : 'no') : 'na');
	const d7Of = (rel) => {
		if (!rel.startsWith('src/') || !D7_EXTENSIONS.has(extOf(rel))) return {};
		const t = text('base', rel);
		return t === null ? {} : strictTokenHits(t);
	};
	const rows = [];
	const fileRowByPath = new Map(); // any path (brand path or renamed base counterpart) -> brand-keyed file row

	for (const [p, s] of status) {
		const info = brand.get(p);
		const r = {
			kind: 'file',
			path: p,
			name: '',
			status: s.status,
			layer: safeLayer(layers, p),
			tracked: trackedOf(p),
			counterpart: s.counterpart,
			similarity: s.similarity === null ? '' : s.similarity.toFixed(2),
			exportOverlap: s.exportOverlap === null ? '' : s.exportOverlap.toFixed(2),
			related: s.status === 'brand-only' ? related('brand', p) : [],
			d7Hits: s.status === 'brand-only' ? {} : d7Of(s.status === 'renamed' ? s.counterpart : p),
			runtimeTop: info.kind === 'runtime' && isRuntimeName(p),
			special: info.kind === 'symlink' || info.kind === 'special' ? info.kind : '',
		};
		rows.push(r);
		fileRowByPath.set(p, r);
		if (s.counterpart) fileRowByPath.set(s.counterpart, r);
	}
	for (const q of baseOnly) {
		if (usedBase.has(q)) continue;
		const r = {
			kind: 'file',
			path: q,
			name: '',
			status: 'base-only',
			layer: safeLayer(layers, q),
			tracked: 'na',
			counterpart: '',
			similarity: '',
			exportOverlap: '',
			related: related('base', q),
			d7Hits: d7Of(q),
			runtimeTop: false,
			special: '',
		};
		rows.push(r);
		fileRowByPath.set(q, r);
	}

	// ---- export rows ----------------------------------------------------------------------------------------------
	const exportRows = [];
	const exportsOf = (side, rel) => {
		const a = analysis(side, rel);
		if (!a) return new Map();
		const m = new Map();
		for (const [n, e] of a.exports) m.set(n, e.kind === 'reexport' ? `reexport:${e.from}#${e.imported}` : e.hash);
		for (const s of a.stars) m.set(`*:${s}`, `star:${s}`);
		return m;
	};
	for (const r of [...rows]) {
		if (r.kind !== 'file' || !isCodePath(r.path)) continue;
		const mineSide = r.status === 'base-only' ? 'base' : 'brand';
		let mine = new Map();
		let theirs = new Map();
		if (r.status === 'diverged') {
			mine = exportsOf('brand', r.path);
			theirs = exportsOf('base', r.path);
		} else if (r.status === 'renamed') {
			mine = exportsOf('brand', r.path);
			theirs = exportsOf('base', r.counterpart);
		} else if (r.status === 'brand-only') mine = exportsOf('brand', r.path);
		else if (r.status === 'base-only' && exportsAll) mine = exportsOf('base', r.path);
		else continue;
		for (const n of [...new Set([...mine.keys(), ...theirs.keys()])].sort(sortStr)) {
			const inMine = mine.has(n);
			const inTheirs = theirs.has(n);
			let st;
			if (inMine && inTheirs) st = mine.get(n) === theirs.get(n) ? 'identical' : 'diverged';
			else if (mineSide === 'base') st = 'base-only';
			else st = inMine ? 'brand-only' : 'base-only';
			exportRows.push({
				kind: 'export',
				path: r.path,
				name: n,
				status: st,
				layer: r.layer,
				tracked: r.tracked,
				counterpart: r.status === 'renamed' ? r.counterpart : '',
				similarity: '',
				exportOverlap: '',
				related: [],
				d7Hits: {},
				runtimeTop: false,
				special: '',
			});
		}
	}

	// ---- route rows -----------------------------------------------------------------------------------------------
	const collectRoutes = (map) => {
		const out = new Map();
		for (const p of map.keys()) {
			const ro = routeOf(p);
			if (ro) out.set(ro.name, { path: p, ...ro });
		}
		return out;
	};
	const brandRoutes = collectRoutes(brand);
	const baseRoutes = collectRoutes(base);
	const routeRows = [];
	for (const n of [...new Set([...brandRoutes.keys(), ...baseRoutes.keys()])].sort(sortStr)) {
		const b = brandRoutes.get(n);
		const a = baseRoutes.get(n);
		let st;
		if (b && a) st = brand.get(b.path).sha256 !== null && brand.get(b.path).sha256 === base.get(a.path).sha256 ? 'identical' : 'diverged';
		else st = b ? 'brand-only' : 'base-only';
		const pathKey = b ? b.path : a.path;
		routeRows.push({
			kind: 'route',
			path: pathKey,
			name: n,
			status: st,
			layer: safeLayer(layers, pathKey),
			tracked: b ? trackedOf(b.path) : 'na',
			counterpart: b && a && a.path !== b.path ? a.path : '',
			similarity: '',
			exportOverlap: '',
			related: [],
			d7Hits: {},
			runtimeTop: false,
			special: '',
		});
	}

	const all = [...rows, ...routeRows, ...exportRows];
	const kindOrder = { file: 0, route: 1, export: 2 };
	all.sort((x, y) => sortStr(x.path, y.path) || kindOrder[x.kind] - kindOrder[y.kind] || sortStr(x.name, y.name));
	for (const r of all) r.d7HitsText = formatHits(r.d7Hits);

	const counts = {};
	for (const r of all) {
		counts[r.kind] ??= {};
		counts[r.kind][r.status] = (counts[r.kind][r.status] ?? 0) + 1;
	}
	return { rows: all, fileRowByPath, counts };
}
