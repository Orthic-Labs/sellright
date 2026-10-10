#!/usr/bin/env node
// Pin-bump review report (plan A30). Builds nothing and writes nothing in any production path.
//
//   bump-report.mjs --brand <layer-dir> --to <full 40-char sha> [--from <sha>] [--repo <git repo>]
//                   [--build-dir <dir>] [--out <report.md>] [--json-out <report.json>] [--check]
//
//   --from defaults to the pin in brand.json. --repo defaults to /home/vendure/sites/sellright (only read: git log, git
//   diff, git archive into a temp directory). --build-dir is the directory the composition dry-run reads its env and
//   existing tree from (default: <parent of the layer>/<brand.json buildDir>); it is never written. --out and --json-out are
//   the only files this tool writes, and may not be inside the layer directory or the repo.
//   --check prints a compact summary instead of the report and exits 0 only when every section is populated.
//
// Sections (always all of them): pins-hashes, changelog, platform-api, slots, env-schema, dependencies, drift, dry-run, external-gates.
// Status per section: ok | findings | not-run | error. `error` (the tool could not compute it) fails the run; `findings` is a
// review item, not a failure. The scratch build, harness, parity and screenshot steps are not run by this tool; their
// section is `not-run` and lists the commands.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_VERSION, dryRun } from '../compose/compose.mjs';
import { assertPinExists, openBase } from '../compose/lib/base.mjs';
import { checkDrift, describeDrift, formatDriftReport } from '../compose/lib/drift-core.mjs';
import { layerHashes } from '../compose/lib/history.mjs';
import { loadLayer, validateBrand } from '../compose/lib/layer.mjs';
import { ComposeError, PIN_RE, Problems, pretty, realDir, resolveOutputPath, writeOutputFile } from '../compose/lib/util.mjs';
import {
	ENV_SCHEMA,
	affectedConsumers,
	brandSchemaImpact,
	diffMaps,
	diffSurface,
	lockMismatches,
	packageFacts,
	platformConsumers,
	platformSurface,
	schemaItems,
	slotConsumers,
	slotTypes,
	treeOf,
} from './platform-api.mjs';

export const DEFAULT_REPO = '/home/vendure/sites/sellright';
export const CHANGELOG_PATHS = ['packages/storefront', 'packages/storefront-client', 'packages/shared'];
export const SECTION_IDS = ['pins-hashes', 'changelog', 'platform-api', 'slots', 'env-schema', 'dependencies', 'drift', 'dry-run', 'external-gates'];
const TITLES = {
	'pins-hashes': 'Pins and hashes',
	changelog: 'Changelog',
	'platform-api': 'Platform API diff and affected consumers',
	slots: 'Slot prop types',
	'env-schema': 'Environment schema (brand-env.schema.json)',
	dependencies: 'Dependencies and the brand lock',
	drift: 'Eject drift (three-way)',
	'dry-run': 'Composed dry-run',
	'external-gates': 'Steps this tool does not run',
};
const CAP = 60;

export function assertFullSha(value, flag) {
	if (!PIN_RE.test(value ?? '')) throw new ComposeError('bad-pin', `${flag} must be a full 40-character lowercase SHA, got ${JSON.stringify(value)}`);
	return value;
}

