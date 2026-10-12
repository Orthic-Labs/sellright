#!/usr/bin/env node
// r14 `l2-boundary` (brand-views plan §2.6; gateway plan §6). TypeScript compiler API only.
//
//   node scripts/check-l2-boundary.mjs [--root DIR] [--layers FILE] [--overlay-list FILE] [--strict] [FILE...]
//       Base mode (always): (a) every JSX element in an L1 file whose tag resolves to an L2 declaration (ADVISORY); (b) every base L2 file.
//       Overlay mode (FILE... or the overlay list): (c) the same (b) checks on every overlay-origin L2 eject.
//   Exit 1 on any (b)/(c) finding. (a) findings are printed as warnings and fail only with --strict.
//   Finding format: "<file>:<line>:<col> <rule> <message>".
//
// The guarantee that presentation code receives no live reference is STRUCTURAL and lives elsewhere: L1 reaches presentation only
// through the gateway (src/platform/gateway, enforced by scripts/check-gateway.mjs), which hands it data rebuilt from a fixed schema
// and platform actions whose results are rebuilt the same way. (a) below is a type-based regression detector kept for its diagnostics;
// it is not a complete provenance analysis (JavaScript has an open class of ways to carry a reference) and nothing relies on it.
//
// Rules
//   l2-live-prop        (advisory) an attribute an L1 file passes directly to an L2 component looks like live state: its type carries the
//                       phantom `Live` marker (src/sellright/types/live.ts) or is a Signal/ReadonlySignal/Store/~/contexts type to a
//                       bounded depth, or (syntactically) its root is a binding from useStore, useSignal, useComputed$, a loader .value
//                       or a component's props. Since the gateway, no L1 file renders an L2 component directly, so this normally
//                       reports nothing.
//   l2-forbidden-import an L2 file imports ~/contexts/**, APP_STATE, ~/providers/**, ~/services/** or ~/platform/controllers/**
//   l2-live-prop-type   a component prop type of an L2 file (component$ / exported function parameter and the local types it reaches) is typed Signal/ReadonlySignal or AppState; private helpers are not props
// A reached L2 file is also kept pure by r1 (check-imports.mjs, import-l1-transitive); this script covers what imports alone cannot.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
  PACKAGE_ROOT,
  classify,
  createResolver,
  formatFinding,
  isCodeFile,
  loadLayers,
  normalizeRel,
  parseArgs,
  parseSource,
  position,
  readOverlayList,
  walk,
} from './check-imports.mjs';

const FORBIDDEN_DIRS = ['src/contexts/', 'src/providers/', 'src/services/', 'src/platform/controllers/'];
const FORBIDDEN_NAMES = new Set(['APP_STATE']);
const LIVE_TYPE_NAMES = new Set(['Signal', 'ReadonlySignal', 'ComputedSignal', 'AsyncSignal', 'Store', 'AppState']);
const LIVE_PROP = /^__@LIVE@/; // the unique-symbol property of `Live` (src/sellright/types/live.ts)
const MAX_TYPE_DEPTH = 6;
// Roots a type cannot mark (local presentation state, loader data, props). useContext/useCart are not here: the contexts they return are `Live`-typed.
const TAINT_HOOKS = new Set(['useStore', 'useSignal', 'useComputed$']);
const PROJECT_CALL = /^project[A-Z]/;

const forbiddenTarget = (rel) => FORBIDDEN_DIRS.some((d) => rel.startsWith(d));

function unwrap(expr) {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
}

const rel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

// ---------------------------------------------------------------------------------------------------- (b) / (c) imports and prop types

/** Imports in one L2 file (base L2 or eject) that reach forbidden modules or names. */
export function l2ImportFindings(ctx, relFile, text) {
  const out = [];
  const sf = parseSource(relFile, text);
  const add = (node, rule, message) => out.push({ file: relFile, ...position(sf, node), rule, message });
  walk(sf, (node) => {
    let spec = null;
    let names = [];
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      spec = node.moduleSpecifier.text;
      const nb = node.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb)) names = nb.elements.map((e) => (e.propertyName ?? e.name).text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      spec = node.moduleSpecifier.text;
      if (node.exportClause && ts.isNamedExports(node.exportClause)) names = node.exportClause.elements.map((e) => (e.propertyName ?? e.name).text);
    }
    if (spec === null) return;
    for (const n of names) if (FORBIDDEN_NAMES.has(n)) add(node, 'l2-forbidden-import', `${n} is app state: an L2 file may not read it`);
    if (!spec.startsWith('.') && !ctx.resolver.isAlias(spec)) return;
    const r = ctx.resolver.resolve(spec, relFile);
    if (!r.error && forbiddenTarget(r.rel)) add(node, 'l2-forbidden-import', `'${spec}' resolves to ${r.rel}: an L2 file may not import contexts, providers, services or controllers`);
  });
  return out;
}

