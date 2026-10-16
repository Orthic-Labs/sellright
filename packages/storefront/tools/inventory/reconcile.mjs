// reconcile-<brand>.csv (plan A23): the skeleton generator, the checker and the bridge to compose --inventory.
//
// Columns (fixed order):
//   kind,path,name,status,layer,tracked,counterpart,similarity,export_overlap,related,d7_hits,d7_class,disposition,evidence,reason
//
// Dispositions a human chooses: upstream-fix | base-ahead | brand-specific | drop   (plan A23)
// Dispositions the tool may fill (`reason` starts with "auto:"):
//   identical-to-base   status identical (plan A25a names it as a superseded reason)
//   runtime-preserved   a top-level runtime name (tmp, .cache, .env, .env.local, ...): never composed, never deleted
//   same-as-file        export and route rows only: the row follows its file row's disposition
//   base-ahead          a base-only file (no brand copy; composed from the base)
// `unknown` (or blank) is what an undecided row carries; `check` fails while any row is unknown.
import { isRuntimeName, pretty } from '../compose/lib/util.mjs';

export const COLUMNS = ['kind', 'path', 'name', 'status', 'layer', 'tracked', 'counterpart', 'similarity', 'export_overlap', 'related', 'd7_hits', 'd7_class', 'disposition', 'evidence', 'reason'];
export const HUMAN_DISPOSITIONS = ['upstream-fix', 'base-ahead', 'brand-specific', 'drop'];
export const AUTO_DISPOSITIONS = ['identical-to-base', 'runtime-preserved', 'same-as-file'];
export const D7_CLASSES = ['wire-name', 'legacy-leftover'];
export const UNKNOWN = 'unknown';

export const rowKey = (r) => `${r.kind}\0${r.path}\0${r.name ?? ''}`;

// ------------------------------------------------------------------------------------------------ CSV (RFC 4180)

const needsQuote = /[",\r\n]/;
const cell = (v) => {
	const s = v === null || v === undefined ? '' : String(v);
	return needsQuote.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function renderCsv(records) {
	const lines = [COLUMNS.join(',')];
	for (const r of records) lines.push(COLUMNS.map((c) => cell(r[c])).join(','));
	return `${lines.join('\n')}\n`;
}

/** Parses CSV text into an array of arrays. Handles quoted fields, doubled quotes, CRLF and a missing final newline. */
export function parseCsvRaw(text) {
	const rows = [];
	let row = [];
	let field = '';
	let inQuotes = false;
	let i = 0;
	const endField = () => {
		row.push(field);
		field = '';
	};
	const endRow = () => {
		endField();
		if (!(row.length === 1 && row[0] === '')) rows.push(row);
		row = [];
	};
	while (i < text.length) {
		const ch = text[i];
		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				i++;
				continue;
			}
			field += ch;
			i++;
			continue;
		}
		if (ch === '"') {
			inQuotes = true;
			i++;
		} else if (ch === ',') {
			endField();
			i++;
		} else if (ch === '\r') {
			i++;
		} else if (ch === '\n') {
			endRow();
			i++;
		} else {
			field += ch;
			i++;
		}
	}
	if (inQuotes) throw new Error('csv: unterminated quoted field');
	if (field !== '' || row.length > 0) endRow();
	return rows;
}

export function parseCsv(text) {
	const raw = parseCsvRaw(text);
	if (raw.length === 0) throw new Error('csv: empty file');
	const header = raw[0];
	if (header.length !== COLUMNS.length || header.some((h, i) => h !== COLUMNS[i])) throw new Error(`csv: header must be exactly ${COLUMNS.join(',')}`);
	return raw.slice(1).map((cells, n) => {
		if (cells.length !== COLUMNS.length) throw new Error(`csv: row ${n + 2} has ${cells.length} fields, expected ${COLUMNS.length}`);
		const o = {};
		COLUMNS.forEach((c, i) => {
			o[c] = cells[i];
		});
		return o;
	});
}

// ------------------------------------------------------------------------------------------------ skeleton