const git = (repo, args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
const short = (sha) => sha.slice(0, 12);
const capped = (items, n = CAP) => (items.length > n ? [...items.slice(0, n), `… and ${items.length - n} more (see the JSON report)`] : items);
const bullets = (items, n = CAP) => capped(items, n).map((x) => `- ${x}`);

// ------------------------------------------------------------------------------------------------ sections

function changelog(ctx) {
	const { repo, from, to } = ctx;
	const fwd = git(repo, ['merge-base', '--is-ancestor', from, to]).status === 0;
	const back = !fwd && git(repo, ['merge-base', '--is-ancestor', to, from]).status === 0;
	const ancestry = from === to ? 'same' : fwd ? 'forward' : back ? 'backward' : 'diverged';
	const log = git(repo, ['log', '--format=%H%x1f%an%x1f%as%x1f%s', `${from}..${to}`, '--', ...CHANGELOG_PATHS]);
	if (log.status !== 0) throw new ComposeError('git', `git log failed: ${log.stderr.trim()}`);
	const commits = log.stdout
		.split('\n')
		.filter(Boolean)
		.map((l) => {
			const [sha, author, date, subject] = l.split('\x1f');
			return { sha, author, date, subject };
		});
	const ns = git(repo, ['diff', '--numstat', from, to, '--', ...CHANGELOG_PATHS]);
	if (ns.status !== 0) throw new ComposeError('git', `git diff --numstat failed: ${ns.stderr.trim()}`);
	const perPath = Object.fromEntries(CHANGELOG_PATHS.map((p) => [p, { files: 0, added: 0, deleted: 0 }]));
	for (const l of ns.stdout.split('\n').filter(Boolean)) {
		const [a, d, ...rest] = l.split('\t');
		const file = rest.join('\t');
		const key = CHANGELOG_PATHS.find((p) => file === p || file.startsWith(`${p}/`));
		if (!key) continue;
		perPath[key].files++;
		perPath[key].added += a === '-' ? 0 : Number(a);
		perPath[key].deleted += d === '-' ? 0 : Number(d);
	}
	const lines = [
		`Range \`${short(from)}..${short(to)}\`, ancestry: ${ancestry}. ${commits.length} commit(s) touching ${CHANGELOG_PATHS.join(', ')}.`,
		'',
		'| path | files | + | - |',
		'|---|---|---|---|',
		...CHANGELOG_PATHS.map((p) => `| ${p} | ${perPath[p].files} | ${perPath[p].added} | ${perPath[p].deleted} |`),
		'',
		...capped(commits.map((c) => `\`${short(c.sha)}\` ${c.date} ${c.author}: ${c.subject}`)).map((x) => `- ${x}`),
	];
	const findings = ancestry === 'backward' || ancestry === 'diverged';
	return {
		status: findings ? 'findings' : 'ok',
		summary: `${commits.length} commit(s), ${Object.values(perPath).reduce((s, p) => s + p.files, 0)} file(s) changed, ancestry ${ancestry}`,
		data: { ancestry, commits, perPath },
		lines: findings ? [`**The new pin is not a descendant of the old one (${ancestry}). Review before bumping.**`, '', ...lines] : lines,
	};
}

function platformApi(ctx) {
	const oldS = platformSurface(ctx.oldTree);
	const newS = platformSurface(ctx.newTree);
	const diff = diffSurface(oldS, newS);
	const consumers = platformConsumers({ overlay: ctx.layer.overlay, readOverlay: ctx.readOverlay, trees: [ctx.newTree, ctx.oldTree] });
	const aff = affectedConsumers({ diff, consumers, newSurface: newS });
	const touched = aff.changes.filter((c) => c.consumers.length > 0);
	const lines = [
		`Surface: ${oldS.size} exports at the old pin, ${newS.size} at the new. Added ${diff.added.length}, removed ${diff.removed.length}, changed ${diff.changed.length}. Brand overlay imports of \`~/platform/*\`: ${consumers.length}.`,
		'',
		'### Removed or changed names',
		...(aff.changes.some((c) => c.change !== 'added')
			? bullets(
					aff.changes
						.filter((c) => c.change !== 'added')
						.map((c) => `**${c.change}** \`${c.key.replace('#', ' → ')}\`${c.consumers.length ? `: used by ${c.consumers.map((u) => `${u.file}:${u.line}`).join(', ')}` : ': no consumer in the brand overlay'}`),
				)
			: ['- none']),
		'',
		'### Added names',
		...(diff.added.length ? bullets(diff.added.map((k) => `\`${k.replace('#', ' → ')}\``)) : ['- none']),
		'',
		'### Overlay imports that do not resolve against the new surface',
		...(aff.broken.length ? bullets(aff.broken.map((b) => `\`${b.module} → ${b.name}\` at ${b.file}:${b.line}: ${b.reason}`)) : ['- none']),
		'',
		'_Compared by the printed declaration of each exported name, re-exports followed to their declaration. A change in a type that a declaration only references is not seen here; the composed typecheck covers it._',
	];
	return {
		status: touched.length > 0 || aff.broken.length > 0 ? 'findings' : 'ok',
		summary: `${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed; ${touched.length} change(s) hit overlay consumers, ${aff.broken.length} unresolved import(s)`,
		data: { added: diff.added, removed: diff.removed, changed: diff.changed, consumers: consumers.length, touched, broken: aff.broken },
		lines,
	};
}

function slots(ctx) {
	const o = slotTypes(ctx.oldTree);
	const n = slotTypes(ctx.newTree);
	if (!o && !n) return { status: 'ok', summary: 'no slot registry at either pin', data: {}, lines: ['Neither pin has `src/components/slots/registry.ts` with a `SlotPropsMap`.'] };
	const diff = diffMaps(o ?? new Map(), n ?? new Map());
	const fills = slotConsumers({ overlay: ctx.layer.overlay, readOverlay: ctx.readOverlay });
	const hit = (slot) => fills.filter((f) => f.slot === slot).map((f) => f.file);
	const rows = [
		...diff.removed.map((s) => ({ change: 'removed', slot: s, files: hit(s) })),
		...diff.changed.map((s) => ({ change: 'changed', slot: s, files: hit(s) })),
		...diff.added.map((s) => ({ change: 'added', slot: s, files: [] })),
	];
	const touched = rows.filter((r) => r.change !== 'added' && r.files.length > 0);
	const lines = [
		`Slots: ${o?.size ?? 0} at the old pin, ${n?.size ?? 0} at the new. Brand slot files: ${fills.length}.`,
		'',
		...(rows.length ? bullets(rows.map((r) => `**${r.change}** \`${r.slot}\`${r.files.length ? `: filled by ${r.files.join(', ')}` : ''}`)) : ['- no slot prop type changed']),
	];
	return { status: touched.length ? 'findings' : 'ok', summary: `${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed; ${touched.length} hit a brand slot file`, data: { ...diff, touched }, lines };
}

function envSchema(ctx) {
	const parse = (tree) => {
		const b = tree.read(ENV_SCHEMA);
		return b ? JSON.parse(b.toString('utf8')) : null;
	};
	const o = parse(ctx.oldTree);
	const n = parse(ctx.newTree);
	if (!o && !n) return { status: 'ok', summary: 'no schema at either pin', data: {}, lines: ['Neither pin has `brand-env.schema.json`.'] };
	const diff = diffMaps(schemaItems(o ?? {}), schemaItems(n ?? {}));
	const impact = brandSchemaImpact({ brand: ctx.brand, newSchema: n ?? {}, diff });
	const fmt = (k) => `\`${k}\``;
	const lines = [
		`Added ${diff.added.length}, removed ${diff.removed.length}, changed ${diff.changed.length}.`,
		'',
		...bullets([...diff.removed.map((k) => `**removed** ${fmt(k)}`), ...diff.changed.map((k) => `**changed** ${fmt(k)}`), ...diff.added.map((k) => `added ${fmt(k)}`)]),
		'',
		'### What brand.json relies on that changed',
		...(impact.length ? bullets(impact.map((i) => `${i.what}: ${i.problem}`)) : ['- nothing']),
	];
	return { status: impact.length ? 'findings' : 'ok', summary: `${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed; ${impact.length} brand.json item(s) affected`, data: { ...diff, impact }, lines };
}

function dependencies(ctx) {
	const text = (tree) => tree.read('package.json')?.toString('utf8') ?? null;
	const op = text(ctx.oldTree);
	const np = text(ctx.newTree);
	if (np === null) throw new ComposeError('bad-base', 'the new pin has no packages/storefront/package.json');
	const of = (op && packageFacts(op)) || new Map();
	const nf = packageFacts(np);
	if (!nf) throw new ComposeError('bad-base', 'the new base package.json is not valid JSON');
	const diff = diffMaps(of, nf);
	const rootChanged = (file) => git(ctx.repo, ['diff', '--quiet', ctx.from, ctx.to, '--', file]).status === 1;
	const lockChanged = rootChanged('pnpm-lock.yaml');
	const wsChanged = rootChanged('pnpm-workspace.yaml');
	const lock = lockMismatches({ lockText: ctx.layer.lockBuf.toString('utf8'), pkgText: np });
	const f = (k) => `\`${k}\``;
	const lines = [
		`package.json: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed. Root \`pnpm-lock.yaml\` ${lockChanged ? '**changed**' : 'unchanged'}, \`pnpm-workspace.yaml\` ${wsChanged ? '**changed**' : 'unchanged'}.`,
		'',
		...bullets([
			...diff.removed.map((k) => `**removed** ${f(k)} (was ${of.get(k)})`),
			...diff.changed.map((k) => `**changed** ${f(k)}: ${of.get(k)} → ${nf.get(k)}`),
			...diff.added.map((k) => `added ${f(k)} ${nf.get(k)}`),
		]),
		'',
		`### Brand lock against the new package.json (${lock.checked} specifier(s) checked)`,
		...(lock.problems.length ? bullets(lock.problems.map((p) => `\`${p.name}\`: ${p.problem}`)) : ['- every specifier matches; a frozen install would accept the brand lock']),
		'',
		'_This is a specifier check of the brand lock’s root importer, not a resolution. The tool’s own `lock-equivalence` check (compose) and the frozen install in the scratch build are the authoritative results._',
	];
	const changedAny = diff.added.length + diff.removed.length + diff.changed.length > 0 || lockChanged || wsChanged;
	return {
		status: lock.problems.length || changedAny ? 'findings' : 'ok',
		summary: `${diff.added.length + diff.removed.length + diff.changed.length} package.json change(s), root lock ${lockChanged ? 'changed' : 'unchanged'}, ${lock.problems.length} brand-lock mismatch(es)`,
		data: { ...diff, rootLockChanged: lockChanged, workspaceChanged: wsChanged, lockProblems: lock.problems, lockChecked: lock.checked },
		lines,
	};
}

function drift(ctx) {
	const ejects = (ctx.layer.manifest.entries ?? []).filter((e) => e.layer === 'L2' || e.kind === 'package-script');
	if (ejects.length === 0) return { status: 'ok', summary: 'no L2 ejects or patched scripts', data: { ejects: 0, problems: [] }, lines: ['The brand layer has no L2 ejects and no patched package scripts.'] };
	const problems = new Problems();
	const records = checkDrift({ layer: ctx.layer, base: ctx.newBase, pin: ctx.to, problems });
	const details = ejects.map((entry) => describeDrift({ entry, layer: ctx.layer, base: ctx.newBase }));
	const lines = [
		`${ejects.length} eject(s): ${records.map((r) => `${r.id} ${r.status}`).join(', ')}.`,
		'',
		...(problems.any ? bullets(problems.list.map((p) => `[${p.code}] ${p.message}`)) : ['- every eject is unchanged or already resolved at this pin']),
		'',
		'```diff',
		formatDriftReport(details, ctx.to).trimEnd(),
		'```',
	];
	return { status: problems.any ? 'findings' : 'ok', summary: `${ejects.length} eject(s), ${problems.list.length} unresolved`, data: { ejects: records, problems: problems.list }, lines };
}

async function composeDryRun(ctx) {
	let r;
	try {
		r = await dryRun({ layerDir: ctx.layer.dir, outDir: ctx.buildDir, pin: ctx.to, repo: ctx.repo, loadEnv: ctx.loadEnv, requireOutPair: ctx.defaultBuildDir });
	} catch (e) {
		if (!(e instanceof ComposeError)) throw e;
		const probs = Array.isArray(e.details) ? e.details.map((p) => `[${p.code}] ${p.file ? `${p.file}: ` : ''}${p.message}`) : [e.message];
		return { status: 'findings', summary: `composition at the new pin fails: ${probs.length} problem(s)`, data: { ok: false, problems: probs }, lines: ['**Composition at the new pin would fail:**', '', ...bullets(probs)] };
	}
	const byAction = {};
	for (const c of r.changes) byAction[c.action] = (byAction[c.action] ?? 0) + 1;
	const rep = r.report;
	const lines = [
		`Dry-run at \`${short(ctx.to)}\` against \`${ctx.buildDir}\` (read only, nothing written): ${r.changes.length} change(s) (${Object.entries(byAction).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}), ${r.removals.length} removal(s).`,
		`Import check: ${rep.importCheck.status}; shape check: ${rep.shapeCheck.status}; closure: ${rep.closure.scanned} script file(s) scanned, ${rep.closure.unresolved.length} unresolved, ${rep.closure.externalsMissing.length} external(s) missing.`,
		'',
		...(r.notes.length ? ['### Notes', ...bullets(r.notes), ''] : []),
		'### Hashes',
		...Object.entries(r.hashes).map(([k, v]) => `- ${k}: \`${v}\``),
	];
	const findings = rep.importCheck.status !== 'passed' || rep.shapeCheck.status !== 'passed' || rep.closure.unresolved.length > 0 || rep.closure.externalsMissing.length > 0;
	return {
		status: findings ? 'findings' : 'ok',
		summary: `composition succeeds: ${r.changes.length} change(s), ${r.removals.length} removal(s), import ${rep.importCheck.status}, shape ${rep.shapeCheck.status}`,
		data: { ok: true, changes: byAction, removals: r.removals.length, notes: r.notes, hashes: r.hashes, importCheck: rep.importCheck, shapeCheck: rep.shapeCheck, closure: { scanned: rep.closure.scanned, unresolved: rep.closure.unresolved, externalsMissing: rep.closure.externalsMissing }, drift: rep.drift },
		lines,
	};
}

function pinsHashes(ctx, dry) {
	const h = layerHashes({ layer: ctx.layer, pin: ctx.to, toolVersion: TOOL_VERSION });
	const eff = dry?.data?.hashes?.publicConfig ?? null;
	const lines = [
		`- brand: \`${ctx.brand.brand}\`, layer \`${ctx.layer.dir}\``,
		`- old pin: \`${ctx.from}\``,
		`- new pin: \`${ctx.to}\``,
		...Object.entries(h).map(([k, v]) => `- ${k}: \`${v}\``),
		`- effective public config (from the dry-run): ${eff ? `\`${eff}\`` : '_not available: the dry-run did not complete_'}`,
	];
	return { status: 'ok', summary: `${short(ctx.from)} → ${short(ctx.to)}; overlay, manifest, lock and public config hashes recorded`, data: { from: ctx.from, to: ctx.to, hashes: h, effectivePublicConfig: eff }, lines };
}

function externalGates(ctx) {
	const wrapper = '/home/vendure/sites/ops/compose-brand.sh';
	const lines = [
		'This tool composes nothing and builds nothing. Run these on a scratch copy (the A26 layout), never on the live build directory, then attach their results to this report:',
		'',
		`1. Scratch composition at the new pin: \`bash ${wrapper} ${ctx.layer.dir} --out <scratch>/${ctx.brand.buildDir} --pin ${ctx.to} --apply\``,
		'2. Scratch build and composed typecheck: `pnpm build` (includes `build.types`) inside the scratch build directory',
		'3. Harness and parity suites against the scratch server (A7 specs, A9 stock parity)',
		'4. Screenshots of the scratch build for Adrian (home, shop, product, cart, checkout without an order, sign-in, account, track, story; 1440 and 390)',
		'',
		'After Adrian approves: edit the pin in `brand.json`, `compose-brand.sh --apply`, then the existing build entry.',
	];
	return { status: 'not-run', summary: 'scratch build, typecheck, harness, parity and screenshots are not run by this tool (commands listed)', data: { commands: lines.filter((l) => /^\d\./.test(l)) }, lines };
}

