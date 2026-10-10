#!/usr/bin/env node
// Union inventory per brand (plan A23). Read-only on both trees; writes only to the explicit --out / --json-out paths.
//
//   inventory.mjs --base <dir> --brand <dir> --out <reconcile.csv> [--merge <old.csv>] [--json-out <file>]
//        [--layers <layers.json>] [--exports-all] [--no-git]
//       Walks every path of the brand build directory (tracked and untracked; excludes node_modules, dist*, server*,
//       .git; .env* listed by name and size, never read) against the base, writes the reconcile CSV skeleton.
//   inventory.mjs --base <dir> --brand <dir> --reconcile <csv> --check [--require-clean]
//       Exit 0 only when every union row has a valid disposition (no "unknown") and the CSV matches the trees.
//   inventory.mjs --base <dir> --brand <dir> --reconcile <csv> --dispositions --out <file.json>
//       After a passing check, writes the dispositions file for `compose.mjs --inventory --dispositions` (A25a).
//
//   --base accepts a storefront package directory, a repo-layout directory (holds packages/storefront), or, with --pin
//   [--repo <git repo>], a git archive of that pin (default repo /home/vendure/sites/sellright).
//   --out may not be inside the base or brand directory.
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLayers } from '../compose/lib/layers.mjs';
import { ComposeError, isInside, realDir, safeWrite, readJson, pretty } from '../compose/lib/util.mjs';
import { checkRecords, dispositionsText, parseCsv, renderCsv, skeletonRecords } from './reconcile.mjs';
import { buildUnion } from './union.mjs';
import { gitInfo, loadBaseTree, walkBrand } from './tree.mjs';

const WITH_VALUE = new Set(['--base', '--brand', '--out', '--json-out', '--merge', '--reconcile', '--layers', '--pin', '--repo']);
const USAGE = 'usage: inventory.mjs --base <dir> --brand <dir> (--out <csv> [--merge csv] [--json-out f] | --reconcile <csv> --check [--require-clean] | --reconcile <csv> --dispositions --out <json>)\n       options: --layers <layers.json> --pin <sha> [--repo <git repo>] --exports-all --no-git --help\n';
const FLAGS = new Set(['--help', '--check', '--dispositions', '--exports-all', '--no-git', '--require-clean']);

export function parseArgs(argv) {
	const a = { values: new Map(), flags: new Set() };
	for (let i = 0; i < argv.length; i++) {
		const x = argv[i];
		if (WITH_VALUE.has(x)) {
			if (argv[i + 1] === undefined) throw new ComposeError('bad-args', `${x} needs a value`);
			a.values.set(x, argv[++i]);
		} else if (FLAGS.has(x)) a.flags.add(x);
		else throw new ComposeError('bad-args', `unknown argument ${x}`);
	}
	return a;
}

function assertOutOutside(out, dirs) {
	const abs = path.resolve(out);
	const parent = path.dirname(abs);
	let realParent;
	try {
		realParent = realDir(parent, 'output directory');
	} catch {
		realParent = parent;
	}
	const target = path.join(realParent, path.basename(abs));
	for (const d of dirs.filter(Boolean)) if (isInside(d, target)) throw new ComposeError('out-inside-input', `${out} is inside ${d}; the inputs are read only`);
}

function writeOut(out, data) {
	const abs = path.resolve(out);
	mkdirSync(path.dirname(abs), { recursive: true });
	safeWrite(path.dirname(abs), path.basename(abs), data);
}

export function summarise(union, extra = []) {
	const lines = [];
	for (const kind of ['file', 'route', 'export']) {
		const c = union.counts[kind] ?? {};
		const total = Object.values(c).reduce((s, n) => s + n, 0);
		lines.push(`${kind.padEnd(7)} ${String(total).padStart(6)}  ${Object.keys(c).sort().map((k) => `${k}=${c[k]}`).join(' ')}`);
	}
	return [...lines, ...extra].join('\n');
}