/**
 * Syntactic version of the prop-type rule (no type information needed, so the packaged compose copy can run it). It covers the prop
 * surface of the file's components only: the first parameter of a `component$(...)` function (or its type argument) and of an exported
 * function, plus the file-local interfaces and type aliases those types reach. A private helper's parameters are not props: a local
 * `useSignal` may be handed to a private function inside one component.
 */
export function l2PropTypeFindings(relFile, text) {
  const out = [];
  const sf = parseSource(relFile, text);
  const localTypes = new Map();
  const exportedNames = new Set();
  walk(sf, (node) => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) localTypes.set(node.name.text, node);
    if (ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause)) for (const el of node.exportClause.elements) exportedNames.add((el.propertyName ?? el.name).text);
    if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) exportedNames.add(node.expression.text);
  });
  const isExported = (n) => !!ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const roots = []; // type nodes that are component props
  const fromFunction = (fn) => { const p0 = fn?.parameters?.[0]; if (p0?.type) roots.push(p0.type); };
  const asFunction = (init) => { const i = init && unwrap(init); return i && (ts.isArrowFunction(i) || ts.isFunctionExpression(i)) ? i : null; };
  walk(sf, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'component$') {
      fromFunction(asFunction(node.arguments[0]));
      for (const t of node.typeArguments ?? []) roots.push(t);
    } else if (ts.isFunctionDeclaration(node) && (isExported(node) || (node.name && exportedNames.has(node.name.text)))) {
      fromFunction(node);
    } else if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) if (ts.isIdentifier(d.name) && (isExported(node) || exportedNames.has(d.name.text))) fromFunction(asFunction(d.initializer));
    } else if (ts.isExportAssignment(node)) fromFunction(asFunction(node.expression));
  });
  const seen = new Set();
  const reported = new Set();
  const visit = (n) => {
    if (seen.has(n)) return;
    seen.add(n);
    if (ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName)) {
      const name = n.typeName.text;
      if (LIVE_TYPE_NAMES.has(name)) {
        if (!reported.has(n)) { reported.add(n); out.push({ file: relFile, ...position(sf, n), rule: 'l2-live-prop-type', message: `a prop typed ${name} hands live state to an ejectable component` }); }
      } else if (localTypes.has(name)) visit(localTypes.get(name));
    }
    if (ts.isInterfaceDeclaration(n)) for (const h of n.heritageClauses ?? []) for (const t of h.types) if (ts.isIdentifier(t.expression) && localTypes.has(t.expression.text)) visit(localTypes.get(t.expression.text));
    ts.forEachChild(n, visit);
  };
  for (const r of roots) visit(r);
  return out;
}

// ---------------------------------------------------------------------------------------------------- (a) typed call-site check

function createProgram(root) {
  const cfgPath = path.join(root, 'tsconfig.json');
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true, incremental: false, tsBuildInfoFile: undefined } });
  return program;
}

function declaredInProject(root, decl) {
  const f = decl.getSourceFile().fileName;
  return !f.includes('/node_modules/') && !f.endsWith('.d.ts') && f.startsWith(root);
}

const isExternalSymbol = (program, sym) => (sym.declarations ?? []).length > 0 && sym.declarations.every((d) => {
  const sf = d.getSourceFile();
  return program.isSourceFileDefaultLibrary(sf) || sf.fileName.includes('/node_modules/');
});

/**
 * Why the type is live state, or null. Searched through unions and intersections, type arguments, array/tuple elements, every property
 * (accessors resolve to their return type), index signatures and call-signature returns, to MAX_TYPE_DEPTH. `ctx` = { checker, program,
 * root, loc } where `loc` is the expression node the type was taken from.
 */