// ------------------------------------------------------------------------------------------------ report

async function guarded(id, fn) {
	try {
		const s = await fn();
		return { id, title: TITLES[id], ...s };
	} catch (e) {
		return { id, title: TITLES[id], status: 'error', summary: `could not be computed: ${e instanceof ComposeError ? e.message : (e?.message ?? String(e))}`, data: {}, lines: [`**Error:** ${e instanceof ComposeError ? e.message : (e?.stack ?? String(e))}`] };
	}
}

/**
 * @param {{ layerDir: string, to: string, from?: string, repo?: string, buildDir?: string, loadEnv?: Function }} opts
 */
export async function buildReport(opts) {
	assertFullSha(opts.to, '--to');
	if (opts.from !== undefined) assertFullSha(opts.from, '--from');
	const layer = loadLayer(opts.layerDir);
	const problems = new Problems();
	validateBrand(layer.brand, problems);
	problems.throwIfAny();
	const repo = opts.repo ?? DEFAULT_REPO;
	const from = opts.from ?? layer.brand.pin;
	const to = opts.to;
	assertPinExists(repo, from);
	assertPinExists(repo, to);
	const defaultBuildDir = !opts.buildDir;
	const buildDir = opts.buildDir ?? path.join(path.dirname(layer.dir), layer.brand.buildDir);

	const oldBase = openBase({ repo, pin: from, baseExclude: layer.brand.baseExclude });
	let newBase;
	try {
		newBase = openBase({ repo, pin: to, baseExclude: layer.brand.baseExclude });
		const ctx = {
			layer,
			brand: layer.brand,
			repo,
			from,
			to,
			buildDir,
			defaultBuildDir,
			loadEnv: opts.loadEnv,
			oldBase,
			newBase,
			oldTree: treeOf(oldBase),
			newTree: treeOf(newBase),
			readOverlay: (rel) => (layer.overlay.has(rel) ? readFileSync(layer.overlay.get(rel).abs, 'utf8') : null),
		};
		const done = new Map();
		done.set('changelog', await guarded('changelog', () => changelog(ctx)));
		done.set('platform-api', await guarded('platform-api', () => platformApi(ctx)));
		done.set('slots', await guarded('slots', () => slots(ctx)));
		done.set('env-schema', await guarded('env-schema', () => envSchema(ctx)));
		done.set('dependencies', await guarded('dependencies', () => dependencies(ctx)));
		done.set('drift', await guarded('drift', () => drift(ctx)));
		done.set('dry-run', await guarded('dry-run', () => composeDryRun(ctx)));
		done.set('pins-hashes', await guarded('pins-hashes', () => pinsHashes(ctx, done.get('dry-run'))));
		done.set('external-gates', await guarded('external-gates', () => externalGates(ctx)));
		const sections = SECTION_IDS.map((id) => done.get(id));
		const errors = sections.filter((s) => s.status === 'error');
		const findings = sections.filter((s) => s.status === 'findings');
		const empty = sections.filter((s) => !s.summary || !Array.isArray(s.lines) || s.lines.length === 0);
		return {
			version: 1,
			brand: layer.brand.brand,
			from,
			to,
			verdict: errors.length ? 'incomplete' : findings.length ? 'review-required' : 'no-findings',
			complete: errors.length === 0 && empty.length === 0,
			sections,
		};
	} finally {
		oldBase.cleanup();
		newBase?.cleanup();
	}
}