export async function main(argv, { out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
	const a = parseArgs(argv);
	const v = (k) => a.values.get(k);
	if (a.flags.has('--help')) {
		out(USAGE);
		return 0;
	}
	const check = a.flags.has('--check');
	const toDisp = a.flags.has('--dispositions');
	if (!v('--brand') || (!v('--base') && !v('--pin'))) {
		err(USAGE);
		return 2;
	}
	if (check && toDisp) throw new ComposeError('bad-args', '--check and --dispositions are separate runs');
	if ((check || toDisp) && !v('--reconcile')) throw new ComposeError('bad-args', `${check ? '--check' : '--dispositions'} needs --reconcile <csv>`);
	if (!check && !toDisp && !v('--out')) throw new ComposeError('bad-args', '--out <csv> is required to write the skeleton');
	if (toDisp && !v('--out')) throw new ComposeError('bad-args', '--dispositions needs --out <json>');

	const brandDir = realDir(v('--brand'), 'brand dir');
	const baseDirReal = v('--base') ? realDir(v('--base'), 'base dir') : null;
	for (const k of ['--out', '--json-out']) if (v(k)) assertOutOutside(v(k), [brandDir, baseDirReal]);

	const base = loadBaseTree({ baseDir: baseDirReal, repo: v('--repo'), pin: v('--pin') });
	try {
		const brand = walkBrand(brandDir);
		const git = a.flags.has('--no-git') ? { inside: false, tracked: new Set(), dirty: [] } : gitInfo(brandDir);
		let layers = null;
		if (v('--layers')) layers = parseLayers(readJson(v('--layers'), 'layers.json'));
		else {
			const b = base.read('layers.json');
			if (b) layers = parseLayers(JSON.parse(b.toString('utf8')));
		}
		const union = buildUnion({ brand, base: base.files, layers, git, exportsAll: a.flags.has('--exports-all') });
		const gitLine = `git      ${git.inside ? `${git.tracked.size} tracked, ${git.dirty.length} dirty entries` : 'not a work tree (or --no-git)'}`;

		if (check || toDisp) {
			let records;
			try {
				records = parseCsv(readFileSync(v('--reconcile'), 'utf8'));
			} catch (e) {
				throw new ComposeError('bad-csv', `${v('--reconcile')}: ${e.message}`);
			}
			const res = checkRecords({ union, records, gitDirty: git.dirty, requireClean: a.flags.has('--require-clean') });
			for (const p of res.problems) out(`[${p.code}] ${p.kind} ${p.path}${p.name ? ` ${p.name}` : ''}: ${p.message}\n`);
			const unknown = res.counts['unknown-disposition'] ?? 0;
			out(`${summarise(union, [gitLine])}\n${res.problems.length} problem(s), ${unknown} unknown\n`);
			if (res.problems.length > 0) return 1;
			if (toDisp) {
				writeOut(v('--out'), dispositionsText(records));
				out(`dispositions written to ${v('--out')}\n`);
			}
			return 0;
		}

		let previous = null;
		if (v('--merge')) {
			try {
				previous = parseCsv(readFileSync(v('--merge'), 'utf8'));
			} catch (e) {
				throw new ComposeError('bad-csv', `${v('--merge')}: ${e.message}`);
			}
		}
		const records = skeletonRecords(union, previous);
		writeOut(v('--out'), renderCsv(records));
		if (v('--json-out')) {
			const json = {
				version: 1,
				base: base.label,
				brand: brandDir,
				git: { inside: git.inside, tracked: git.tracked.size, dirty: git.dirty },
				counts: union.counts,
				rows: union.rows.map((r) => ({ ...r, related: r.related, d7Hits: r.d7Hits })),
			};
			writeOut(v('--json-out'), pretty(json));
		}
		const unknown = records.filter((r) => r.disposition === 'unknown' || r.d7_class === 'unknown').length;
		out(`${summarise(union, [gitLine])}\nskeleton written to ${v('--out')}: ${records.length} rows, ${unknown} still unknown\n`);
		return 0;
	} finally {
		base.cleanup();
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then(
		(c) => process.exit(c),
		(e) => {
			console.error(e instanceof ComposeError ? e.message : e.stack);
			process.exit(e instanceof ComposeError && e.code === 'bad-args' ? 2 : 1);
		},
	);
}