function liveType(ctx, type, path = '', seen = new Set(), depth = 0) {
  const { checker, program, root, loc } = ctx;
  if (!type || depth > MAX_TYPE_DEPTH || seen.has(type)) return null;
  seen.add(type);
  const at = (what) => (path ? `${path}: ${what}` : what);
  if (type.flags & ts.TypeFlags.TypeParameter) {
    if (ctx.skipGenerics) return null;
    const c = checker.getBaseConstraintOfType(type);
    if (!c || c === type || c.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return at(`${type.symbol?.getName() ?? 'T'} (an unresolved generic)`);
    return liveType(ctx, c, path, seen, depth + 1);
  }
  const symbols = [type.aliasSymbol, type.getSymbol()].filter(Boolean);
  for (const sym of symbols) {
    if (LIVE_TYPE_NAMES.has(sym.getName())) return at(sym.getName());
    for (const d of sym.declarations ?? []) {
      if (declaredInProject(root, d) && rel(root, d.getSourceFile().fileName).startsWith('src/contexts/')) return at(`${sym.getName()} (a ~/contexts type)`);
    }
  }
  if (type.isUnionOrIntersection()) {
    for (const t of type.types) { const r = liveType(ctx, t, path, seen, depth + 1); if (r) return r; }
  }
  if (!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection | ts.TypeFlags.Union | ts.TypeFlags.NonPrimitive))) return null;
  const props = checker.getPropertiesOfType(type);
  if (props.some((p) => LIVE_PROP.test(p.getName()))) return at('the live-state marker');
  // Alias arguments are not walked: a mapped alias (Detached<T> = Omit<T, typeof LIVE>) is judged by the properties it resolves to.
  if (type.flags & ts.TypeFlags.Object && type.objectFlags & ts.ObjectFlags.Reference) {
    for (const t of checker.getTypeArguments(type)) { const r = liveType(ctx, t, path, seen, depth + 1); if (r) return r; }
  }
  for (const sig of type.getCallSignatures?.() ?? []) { const r = liveType(ctx, sig.getReturnType(), `${path}()`, seen, depth + 1); if (r) return r; }
  for (const info of checker.getIndexInfosOfType(type)) { const r = liveType(ctx, info.type, path, seen, depth + 1); if (r) return r; }
  if (type.getSymbol() && isExternalSymbol(program, type.getSymbol())) return null; // Map, Promise, DOM: type arguments only
  for (const prop of props.slice(0, 80)) {
    const r = liveType(ctx, checker.getTypeOfSymbolAtLocation(prop, loc), `${path ? `${path}.` : ''}${prop.getName()}`, seen, depth + 1);
    if (r) return r;
  }
  return null;
}

const isPrimitiveType = (type) => {
  const f = type.flags;
  if (f & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.EnumLike)) return true;
  if (type.isUnion()) return type.types.every(isPrimitiveType);
  return false;
};

const isFunctionType = (checker, type) => {
  if (type.isUnion()) return type.types.every((t) => (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) || isFunctionType(checker, t));
  if (type.getCallSignatures().length > 0) return true;
  const name = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
  return name === 'QRL';
};

const CHECK_CTX = new WeakMap(); // checker -> { program, root }, so the provenance walk can ask the type of any sub-expression

/**
 * Names a binding was taken from: 'useStore', 'a loader .value', 'props', 'a live-typed value' ... or null when the expression is clean.
 * This is the residual of the type check: it follows a value the declared types do not carry (a parameter or return annotated as a plain
 * shape, a call argument, a write into a local) back to a root that is either of unmarked kind (local store, loader, props) or live-typed.
 */