const BADGE = { ok: 'ok', findings: 'FINDINGS', 'not-run': 'not run here', error: 'ERROR' };

export function renderMarkdown(report) {
	const out = [
		`# Pin bump review: ${report.brand} \`${short(report.from)}\` → \`${short(report.to)}\``,
		'',
		`Verdict: **${report.verdict}**${report.complete ? '' : ' (the report is incomplete)'}. Nothing was built, composed or written to a production path to produce this report.`,
		'',
		'| # | Section | Status | Summary |',
		'|---|---|---|---|',
		...report.sections.map((s, i) => `| ${i + 1} | ${s.title} | ${BADGE[s.status]} | ${s.summary.replace(/\|/g, '\\|')} |`),
		'',
	];
	report.sections.forEach((s, i) => {
		out.push(`## ${i + 1}. ${s.title} (${BADGE[s.status]})`, '', ...s.lines, '');
	});
	return `${out.join('\n')}\n`;
}

export function reportJson(report) {
	return pretty({ ...report, sections: report.sections.map(({ lines, ...rest }) => rest) });
}

// ------------------------------------------------------------------------------------------------ CLI

const WITH_VALUE = new Set(['--brand', '--to', '--from', '--repo', '--build-dir', '--out', '--json-out']);
export function parseArgs(argv) {
	const a = { values: new Map(), flags: new Set() };
	for (let i = 0; i < argv.length; i++) {
		const x = argv[i];
		if (WITH_VALUE.has(x)) {
			if (argv[i + 1] === undefined) throw new ComposeError('bad-args', `${x} needs a value`);
			a.values.set(x, argv[++i]);
		} else if (x === '--check') a.flags.add(x);
		else throw new ComposeError('bad-args', `unknown argument ${x}`);
	}
	return a;
}

