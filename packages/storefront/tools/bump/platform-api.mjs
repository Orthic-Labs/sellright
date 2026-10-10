// Platform API diff for the pin-bump report (plan A30): the exports of `src/platform/**` (re-exports followed to
// their declaration), the slot prop types of `src/components/slots/registry.ts`, `brand-env.schema.json`, the
// dependency specifiers of the base package.json against the brand lock, and the L3/L2 consumers of what changed.
// Pure functions over a tree adapter: { has(rel), read(rel) -> Buffer|null, paths() -> string[] }.
import path from 'node:path';
import { analyzeModule, isCodePath, slotMap } from '../inventory/analyze.mjs';
import { sectionNames } from '../compose/env-check.mjs';
import { sha256 } from '../compose/lib/util.mjs';

export const PLATFORM_DIR = 'src/platform/';
export const SLOT_REGISTRY = 'src/components/slots/registry.ts';
export const ENV_SCHEMA = 'brand-env.schema.json';
const RESOLVE_EXT = ['.ts', '.tsx', '.js', '.mjs', '.mts', '.jsx'];

/** Tree adapter over an opened base (compose/lib/base.mjs openBase result). */
export const treeOf = (base) => ({ has: (rel) => base.has(rel), read: (rel) => base.read(rel), paths: () => [...base.files.keys()] });

const textOf = (tree, rel) => tree.read(rel)?.toString('utf8') ?? null;

/** The composed-tree file a specifier points at, or null (package specifiers are never resolved). */
export function resolveSpec(tree, fromRel, spec) {
	let base;
	if (spec.startsWith('~/')) base = `src/${spec.slice(2)}`;
	else if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
	else return null;
	const stem = base.replace(/\.(m?js|jsx)$/, '');
	const tries = [base, ...RESOLVE_EXT.map((e) => base + e), ...RESOLVE_EXT.map((e) => stem + e), ...RESOLVE_EXT.map((e) => `${base}/index${e}`)];
	return tries.find((t) => tree.has(t)) ?? null;
}

export function isPlatformModule(rel) {
	return rel.startsWith(PLATFORM_DIR) && isCodePath(rel) && !/\.(test|spec)\.[^.]+$/.test(rel) && !rel.endsWith('.d.ts');
}

/**
 * The exported surface of every platform module: Map<"module#name", { hash, kind, decl }>. A re-export carries the hash
 * of the declaration it ends in (`decl` is the file that declares it), so a change behind `export { x } from '~/services/y'`
 * shows as a change of `~/platform/…#x`. `export *` expands the target's names (never `default`).
 */
export function platformSurface(tree) {
	const anaCache = new Map();
	const analyse = (rel) => {
		if (!anaCache.has(rel)) {
			const t = textOf(tree, rel);
			let a = null;
			if (t !== null) {
				try {
					a = analyzeModule(rel, t);
				} catch {
					a = null;
				}
			}
			anaCache.set(rel, a);
		}
		return anaCache.get(rel);
	};
	const memo = new Map();
	const exportsOf = (rel, stack = []) => {
		if (memo.has(rel)) return memo.get(rel);
		const out = new Map();
		if (stack.includes(rel)) return out;
		const a = analyse(rel);
		if (!a) return out;
		const next = [...stack, rel];
		for (const [name, e] of a.exports) {
			if (e.kind !== 'reexport') {
				out.set(name, { hash: e.hash, kind: e.kind, decl: rel });
				continue;
			}
			const target = resolveSpec(tree, rel, e.from);
			if (target === null) out.set(name, { hash: `external:${e.from}#${e.imported}`, kind: 'external', decl: e.from });
			else if (e.imported === '*') {
				const sub = [...exportsOf(target, next)].map(([n, v]) => `${n}:${v.hash}`).sort();
				out.set(name, { hash: sha256(`ns:${sub.join('|')}`), kind: 'namespace', decl: target });
			} else {
				const hit = exportsOf(target, next).get(e.imported);
				out.set(name, hit ?? { hash: `unresolved:${target}#${e.imported}`, kind: 'unresolved', decl: target });
			}
		}
		for (const spec of a.stars) {
			const target = resolveSpec(tree, rel, spec);
			if (target === null) {
				out.set(`*:${spec}`, { hash: `external:${spec}#*`, kind: 'external', decl: spec });
				continue;
			}
			for (const [n, v] of exportsOf(target, next)) if (n !== 'default' && !out.has(n)) out.set(n, v);
		}
		if (stack.length === 0) memo.set(rel, out);
		return out;
	};
	const surface = new Map();
	for (const rel of tree.paths().filter(isPlatformModule).sort()) {
		for (const [name, v] of exportsOf(rel)) surface.set(`${rel}#${name}`, v);
	}
	return surface;
}

