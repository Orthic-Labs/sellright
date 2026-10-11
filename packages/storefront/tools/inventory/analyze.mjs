// Source analysis shared by the union inventory (A23) and the pin-bump report (A30).
// Node built-ins plus the TypeScript compiler API only. Pure functions: text in, data out.
//
//   analyzeModule(rel, text) -> { exports: Map<name, entry>, stars: [specifier], imports: [import], lines }
//   routeOf(rel)             -> { pattern, kind, name } | null     (Qwik City file routing under src/routes)
//   strictTokenHits(text)    -> { token: count }                   (the eight D7 hard tokens)
//
// Export entry: { kind: 'value'|'type'|'reexport', hash, from?, imported? }. `hash` is the sha256 of the
// printed declaration (comments and layout dropped), so two copies with the same code but different
// formatting or comments are "identical" at export level. A re-export has no hash of its own; `from` is the
// module specifier and `imported` the name read there (`*` for `export * as ns`).
import ts from 'typescript';
import { sha256 } from '../compose/lib/util.mjs';

export const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
/** D7 scope: the extensions `assert-no-vendure.sh` greps (plan D7). */
export const D7_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs']);
/** The eight hard tokens of `rotten/store/scripts/assert-no-vendure.sh:21` (plan §3.2, D7). */
export const STRICT_TOKENS = ['__typename', 'priceWithTax', 'featuredAsset', 'customFields', 'facetValues', 'emailAddress', 'streetLine1', 'streetLine2'];
const STRICT_RE = new RegExp(STRICT_TOKENS.join('|'), 'g');

export const extOf = (rel) => {
	const name = rel.split('/').at(-1);
	const i = name.lastIndexOf('.');
	return i <= 0 ? '' : name.slice(i).toLowerCase();
};
export const isCodePath = (rel) => CODE_EXTENSIONS.has(extOf(rel));

function scriptKindOf(rel) {
	const e = extOf(rel);
	if (e === '.tsx') return ts.ScriptKind.TSX;
	if (e === '.jsx') return ts.ScriptKind.JSX;
	if (e === '.js' || e === '.mjs' || e === '.cjs') return ts.ScriptKind.JS;
	return ts.ScriptKind.TS;
}

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

/** Declaration text with comments and layout removed; falls back to whitespace-collapsed source. */
function norm(sf, node) {
	let t;
	try {
		t = printer.printNode(ts.EmitHint.Unspecified, node, sf);
	} catch {
		t = node.getText(sf);
	}
	return t.replace(/\s+/g, ' ').trim();
}

const modifiersOf = (node) => (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []);
const hasMod = (node, kind) => modifiersOf(node).some((m) => m.kind === kind);

function bindingNames(name, out = []) {
	if (ts.isIdentifier(name)) out.push(name.text);
	else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
	return out;
}

const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

export function analyzeModule(rel, text) {
	const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, false, scriptKindOf(rel));
	const exports = new Map();
	const stars = [];
	const imports = [];
	/** top-level declarations by local name, for `export { a }` and `export default a` */
	const locals = new Map();
	const importedLocals = new Map();

	const put = (name, entry) => {
		if (!exports.has(name)) exports.set(name, entry);
	};

	for (const st of sf.statements) {
		if (ts.isImportDeclaration(st)) {
			const spec = ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
			if (spec === null) continue;
			const clause = st.importClause;
			const names = [];
			if (clause?.name) {
				names.push({ imported: 'default', local: clause.name.text });
				importedLocals.set(clause.name.text, { spec, imported: 'default' });
			}
			const nb = clause?.namedBindings;
			if (nb && ts.isNamespaceImport(nb)) {
				names.push({ imported: '*', local: nb.name.text });
				importedLocals.set(nb.name.text, { spec, imported: '*' });
			} else if (nb && ts.isNamedImports(nb)) {
				for (const el of nb.elements) {
					const imported = (el.propertyName ?? el.name).text;
					names.push({ imported, local: el.name.text });
					importedLocals.set(el.name.text, { spec, imported });
				}
			}
			imports.push({ spec, names, typeOnly: !!clause?.isTypeOnly, line: lineOf(sf, st), kind: 'import' });
			continue;
		}
		if (ts.isExportDeclaration(st)) {
			const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
			const clause = st.exportClause;
			if (spec !== null) {
				const names = [];
				if (!clause) {
					stars.push(spec);
					names.push({ imported: '*', local: '*' });
				} else if (ts.isNamespaceExport(clause)) {
					put(clause.name.text, { kind: 'reexport', hash: null, from: spec, imported: '*' });
					names.push({ imported: '*', local: clause.name.text });
				} else {
					for (const el of clause.elements) {
						const imported = (el.propertyName ?? el.name).text;
						put(el.name.text, { kind: 'reexport', hash: null, from: spec, imported });
						names.push({ imported, local: el.name.text });
					}
				}
				imports.push({ spec, names, typeOnly: !!st.isTypeOnly, line: lineOf(sf, st), kind: 'export-from' });
			} else if (clause && ts.isNamedExports(clause)) {
				for (const el of clause.elements) put(el.name.text, { kind: 'local', local: (el.propertyName ?? el.name).text });
			}
			continue;
		}
		if (ts.isExportAssignment(st)) {
			const name = st.isExportEquals ? 'export=' : 'default';
			if (ts.isIdentifier(st.expression)) put(name, { kind: 'local', local: st.expression.text });
			else put(name, { kind: 'value', hash: sha256(norm(sf, st.expression)) });
			continue;
		}

		const exported = hasMod(st, ts.SyntaxKind.ExportKeyword);
		const isDefault = hasMod(st, ts.SyntaxKind.DefaultKeyword);
		if (ts.isVariableStatement(st)) {
			const flag = st.declarationList.flags & ts.NodeFlags.Const ? 'const' : st.declarationList.flags & ts.NodeFlags.Let ? 'let' : 'var';
			for (const d of st.declarationList.declarations) {
				const t = `${flag} ${norm(sf, d)}`;
				for (const n of bindingNames(d.name)) {
					locals.set(n, t);
					if (exported) put(n, { kind: 'value', hash: sha256(t) });
				}
			}
			continue;
		}
		const isType = ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st);
		if (isType || ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st) || ts.isModuleDeclaration(st)) {
			const nm = st.name ? (ts.isIdentifier(st.name) ? st.name.text : st.name.text) : null;
			const t = norm(sf, st);
			if (nm) locals.set(nm, t);
			if (exported) put(isDefault ? 'default' : (nm ?? 'default'), { kind: isType ? 'type' : 'value', hash: sha256(t) });
		}
	}

	// resolve `export { a }` / `export default a` against this file's own declarations or imports
	for (const [name, e] of [...exports]) {
		if (e.kind !== 'local') continue;
		if (locals.has(e.local)) exports.set(name, { kind: 'value', hash: sha256(locals.get(e.local)) });
		else if (importedLocals.has(e.local)) {
			const i = importedLocals.get(e.local);
			exports.set(name, { kind: 'reexport', hash: null, from: i.spec, imported: i.imported });
		} else exports.set(name, { kind: 'value', hash: sha256(`local:${e.local}`) });
	}

	if (text.includes('import(')) {
		const visit = (node) => {
			if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
				imports.push({ spec: node.arguments[0].text, names: [{ imported: '*', local: '*' }], typeOnly: false, line: lineOf(sf, node), kind: 'dynamic' });
			}
			ts.forEachChild(node, visit);
		};
		visit(sf);
	}
	return { exports, stars, imports };
}