/** The build directory the report reads as an immutable input: explicit --build-dir, else <parent of the layer>/<brand.json buildDir>. */
export function effectiveBuildDir(layerDir, explicit) {
	if (explicit) return path.resolve(explicit);
	return path.join(path.dirname(layerDir), loadLayer(layerDir).brand.buildDir);
}

export async function main(argv, { out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), loadEnv } = {}) {
	const a = parseArgs(argv);
	const v = (k) => a.values.get(k);
	if (!v('--brand') || !v('--to')) {
		err('usage: bump-report.mjs --brand <layer-dir> --to <full 40-char sha> [--from sha] [--repo dir] [--build-dir dir] [--out report.md] [--json-out report.json] [--check]\n');
		return 2;
	}
	assertFullSha(v('--to'), '--to');
	if (v('--from')) assertFullSha(v('--from'), '--from');
	const layerReal = realDir(v('--brand'), 'brand layer');
	const repoReal = realDir(v('--repo') ?? DEFAULT_REPO, 'repo');
	const inputRoots = [layerReal, repoReal, effectiveBuildDir(layerReal, v('--build-dir'))];
	for (const k of ['--out', '--json-out']) if (v(k)) resolveOutputPath(v(k), inputRoots);

	const report = await buildReport({ layerDir: layerReal, to: v('--to'), from: v('--from'), repo: repoReal, buildDir: v('--build-dir'), loadEnv });
	const write = (file, text) => writeOutputFile(file, inputRoots, text);
	if (v('--out')) write(v('--out'), renderMarkdown(report));
	if (v('--json-out')) write(v('--json-out'), reportJson(report));
	if (a.flags.has('--check')) {
		out(`${report.sections.map((s) => `${s.id.padEnd(15)} ${BADGE[s.status].padEnd(12)} ${s.summary}`).join('\n')}\nverdict ${report.verdict}, ${report.complete ? 'complete' : 'INCOMPLETE'}\n`);
	} else if (!v('--out')) out(renderMarkdown(report));
	else out(`report written to ${v('--out')}: verdict ${report.verdict}${report.complete ? '' : ' (incomplete)'}\n`);
	return report.complete ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then(
		(c) => process.exit(c),
		(e) => {
			console.error(e instanceof ComposeError ? e.message : e.stack);
			process.exit(e instanceof ComposeError && (e.code === 'bad-args' || e.code === 'bad-pin') ? 2 : 1);
		},
	);
}