function toRecord(r) {
	return {
		kind: r.kind,
		path: r.path,
		name: r.name,
		status: r.status,
		layer: r.layer,
		tracked: r.tracked,
		counterpart: r.counterpart,
		similarity: r.similarity,
		export_overlap: r.exportOverlap,
		related: r.related.join(' | '),
		d7_hits: r.d7HitsText,
		d7_class: r.d7HitsText ? UNKNOWN : '',
		disposition: UNKNOWN,
		evidence: '',
		reason: '',
	};
}

function autoFill(rec, r) {
	if (rec.kind === 'file' && r.runtimeTop) {
		rec.disposition = 'runtime-preserved';
		rec.reason = 'auto: runtime state, never composed and never deleted';
	} else if (rec.status === 'identical') {
		rec.disposition = 'identical-to-base';
		rec.reason = 'auto: same bytes as the base';
	} else if (rec.kind === 'file' && rec.status === 'base-only') {
		rec.disposition = 'base-ahead';
		rec.reason = 'auto: base file with no brand copy; composed from the base';
	} else if (rec.kind !== 'file') {
		rec.disposition = 'same-as-file';
		rec.reason = 'auto: follows the file row';
	}
}

/**
 * The CSV records for a union. `previous` (parsed rows of an earlier CSV) carries decisions over: a row keeps its
 * disposition, evidence, reason and d7_class when its key and status are unchanged; a row whose status changed goes back to
 * unknown with the old decision quoted in `reason`.
 */
export function skeletonRecords(union, previous = null) {
	const prev = new Map((previous ?? []).map((p) => [rowKey(p), p]));
	return union.rows.map((r) => {
		const rec = toRecord(r);
		autoFill(rec, r);
		const old = prev.get(rowKey(rec));
		if (!old) return rec;
		const decided = old.disposition && old.disposition !== UNKNOWN;
		if (old.status === rec.status) {
			if (decided && !old.reason.startsWith('auto:')) {
				rec.disposition = old.disposition;
				rec.evidence = old.evidence;
				rec.reason = old.reason;
			}
			if (rec.d7_class === UNKNOWN && old.d7_class && old.d7_class !== UNKNOWN) rec.d7_class = old.d7_class;
		} else if (decided && !old.reason.startsWith('auto:')) {
			rec.disposition = rec.reason.startsWith('auto:') ? rec.disposition : UNKNOWN;
			if (rec.disposition === UNKNOWN) rec.reason = `status changed ${old.status} -> ${rec.status}; was ${old.disposition}: ${old.reason}`;
		}
		return rec;
	});
}

// ------------------------------------------------------------------------------------------------ check

/**
 * Validates parsed CSV rows against the current union. Returns { problems: [{ code, path, message }], counts }.
 * Failures: missing-row, stale-row, status-changed, unknown-disposition, bad-disposition, reason-required,
 * evidence-required, d7-unclassified, bad-d7-class, follows-bad-file-row, dirty-tree (only with requireClean).
 */