/**
 * Slot prop types: the members of `interface SlotPropsMap` as Map<slot name, printed type>. Returns null when the
 * file has no such interface. A type that references another named type is compared by its printed text only.
 */
export function slotMap(rel, text) {
	const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, false, scriptKindOf(rel));
	for (const st of sf.statements) {
		if (!ts.isInterfaceDeclaration(st) || st.name.text !== 'SlotPropsMap') continue;
		const out = new Map();
		for (const m of st.members) {
			if (!ts.isPropertySignature(m) || !m.type) continue;
			const name = ts.isStringLiteral(m.name) || ts.isIdentifier(m.name) ? m.name.text : null;
			if (name !== null) out.set(name, norm(sf, m.type) + (m.questionToken ? ' (optional)' : ''));
		}
		return out;
	}
	return null;
}

/** Qwik City file routing: `src/routes/**` entry files only. Returns null for every other file. */
export function routeOf(rel) {
	if (!rel.startsWith('src/routes/')) return null;
	const parts = rel.slice('src/routes/'.length).split('/');
	const file = parts.pop();
	const m = /^(index[^.]*|layout[^.]*|plugin[^.]*|service-worker)\.(tsx|ts|jsx|js|mdx|md)$/.exec(file);
	if (!m) return null;
	const stem = m[1];
	const pattern = `/${parts.filter((s) => !/^\(.*\)$/.test(s)).join('/')}`;
	const kind = stem.startsWith('index') ? 'page' : stem.startsWith('layout') ? 'layout' : stem.startsWith('plugin') ? 'plugin' : 'service-worker';
	const name = kind === 'page' && stem === 'index' ? pattern : `${pattern}#${stem}`;
	return { pattern, kind, name };
}

/** { token: count } for the eight D7 hard tokens (substring match, case sensitive, like the guard's grep -o). */
export function strictTokenHits(text) {
	const hits = {};
	for (const m of text.matchAll(STRICT_RE)) hits[m[0]] = (hits[m[0]] ?? 0) + 1;
	return hits;
}
export const formatHits = (hits) =>
	Object.keys(hits)
		.sort()
		.map((k) => `${k}:${hits[k]}`)
		.join(';');

const TRIVIAL_LINE = /^[\s{}()[\];,]*$/;
/** Normalised, non-trivial lines as a multiset: the basis of the content similarity. */
export function lineBag(text) {
	const bag = new Map();
	let total = 0;
	for (const raw of text.split('\n')) {
		const line = raw.replace(/\s+/g, ' ').trim();
		if (line === '' || TRIVIAL_LINE.test(line)) continue;
		bag.set(line, (bag.get(line) ?? 0) + 1);
		total++;
	}
	return { bag, total };
}

/** Dice coefficient over two line multisets: 2*|A∩B| / (|A|+|B|), 0 when both are empty. */
export function dice(a, b) {
	if (a.total + b.total === 0) return 0;
	const [small, big] = a.bag.size <= b.bag.size ? [a.bag, b.bag] : [b.bag, a.bag];
	let common = 0;
	for (const [line, n] of small) {
		const m = big.get(line);
		if (m) common += Math.min(n, m);
	}
	return (2 * common) / (a.total + b.total);
}

/** Jaccard overlap of two name sets; 0 when both are empty. */
export function jaccard(a, b) {
	if (a.size === 0 && b.size === 0) return 0;
	let inter = 0;
	for (const x of a) if (b.has(x)) inter++;
	return inter / (a.size + b.size - inter);
}