/** { added, removed, changed } between two surfaces (or two Map<key, hash-ish> via `get`). */
export function diffMaps(oldM, newM, same = (a, b) => a === b) {
	const added = [];
	const removed = [];
	const changed = [];
	for (const [k, v] of newM) {
		if (!oldM.has(k)) added.push(k);
		else if (!same(oldM.get(k), v)) changed.push(k);
	}
	for (const k of oldM.keys()) if (!newM.has(k)) removed.push(k);
	return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}
export const diffSurface = (o, n) => diffMaps(o, n, (a, b) => a.hash === b.hash);

/** `~/platform/x` -> module path `src/platform/x.ts`, resolved against whichever tree has it (new first, then old). */
function moduleFor(trees, spec, fromRel) {
	if (!(spec === '~/platform' || spec.startsWith('~/platform/'))) return null;
	for (const t of trees) {
		const hit = resolveSpec(t, fromRel, spec);
		if (hit && hit.startsWith(PLATFORM_DIR)) return hit;
	}
	const stem = `src/${spec.slice(2)}`;
	return stem;
}

/**
 * Every `~/platform/*` import of the brand's overlay code files: [{ file, line, module, name, typeOnly }].
 * `name` is the imported name, `*` for a namespace import, an `export * from`, a dynamic import or a side-effect import.
 */
export function platformConsumers({ overlay, readOverlay, trees }) {
	const out = [];
	for (const rel of [...overlay.keys()].sort()) {
		if (!isCodePath(rel)) continue;
		const text = readOverlay(rel);
		if (text === null) continue;
		let a;
		try {
			a = analyzeModule(rel, text);
		} catch {
			continue;
		}
		for (const imp of a.imports) {
			const module = moduleFor(trees, imp.spec, rel);
			if (module === null) continue;
			if (imp.names.length === 0) out.push({ file: rel, line: imp.line, module, name: '*', typeOnly: imp.typeOnly });
			for (const n of imp.names) out.push({ file: rel, line: imp.line, module, name: n.imported, typeOnly: imp.typeOnly });
		}
	}
	return out;
}

const splitKey = (k) => {
	const i = k.indexOf('#');
	return { module: k.slice(0, i), name: k.slice(i + 1) };
};

/**
 * Which consumers a surface change touches, plus the imports that no longer resolve in the new surface whatever the diff says.
 * Removed or changed names list the consumers that import that name (or the whole module); added names have no consumers.
 */
export function affectedConsumers({ diff, consumers, newSurface }) {
	const newModules = new Set([...newSurface.keys()].map((k) => splitKey(k).module));
	const hits = (key) => {
		const { module, name } = splitKey(key);
		return consumers.filter((c) => c.module === module && (c.name === name || c.name === '*')).map((c) => ({ file: c.file, line: c.line, imports: c.name }));
	};
	const changes = [];
	for (const key of diff.removed) changes.push({ change: 'removed', key, consumers: hits(key) });
	for (const key of diff.changed) changes.push({ change: 'changed', key, consumers: hits(key) });
	for (const key of diff.added) changes.push({ change: 'added', key, consumers: [] });
	const broken = [];
	for (const c of consumers) {
		if (!newModules.has(c.module)) broken.push({ ...c, reason: 'module no longer exists in the new platform API' });
		else if (c.name !== '*' && !newSurface.has(`${c.module}#${c.name}`)) broken.push({ ...c, reason: 'name is not exported by the new platform API' });
	}
	return { changes, broken };
}

// ------------------------------------------------------------------------------------------------ slots

export function slotTypes(tree) {
	const t = textOf(tree, SLOT_REGISTRY);
	return t === null ? null : slotMap(SLOT_REGISTRY, t);
}

/** Slot names the brand fills: `src/brand-slots/<slot>.tsx` file stems plus `SlotProps<'slot'>` mentions in overlay code. */
export function slotConsumers({ overlay, readOverlay }) {
	const out = [];
	for (const rel of [...overlay.keys()].sort()) {
		const m = /^src\/brand-slots\/(.+)\.(tsx|ts)$/.exec(rel);
		if (m) out.push({ file: rel, slot: m[1] });
		if (!isCodePath(rel)) continue;
		const text = readOverlay(rel);
		if (text === null) continue;
		for (const mm of text.matchAll(/SlotProps<\s*['"]([^'"]+)['"]\s*>/g)) if (!(m && m[1] === mm[1])) out.push({ file: rel, slot: mm[1] });
	}
	return out;
}

// ------------------------------------------------------------------------------------------------ env schema

const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((y) => [y, x[y]])) : x));