function taintOf(checker, expr, seen = new Set(), depth = 0) {
  if (depth > 10) return null;
  const e = unwrap(expr);
  const cc = CHECK_CTX.get(checker);
  if (cc && !ts.isArrowFunction(e) && !ts.isFunctionExpression(e)) {
    const t = checker.getTypeAtLocation(e);
    if (!isPrimitiveType(t) && !isFunctionType(checker, t)) {
      const live = liveType({ checker, ...cc, loc: e, skipGenerics: true }, t); // a generic's own T is judged at its call sites
      if (live) return `a live-typed value (${live})`;
    }
  }
  const next = (x) => valueTaint(checker, x, seen, depth + 1);
  const first = (list) => { for (const x of list) { const t = next(x); if (t) return t; } return null; };
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) return taintOf(checker, e.expression, seen, depth + 1);
  if (ts.isAwaitExpression(e) || ts.isSpreadElement(e) || ts.isSpreadAssignment(e)) return next(e.expression);
  if (ts.isConditionalExpression(e)) return next(e.whenTrue) ?? next(e.whenFalse); // the condition never flows into the value
  if (ts.isBinaryExpression(e)) {
    const k = e.operatorToken.kind;
    if (k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.QuestionQuestionToken) return next(e.left) ?? next(e.right);
    if (k === ts.SyntaxKind.CommaToken || k === ts.SyntaxKind.EqualsToken) return next(e.right);
    return null; // arithmetic, comparison: primitives
  }
  if (ts.isObjectLiteralExpression(e)) {
    if (e.properties.some((p) => ts.isGetAccessor(p) || ts.isSetAccessor(p))) return 'an object literal with an accessor (it reads live state when the component reads it)';
    return first(e.properties.map((p) => (ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : ts.isSpreadAssignment(p) ? p.expression : null)).filter(Boolean));
  }
  if (ts.isArrayLiteralExpression(e)) return first(e.elements);
  if (ts.isTaggedTemplateExpression(e)) {
    const spans = ts.isTemplateExpression(e.template) ? e.template.templateSpans.map((s) => s.expression) : [];
    return next(e.tag) ?? first(spans);
  }
  if (ts.isNewExpression(e)) return first(e.arguments ?? []);
  if (ts.isCallExpression(e)) {
    const callee = unwrap(e.expression);
    if (ts.isIdentifier(callee)) {
      if (PROJECT_CALL.test(callee.text) || isPlatformFactory(checker, callee)) return null;
      if (TAINT_HOOKS.has(callee.text)) return callee.text;
      if (/^use[A-Z].*Loader$/.test(callee.text)) return `${callee.text}() (a route loader)`;
      return first(e.arguments) ?? returnTaint(checker, callee, seen, depth);
    }
    if (ts.isPropertyAccessExpression(callee) && PROJECT_CALL.test(callee.name.text)) return null;
    if (ts.isPropertyAccessExpression(callee)) { // a method call never clears liveness: the receiver chain (any depth) and the arguments carry it
      const mapped = mapResultTaint(checker, e, callee, seen, depth);
      if (mapped !== undefined) return mapped;
      return taintOf(checker, callee, seen, depth + 1) ?? first(e.arguments);
    }
    return taintOf(checker, callee, seen, depth + 1) ?? first(e.arguments);
  }
  if (ts.isIdentifier(e)) {
    const sym = ts.isShorthandPropertyAssignment(e.parent) && e.parent.name === e ? checker.getShorthandAssignmentValueSymbol(e.parent) : checker.getSymbolAtLocation(e);
    const decl = sym?.valueDeclaration;
    if (!decl || seen.has(decl)) return null;
    seen.add(decl);
    if (ts.isVariableDeclaration(decl)) {
      const t = decl.initializer ? taintOf(checker, decl.initializer, seen, depth + 1) : loopTaint(checker, decl, seen, depth); // `for (const line of cart.lines)`
      return t ?? mutationTaint(checker, decl, seen, depth);
    }
    if (ts.isBindingElement(decl)) {
      let p = decl.parent;
      while (p && (ts.isObjectBindingPattern(p) || ts.isArrayBindingPattern(p) || ts.isBindingElement(p))) p = p.parent;
      if (p && ts.isVariableDeclaration(p)) return p.initializer ? taintOf(checker, p.initializer, seen, depth + 1) : loopTaint(checker, p, seen, depth);
      if (p && ts.isParameter(p)) return parameterTaint(checker, p, seen, depth);
    }
    if (ts.isParameter(decl)) return parameterTaint(checker, decl, seen, depth);
  }
  return null;
}

/**
 * `xs.map(cb)` / `xs.flatMap(cb)` with an inline callback: the result holds only what the callback returns (its parameters are judged
 * where they are used), so `lines.map((l) => projectLine(l))` is detached while `lines.map((l) => l)` is not. undefined = not this shape.
 */
function mapResultTaint(checker, call, callee, seen, depth) {
  if (callee.name.text !== 'map' && callee.name.text !== 'flatMap') return undefined;
  const cb = call.arguments[0] && unwrap(call.arguments[0]);
  if (!cb || !(ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) || !cb.body) return undefined;
  if (!ts.isBlock(cb.body)) return valueTaint(checker, cb.body, seen, depth + 1);
  let hit = null;
  const visit = (n) => {
    if (hit || ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) hit = valueTaint(checker, n.expression, seen, depth + 1);
    else ts.forEachChild(n, visit);
  };
  ts.forEachChild(cb.body, visit);
  return hit;
}

/** taintOf for a member of a larger expression: a primitive or a function value cannot carry a live object. */
function valueTaint(checker, expr, seen, depth) {
  const e = unwrap(expr);
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return functionProblem(checker, e, seen, depth + 1);
  const type = checker.getTypeAtLocation(e);
  if (isPrimitiveType(type)) return null;
  if (isFunctionType(checker, type)) return functionProblem(checker, e, seen, depth + 1);
  return taintOf(checker, e, seen, depth);
}

const CALLBACK_FACTORY_FILES = new Set(['src/platform/controllers/callbacks.ts']); // the allow-listed platform callback factories