export function checkRecords({ union, records, gitDirty = [], requireClean = false }) {
	const problems = [];
	const add = (code, row, message) => problems.push({ code, path: row.path, kind: row.kind, name: row.name ?? '', message });
	const current = new Map(union.rows.map((r) => [rowKey(r), r]));
	const byKey = new Map();
	for (const rec of records) {
		const k = rowKey(rec);
		if (byKey.has(k)) add('duplicate-row', rec, `row ${rec.kind} ${rec.path} ${rec.name} appears twice`);
		byKey.set(k, rec);
	}
	for (const [k, r] of current) if (!byKey.has(k)) add('missing-row', r, `no CSV row for ${r.kind} ${r.path}${r.name ? ` ${r.name}` : ''}; regenerate with --merge`);
	for (const [k, rec] of byKey) if (!current.has(k)) add('stale-row', rec, `${rec.kind} ${rec.path}${rec.name ? ` ${rec.name}` : ''} is no longer in the union; regenerate with --merge`);

	const fileRecByPath = new Map();
	for (const rec of records) if (rec.kind === 'file') fileRecByPath.set(rec.path, rec);
	const fileRecFor = (row) => {
		const fr = union.fileRowByPath.get(row.path);
		return fr ? byKey.get(rowKey(fr)) : fileRecByPath.get(row.path);
	};

	for (const [k, rec] of byKey) {
		const r = current.get(k);
		if (!r) continue;
		if (rec.status !== r.status) {
			add('status-changed', rec, `CSV says ${rec.status}, the trees say ${r.status}; the decision is stale`);
			continue;
		}
		const d = (rec.disposition ?? '').trim();
		if (d === '' || d === UNKNOWN) {
			add('unknown-disposition', rec, `${rec.kind} ${rec.path}${rec.name ? ` ${rec.name}` : ''} has no disposition`);
		} else if (![...HUMAN_DISPOSITIONS, ...AUTO_DISPOSITIONS].includes(d)) {
			add('bad-disposition', rec, `${d} is not one of ${[...HUMAN_DISPOSITIONS, ...AUTO_DISPOSITIONS].join(', ')}`);
		} else if (d === 'identical-to-base' && r.status !== 'identical') {
			add('bad-disposition', rec, 'identical-to-base is only valid on an identical row');
		} else if (d === 'runtime-preserved' && !(r.kind === 'file' && r.runtimeTop && isRuntimeName(r.path.split('/')[0]))) {
			add('bad-disposition', rec, 'runtime-preserved is only valid on a top-level runtime name');
		} else if (d === 'same-as-file') {
			if (r.kind === 'file') add('bad-disposition', rec, 'same-as-file is only valid on export and route rows');
			else {
				const f = fileRecFor(r);
				const fd = (f?.disposition ?? '').trim();
				if (!f || fd === '' || fd === UNKNOWN || fd === 'same-as-file') add('follows-bad-file-row', rec, `the file row for ${r.path} has no usable disposition to follow`);
			}
		} else if (d === 'drop' && r.status === 'base-only') {
			add('bad-disposition', rec, 'a base-only item cannot be dropped: the base keeps it');
		} else if (HUMAN_DISPOSITIONS.includes(d)) {
			// the tool's own base-ahead on a base-only file (see autoFill) carries its auto marker legitimately
			const toolFilled = d === 'base-ahead' && r.kind === 'file' && r.status === 'base-only';
			if (!(rec.reason ?? '').trim() || (rec.reason.trim().startsWith('auto:') && !toolFilled)) add('reason-required', rec, `${d} needs a written reason`);
			if (d === 'upstream-fix' && !(rec.evidence ?? '').trim()) add('evidence-required', rec, 'upstream-fix needs evidence: the characterization test that fails on the base and passes after the port');
		}
		if (r.d7HitsText) {
			const c = (rec.d7_class ?? '').trim();
			if (c === '' || c === UNKNOWN) add('d7-unclassified', rec, `base file has strict-token hits (${r.d7HitsText}); classify as wire-name or legacy-leftover`);
			else if (!D7_CLASSES.includes(c)) add('bad-d7-class', rec, `${c} is not wire-name or legacy-leftover`);
		}
	}
	if (requireClean && gitDirty.length > 0) {
		problems.push({ code: 'dirty-tree', path: '', kind: 'git', name: '', message: `git status of the build directory is not empty (${gitDirty.length} entries); A25a refuses a dirty tree` });
	}
	const counts = {};
	for (const p of problems) counts[p.code] = (counts[p.code] ?? 0) + 1;
	return { problems, counts };
}

// ------------------------------------------------------------------------------------------------ bridge to compose --inventory

const CLASS_OF = { 'upstream-fix': 'superseded', 'base-ahead': 'superseded', 'identical-to-base': 'superseded', drop: 'dropped', 'brand-specific': 'brand-l3' };

/**
 * `compose.mjs --inventory --dispositions <file>` input: { "<brand path>": { class, reason } } for every file row the
 * brand has (so not base-only), runtime-preserved rows left out (compose classifies them by name). A path with no entry
 * is `unexplained` there, which is the A25a rule.
 */
export function toDispositions(records) {
	const out = {};
	for (const rec of records) {
		if (rec.kind !== 'file' || rec.status === 'base-only') continue;
		const cls = CLASS_OF[rec.disposition];
		if (!cls) continue;
		out[rec.path] = { class: cls, reason: (rec.reason ?? '').trim() || `${rec.disposition}` };
	}
	return out;
}

export const dispositionsText = (records) => pretty(toDispositions(records));