/** Per section name -> canonical JSON of its definition (privateRuntime: the names list entries). */
export function schemaItems(schema) {
	const m = new Map();
	for (const sec of ['settings', 'publicBuildConfig']) for (const [n, def] of Object.entries(schema?.[sec] ?? {})) m.set(`${sec}:${n}`, canon(def));
	for (const n of sectionNames(schema ?? {}).privateRuntime) m.set(`privateRuntime:${n}`, 'name');
	return m;
}

/** What the brand declares against the new schema: unknown or changed names it relies on. */
export function brandSchemaImpact({ brand, newSchema, diff }) {
	const out = [];
	const removed = new Set(diff.removed);
	const changed = new Set(diff.changed);
	const flag = (key, what) => {
		if (removed.has(key)) out.push({ key, what, problem: 'removed from the schema' });
		else if (changed.has(key)) out.push({ key, what, problem: 'definition changed' });
	};
	for (const k of Object.keys(brand.settings ?? {})) {
		flag(`settings:${k}`, `brand.json settings.${k}`);
		const def = newSchema?.settings?.[k];
		if (def?.type === 'enum' && Array.isArray(def.values) && !def.values.includes(brand.settings[k])) out.push({ key: `settings:${k}`, what: `brand.json settings.${k}`, problem: `value ${JSON.stringify(brand.settings[k])} is not one of ${def.values.join(', ')}` });
	}
	for (const k of Object.keys(brand.publicConfig ?? {})) flag(`publicBuildConfig:${k}`, `brand.json publicConfig.${k}`);
	const all = new Set([...schemaItems(newSchema ?? {}).keys()].map((k) => k.split(':').slice(1).join(':')));
	for (const k of brand.requiredEnv ?? []) if (!all.has(k)) out.push({ key: k, what: `brand.json requiredEnv ${k}`, problem: 'not in the new schema' });
	return out;
}

// ------------------------------------------------------------------------------------------------ dependencies and lock

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

export function packageFacts(text) {
	let pkg;
	try {
		pkg = JSON.parse(text);
	} catch {
		return null;
	}
	const m = new Map();
	for (const sec of DEP_SECTIONS) for (const [n, v] of Object.entries(pkg[sec] ?? {})) m.set(`${sec}:${n}`, v);
	for (const [n, v] of Object.entries(pkg.engines ?? {})) m.set(`engines:${n}`, v);
	if (pkg.packageManager) m.set('packageManager', pkg.packageManager);
	return m;
}

/** `importers['.']` dependency specifiers of a pnpm lock (v9 layout): Map<name, specifier>. Line-based; no YAML library. */
export function lockSpecifiers(text, importer = '.') {
	const lines = text.split('\n');
	const out = new Map();
	let i = lines.findIndex((l) => l.trimEnd() === 'importers:');
	if (i < 0) return out;
	i = lines.findIndex((l, j) => j > i && l.trimEnd() === `  ${importer}:`);
	if (i < 0) return out;
	const unq = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');
	let section = null;
	let name = null;
	for (let j = i + 1; j < lines.length; j++) {
		const l = lines[j];
		if (l.trim() === '') continue;
		const indent = l.length - l.trimStart().length;
		if (indent <= 2) break;
		const body = l.trim();
		if (indent === 4) {
			section = /^(dependencies|devDependencies|optionalDependencies):$/.test(body) ? body.slice(0, -1) : null;
			name = null;
		} else if (indent === 6 && section) {
			name = unq(body.replace(/:$/, ''));
		} else if (indent === 8 && section && name && body.startsWith('specifier:')) {
			out.set(name, unq(body.slice('specifier:'.length)));
		}
	}
	return out;
}

/** The brand lock against the new base package.json: what a frozen install would reject. */
export function lockMismatches({ lockText, pkgText }) {
	const facts = packageFacts(pkgText);
	if (!facts) return { problems: [{ name: 'package.json', problem: 'new base package.json is not valid JSON' }], checked: 0 };
	const lock = lockSpecifiers(lockText);
	const problems = [];
	let checked = 0;
	const want = new Map();
	for (const [k, v] of facts) {
		const [sec, ...rest] = k.split(':');
		if (['dependencies', 'devDependencies', 'optionalDependencies'].includes(sec)) want.set(rest.join(':'), v);
	}
	for (const [n, v] of want) {
		checked++;
		if (!lock.has(n)) problems.push({ name: n, problem: `in package.json (${v}) but not in the brand lock importer` });
		else if (lock.get(n) !== v) problems.push({ name: n, problem: `package.json says ${v}, the brand lock says ${lock.get(n)}` });
	}
	for (const n of lock.keys()) if (!want.has(n)) problems.push({ name: n, problem: 'in the brand lock importer but not in package.json' });
	return { problems, checked };
}