/** A call of a function declared in an allow-listed callback-factory module: its result is the platform's own serialised action. */
function isPlatformFactory(checker, callee) {
  const cc = CHECK_CTX.get(checker);
  if (!cc) return false;
  let sym = checker.getSymbolAtLocation(callee);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  const d = sym?.declarations?.[0];
  return !!d && CALLBACK_FACTORY_FILES.has(rel(cc.root, d.getSourceFile().fileName));
}

/** A return type that cannot hold an object: primitives and void, bare or in a Promise. */
function inertReturn(checker, type) {
  if (isPrimitiveType(type)) return true;
  const name = type.getSymbol()?.getName();
  return name === 'Promise' && checker.getTypeArguments(type).every((t) => inertReturn(checker, t));
}

/**
 * A function or QRL handed to an L2 component: why calling it can give live state to ejectable code, or null. Accepted when it is an
 * allow-listed platform factory result, when it returns only primitives/void, or when every value it returns is clean by taintOf
 * (type marker, or a receiver chain rooted in a marked type, at any depth). Inline `$()`, arrows, function expressions, methods,
 * bound methods and functions held in bindings are all judged here.
 */
function functionProblem(checker, expr, seen = new Set(), depth = 0) {
  if (depth > 8) return null;
  const e = unwrap(expr);
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isFunctionDeclaration(e) || ts.isMethodDeclaration(e)) return bodyProblem(checker, e, seen, depth);
  if (ts.isCallExpression(e)) {
    const callee = unwrap(e.expression);
    if (ts.isIdentifier(callee)) {
      if (callee.text === '$' || callee.text.endsWith('$')) return e.arguments[0] ? functionProblem(checker, e.arguments[0], seen, depth + 1) : null;
      if (PROJECT_CALL.test(callee.text) || isPlatformFactory(checker, callee)) return null;
    }
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'bind') { // bound: the target and the bound receiver / arguments
      return functionProblem(checker, callee.expression, seen, depth + 1) ?? taintOf(checker, callee.expression, seen, depth + 1) ?? e.arguments.map((x) => valueTaint(checker, x, seen, depth + 1)).find(Boolean) ?? null;
    }
    return taintOf(checker, e, seen, depth + 1);
  }
  if (ts.isIdentifier(e)) {
    const decl = checker.getSymbolAtLocation(e)?.valueDeclaration;
    if (decl && ts.isFunctionDeclaration(decl)) return bodyProblem(checker, decl, seen, depth);
    if (decl && seen.has(decl)) return null;
    if (decl) seen.add(decl);
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      const init = unwrap(decl.initializer);
      if (!ts.isIdentifier(init) || init !== e) return functionProblem(checker, init, seen, depth + 1) ?? mutationTaint(checker, decl, seen, depth + 1);
    }
    return taintOf(checker, e, seen, depth + 1);
  }
  // a method reference (`cart.lines.at`, `appState.availableCountries.at`): bound or not, it carries its receiver chain
  return taintOf(checker, e, seen, depth + 1);
}

/** The values a function returns (every return statement, or the expression body) judged by provenance. */
function bodyProblem(checker, fn, seen, depth) {
  if (!fn.body || seen.has(fn)) return null;
  seen.add(fn);
  let sig;
  try { sig = checker.getSignatureFromDeclaration(fn); } catch { sig = undefined; }
  if (sig && inertReturn(checker, checker.getReturnTypeOfSignature(sig))) return null;
  const judge = (x) => {
    const v = unwrap(x);
    const t = checker.getTypeAtLocation(v);
    if (isPrimitiveType(t)) return null;
    if (ts.isArrowFunction(v) || ts.isFunctionExpression(v) || isFunctionType(checker, t)) return functionProblem(checker, v, seen, depth + 1);
    return taintOf(checker, v, seen, depth + 1);
  };
  if (!ts.isBlock(fn.body)) return judge(fn.body);
  let hit = null;
  const visit = (n) => {
    if (hit || ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) hit = judge(n.expression);
    else ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn.body, visit);
  return hit;
}

/** A call of a local function: the provenance of what its body returns. */
function returnTaint(checker, callee, seen, depth) {
  const decl = checker.getSymbolAtLocation(callee)?.valueDeclaration;
  let fn = null;
  if (decl && ts.isFunctionDeclaration(decl)) fn = decl;
  else if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
    const init = unwrap(decl.initializer);
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) fn = init;
  }
  if (!fn || !fn.body || seen.has(fn)) return null;
  seen.add(fn);
  if (!ts.isBlock(fn.body)) return valueTaint(checker, fn.body, seen, depth + 1);
  let hit = null;
  const visit = (n) => {
    if (hit || ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) hit = valueTaint(checker, n.expression, seen, depth + 1);
    else ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn.body, visit);
  return hit;
}

const MUTATORS = new Set(['push', 'unshift', 'splice', 'fill', 'set', 'add', 'append']);

/** A local binding written after its declaration: `x = e`, `x.p = e`, `x[k] = e`, `x.push(e)`, `Object.assign(x, e)`. */
function mutationTaint(checker, decl, seen, depth) {
  const sym = checker.getSymbolAtLocation(decl.name);
  if (!sym || !ts.isIdentifier(decl.name)) return null;
  let scope = decl.parent;
  while (scope && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  if (!scope) return null;
  const rootOf = (x) => {
    let r = unwrap(x);
    while (ts.isPropertyAccessExpression(r) || ts.isElementAccessExpression(r)) r = unwrap(r.expression);
    return ts.isIdentifier(r) && checker.getSymbolAtLocation(r) === sym ? r : null;
  };
  let hit = null;
  const visit = (n) => {
    if (hit) return;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && rootOf(n.left)) hit = valueTaint(checker, n.right, seen, depth + 1);
    else if (ts.isCallExpression(n)) {
      const c = unwrap(n.expression);
      if (ts.isPropertyAccessExpression(c) && MUTATORS.has(c.name.text) && rootOf(c.expression)) hit = n.arguments.map((x) => valueTaint(checker, x, seen, depth + 1)).find(Boolean) ?? null;
      else if (ts.isPropertyAccessExpression(c) && c.name.text === 'assign' && ts.isIdentifier(unwrap(c.expression)) && unwrap(c.expression).text === 'Object' && n.arguments[0] && rootOf(n.arguments[0])) hit = n.arguments.slice(1).map((x) => valueTaint(checker, x, seen, depth + 1)).find(Boolean) ?? null;
    }
    if (!hit) ts.forEachChild(n, visit);
  };
  visit(scope);
  return hit;
}

// Array methods whose callback parameters are elements (or the array) of the receiver: the receiver's live provenance carries over.
const COLLECTION_METHODS = new Set(['map', 'flatMap', 'forEach', 'filter', 'find', 'findLast', 'findIndex', 'some', 'every', 'reduce', 'reduceRight', 'sort', 'toSorted']);

/** The symbol a function is bound to (`function f`, `const f = () =>`), or null for an inline function. */
function functionSymbol(checker, fn) {
  if (ts.isFunctionDeclaration(fn) && fn.name) return checker.getSymbolAtLocation(fn.name);
  const p = fn.parent && ts.isParenthesizedExpression(fn.parent) ? fn.parent.parent : fn.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return checker.getSymbolAtLocation(p.name);
  return null;
}

/** The collection-method call a function is handed to as its callback (`xs.map(fn)`), or null. */
function collectionCall(fnOrRef) {
  const call = fnOrRef.parent;
  if (!call || !ts.isCallExpression(call) || !call.arguments.includes(fnOrRef)) return null;
  const callee = unwrap(call.expression);
  return ts.isPropertyAccessExpression(callee) && COLLECTION_METHODS.has(callee.name.text) ? callee : null;
}

/**
 * A function parameter: the component's props, an element of a collection the callback is applied to, or, for a named helper, what its
 * call sites pass (`renderLine(x)`, `xs.map(renderLine)`); anything else is clean.
 */
function parameterTaint(checker, param, seen, depth) {
  if (isComponentProps(param)) return 'props';
  const fn = param.parent;
  if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn))) return null;
  const callee = collectionCall(fn);
  if (callee) return taintOf(checker, callee.expression, seen, depth + 1);
  const sym = functionSymbol(checker, fn);
  if (!sym || seen.has(sym)) return null;
  seen.add(sym);
  const index = fn.parameters.indexOf(param);
  let hit = null;
  const visit = (n) => {
    if (hit) return;
    if (ts.isIdentifier(n) && n.text === sym.getName() && checker.getSymbolAtLocation(n) === sym) {
      const ref = ts.isParenthesizedExpression(n.parent) ? n.parent : n;
      const call = ref.parent;
      if (call && ts.isCallExpression(call) && call.expression === ref) {
        const arg = call.arguments[index];
        if (arg) hit = valueTaint(checker, ts.isSpreadElement(arg) ? arg.expression : arg, seen, depth + 1);
      } else {
        const c = collectionCall(ref);
        if (c) hit = taintOf(checker, c.expression, seen, depth + 1);
      }
    }
    if (!hit) ts.forEachChild(n, visit);
  };
  visit(fn.getSourceFile());
  return hit;
}

/** `for (const x of <expr>)` / `for (const x in <expr>)`: x carries the provenance of <expr>. */
function loopTaint(checker, decl, seen, depth) {
  const list = decl.parent;
  const loop = list?.parent;
  if (loop && (ts.isForOfStatement(loop) || ts.isForInStatement(loop)) && loop.initializer === list) return taintOf(checker, loop.expression, seen, depth + 1);
  return null;
}

/** The first parameter of the function given to component$(...). */
function isComponentProps(param) {
  const fn = param.parent;
  if (!fn || fn.parameters?.[0] !== param) return false;
  const call = fn.parent;
  return !!call && ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === 'component$';
}

/** For an object/array literal: the first problem found in any member (null = every member is allowed). undefined when `e` is not a literal. */
function literalProblem(ctx, e) {
  const { checker } = ctx;
  if (ts.isObjectLiteralExpression(e)) {
    for (const p of e.properties) {
      const member = ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : ts.isSpreadAssignment(p) ? p.expression : null;
      if (member === null && ts.isMethodDeclaration(p)) { // a closure, judged like an arrow function attribute
        const fp = functionProblem(checker, p);
        if (fp) return `a method hands out live state: ${fp}`;
        continue;
      }
      if (member === null) return 'it has an accessor, which can read live state when the component reads it';
      const problem = attrExprProblem(ctx, member);
      if (problem) return problem;
    }
    return null;
  }
  if (ts.isArrayLiteralExpression(e)) {
    for (const x of e.elements) {
      const problem = attrExprProblem(ctx, ts.isSpreadElement(x) ? x.expression : x);
      if (problem) return problem;
    }
    return null;
  }
  return undefined;
}

/** null when the attribute value is allowed, else a message. The TYPE decides first; syntax only judges what a type cannot carry. */
function attrExprProblem(ctx, expr) {
  const { checker } = ctx;
  const e = unwrap(expr);
  if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) return null;
  if (ts.isStringLiteralLike(e) || ts.isNumericLiteral(e) || ts.isTemplateExpression(e) || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword) return null;
  const type = checker.getTypeAtLocation(e);
  const live = liveType({ ...ctx, loc: e }, type);
  if (live) return `its type carries live state (${live})`;
  if (type.flags & ts.TypeFlags.Any) {
    if (ts.isIdentifier(e) && e.text === 'undefined') return null;
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && (e.expression.text === '$' || PROJECT_CALL.test(e.expression.text))) return null;
    return 'it is an any-typed value; pass primitives, a literal, a QRL or a project*() result';
  }
  if (type.flags & ts.TypeFlags.Unknown) return 'it is an unknown-typed value';
  if (isPrimitiveType(type)) return null;
  if (isFunctionType(checker, type)) {
    const fp = functionProblem(checker, e);
    return fp ? `the callback hands out live state: ${fp}; return primitives or a project*() result` : null;
  }
  const lit = literalProblem(ctx, e);
  if (lit !== undefined) return lit;
  const taint = taintOf(checker, e);
  if (taint) return `the object is rooted at ${taint}; pass a project*() result or primitives`;
  return null;
}

/** (a) over every L1 file in the program. */
export function callSiteFindings({ root, layers, program }) {
  const checker = program.getTypeChecker();
  const ctx = { checker, program, root };
  CHECK_CTX.set(checker, { program, root });
  const out = [];
  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.startsWith(root) || sf.fileName.includes('/node_modules/') || !sf.fileName.endsWith('.tsx')) continue;
    const relFile = rel(root, sf.fileName);
    if (!relFile.startsWith('src/')) continue;
    let layer;
    try { layer = classify(layers, relFile)?.layer; } catch { continue; }
    if (layer !== 'L1' || /\.test\.tsx?$/.test(relFile)) continue;
    walk(sf, (node) => {
      if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
      const tag = node.tagName;
      if (!ts.isIdentifier(tag) && !ts.isPropertyAccessExpression(tag)) return;
      let sym = checker.getSymbolAtLocation(tag);
      if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
      const decl = sym?.declarations?.[0];
      if (!decl) return;
      const f = decl.getSourceFile().fileName;
      if (!f.startsWith(root) || f.includes('/node_modules/')) return;
      let target;
      try { target = classify(layers, rel(root, f))?.layer; } catch { return; }
      if (target !== 'L2') return;
      const tagName = tag.getText(sf);
      for (const attr of node.attributes.properties) {
        if (ts.isJsxAttribute(attr) && ['key', 'ref'].includes(attr.name.getText(sf))) continue; // framework meta, not component props
        const expr = ts.isJsxSpreadAttribute(attr) ? attr.expression : attr.initializer && ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : null;
        if (!expr) continue;
        const problem = attrExprProblem(ctx, expr);
        if (problem) {
          const name = ts.isJsxSpreadAttribute(attr) ? '{...spread}' : attr.name.getText(sf);
          out.push({ file: relFile, ...position(sf, attr), rule: 'l2-live-prop', message: `<${tagName} ${name}>: ${problem}` });
        }
      }
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- drivers

/** (b) for every base L2 file (not overlay-origin) in the real tree. */
export function baseL2Findings({ root, layers, resolver, files }) {
  const out = [];
  for (const relFile of files) {
    if (!isCodeFile(layers, relFile)) continue;
    let layer;
    try { layer = classify(layers, relFile)?.layer; } catch { continue; }
    if (layer !== 'L2' || /\.test\.tsx?$/.test(relFile)) continue;
    const text = fs.readFileSync(path.join(root, relFile), 'utf8');
    out.push(...l2ImportFindings({ layers, resolver }, relFile, text), ...l2PropTypeFindings(relFile, text));
  }
  return out;
}

/** (c) overlay-origin L2 ejects. Syntactic only, so it also runs in a cold compose scratch tree without node_modules. */
export function checkEjectBoundary({ root, layers, files }) {
  const resolver = createResolver(root);
  const out = [];
  let checked = 0;
  for (const raw of files) {
    const relFile = normalizeRel(raw);
    if (!isCodeFile(layers, relFile)) continue;
    let layer;
    try { layer = classify(layers, relFile)?.layer; } catch { continue; }
    if (layer !== 'L2') continue;
    const abs = path.join(resolver.rootReal, relFile);
    if (!fs.existsSync(abs)) continue;
    checked++;
    const text = fs.readFileSync(abs, 'utf8');
    out.push(...l2ImportFindings({ layers, resolver }, relFile, text), ...l2PropTypeFindings(relFile, text));
  }
  return { findings: out, checked };
}

export function listSrcFiles(root) {
  const out = [];
  const visit = (dirRel) => {
    for (const ent of fs.readdirSync(path.join(root, dirRel), { withFileTypes: true })) {
      if (ent.name === 'node_modules') continue;
      const r = `${dirRel}/${ent.name}`;
      if (ent.isDirectory()) visit(r);
      else if (ent.isFile()) out.push(r);
    }
  };
  visit('src');
  return out.sort();
}

/** `findings` block; `advisories` are the (a) call-site diagnostics (gateway plan §6). */
export function checkL2Boundary({ root, layers, overlay = [] }) {
  const rootReal = fs.realpathSync(root);
  const resolver = createResolver(rootReal);
  const skip = new Set(overlay);
  const findings = [];
  findings.push(...baseL2Findings({ root: rootReal, layers, resolver, files: listSrcFiles(rootReal).filter((f) => !skip.has(f)) }));
  const program = createProgram(rootReal);
  const advisories = callSiteFindings({ root: rootReal, layers, program });
  const eject = checkEjectBoundary({ root: rootReal, layers, files: overlay });
  findings.push(...eject.findings);
  return { findings, advisories, ejectsChecked: eject.checked };
}

function main() {
  const opts = parseArgs(process.argv.slice(2), ['--strict']);
  const root = path.resolve(opts.root ?? PACKAGE_ROOT);
  const layers = loadLayers(opts.layers ? path.resolve(opts.layers) : path.join(root, 'layers.json'));
  let overlay = opts.files;
  if (overlay.length === 0) {
    const list = opts['overlay-list'] ? path.resolve(opts['overlay-list']) : path.join(root, '.compose-overlay-files.txt');
    if (fs.existsSync(list)) overlay = readOverlayList(list);
  }
  const { findings, advisories, ejectsChecked } = checkL2Boundary({ root, layers, overlay });
  for (const f of advisories) console.error(`warning: ${formatFinding(f)}`);
  for (const f of findings) console.error(formatFinding(f));
  const failing = findings.length + (opts.strict ? advisories.length : 0);
  if (failing > 0) {
    console.error(`check-l2-boundary: ${findings.length} finding(s), ${advisories.length} advisory warning(s)${opts.strict ? ' (--strict)' : ''}`);
    process.exit(1);
  }
  console.log(`check-l2-boundary: clean (${ejectsChecked} L2 eject(s) checked; ${advisories.length} advisory warning(s))`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
