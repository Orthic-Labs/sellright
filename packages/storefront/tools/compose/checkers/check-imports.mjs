#!/usr/bin/env node
// Layer classification and import enforcement (plan A14). Node built-ins plus the TypeScript compiler API only.
//
//   node scripts/check-imports.mjs [--root DIR] [--layers FILE] [--overlay-list FILE] [FILE...]
//       Checks overlay-origin files (L3 files and L2 ejects alike; FILE... or the overlay list, default
//       <root>/.compose-overlay-files.txt). Base alone (no overlay files) checks nothing and exits 0.
//   node scripts/check-imports.mjs --validate [--root DIR] [--layers FILE]
//       Validates layers.json, classifies every file under src/, public/ and adapters/ of the root, fails on an
//       ambiguous path (matches two layers), and prints the unclassified paths as a report.
//
// Rules (each finding is "<file>:<line>:<col> <rule> <message>"):
//   layer-unclassified / layer-ambiguous / layer-l1-overlay   an overlay code file outside every layer, on two, or in L1
//   import-forbidden        @sellright/storefront-client, ~/sellright/client (layers.json imports.forbidden)
//   import-l1-bypass        resolves (aliases and '..' included) to an L1 file outside the platform API; type-only exempt
//   import-unresolved / import-outside-root / import-absolute / import-unclassified / import-dynamic / import-glob
//   import-framework-symbol bare specifier or name outside layers.json imports.framework; namespace/default/`export *` rejected (r2)
//   import-node             node:* and Node built-ins (r3)
//   import-platform-private a ~/platform/* target that is not in platformApi.public, or a name outside its list (r4)
//   import-type-only-l1     a type-only import of an L1 file outside imports.typeOnlyAllow and the public platform modules (r6)
//   import-l1-transitive    a base file reached through an overlay file's imports pulls in a non-public L1 file (r1)
// Import classes: framework (bare package), types (type-only), asset (css, images, fonts, json), presentation (L2/L3
// file), platform API (src/platform/**, imported as ~/platform/*). Only TypeScript module resolution decides what a
// specifier points at, so an alias or a '..' chain cannot hide an L1 target.
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LAYER_NAMES = ['L1', 'L2', 'L3'];

// ---------------------------------------------------------------------------------------------------- globs

const segmentCache = new Map();
function segmentRegex(segment) {
  let re = segmentCache.get(segment);
  if (!re) {
    const body = segment
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]');
    re = new RegExp(`^${body}$`);
    segmentCache.set(segment, re);
  }
  return re;
}

function matchSegments(pattern, pi, parts, si) {
  if (pi === pattern.length) return si === parts.length;
  if (pattern[pi] === '**') {
    for (let k = si; k <= parts.length; k++) if (matchSegments(pattern, pi + 1, parts, k)) return true;
    return false;
  }
  if (si === parts.length) return false;
  return segmentRegex(pattern[pi]).test(parts[si]) && matchSegments(pattern, pi + 1, parts, si + 1);
}

// Per-segment glob match on a normalised relative path: UnexpectedX.tsx never matches a pattern ending in X.tsx.
// (Line comment on purpose: a block comment cannot contain the star-star-slash sequence.)
export function matchGlob(pattern, relPath) {
  return matchSegments(pattern.split('/'), 0, relPath.split('/'), 0);
}

export function normalizeRel(p) {
  if (typeof p !== 'string' || p === '') throw new Error(`invalid path: ${JSON.stringify(p)}`);
  if (p.includes('\\') || p.includes('\0') || path.posix.isAbsolute(p)) throw new Error(`path must be relative with '/' separators: ${p}`);
  if (p.split('/').some((s) => s === '' || s === '.' || s === '..')) throw new Error(`path must be normalised (no '.', '..' or empty segment): ${p}`);
  return p;
}

function assertGlob(pattern, where) {
  if (typeof pattern !== 'string' || pattern === '') throw new Error(`layers.json ${where}: empty glob`);
  if (pattern.startsWith('/') || pattern.includes('\\') || pattern.split('/').some((s) => s === '..' || s === '' || s === '.')) {
    throw new Error(`layers.json ${where}: glob must be relative and normalised: ${pattern}`);
  }
  for (const seg of pattern.split('/')) {
    if (seg.includes('**') && seg !== '**') throw new Error(`layers.json ${where}: '**' must be a whole segment: ${pattern}`);
  }
}

// ---------------------------------------------------------------------------------------------------- layers.json

export function loadLayers(file = path.join(PACKAGE_ROOT, 'layers.json')) {
  const layers = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (layers.version !== 1) throw new Error(`layers.json: unsupported version ${layers.version}`);
  for (const name of LAYER_NAMES) {
    const def = layers.layers?.[name];
    if (!def || !Array.isArray(def.include) || def.include.length === 0) throw new Error(`layers.json: layer ${name} needs a non-empty include list`);
    for (const g of def.include) assertGlob(g, `${name}.include`);
    for (const g of def.exclude ?? []) assertGlob(g, `${name}.exclude`);
  }
  for (const ex of layers.assetExceptions ?? []) {
    assertGlob(ex.path, 'assetExceptions');
    if (!LAYER_NAMES.includes(ex.layer)) throw new Error(`layers.json: assetException ${ex.path} has unknown layer ${ex.layer}`);
  }
  if (!layers.platformApi?.dir?.endsWith('/')) throw new Error('layers.json: platformApi.dir must end with "/"');
  const need = (ok, what) => { if (!ok) throw new Error(`layers.json lacks ${what} (the brand-views boundary rules need it)`); };
  need(layers.platformApi.public && typeof layers.platformApi.public === 'object', 'platformApi.public');
  need(layers.platformApi.reexports && typeof layers.platformApi.reexports === 'object', 'platformApi.reexports');
  need(layers.imports?.framework && typeof layers.imports.framework === 'object', 'imports.framework');
  need(Array.isArray(layers.imports?.typeOnlyAllow), 'imports.typeOnlyAllow');
  need(Array.isArray(layers.imports?.transitiveL1Allow), 'imports.transitiveL1Allow');
  return layers;
}

/** @returns {{layer: 'L1'|'L2'|'L3', via: string} | null} null = unclassified. Throws when two layers claim the path. */
export function classify(layers, relPath) {
  const p = normalizeRel(relPath);
  const hits = [];
  for (const name of LAYER_NAMES) {
    const def = layers.layers[name];
    const via = def.include.find((g) => matchGlob(g, p));
    if (via === undefined) continue;
    if ((def.exclude ?? []).some((g) => matchGlob(g, p))) continue;
    hits.push({ layer: name, via });
  }
  for (const ex of layers.assetExceptions ?? []) {
    if (matchGlob(ex.path, p)) hits.push({ layer: ex.layer, via: `assetExceptions:${ex.path}` });
  }
  if (new Set(hits.map((h) => h.layer)).size > 1) {
    throw new Error(`ambiguous layer for ${p}: ${hits.map((h) => `${h.layer} (${h.via})`).join(' and ')}`);
  }
  return hits[0] ?? null;
}

export function isPlatformPath(layers, relPath) {
  return relPath.startsWith(layers.platformApi.dir);
}

export function isCodeFile(layers, relPath) {
  return layers.imports.codeExtensions.includes(path.extname(relPath).toLowerCase());
}

export function readOverlayList(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

// ---------------------------------------------------------------------------------------------------- parsing

export function parseSource(relFile, text) {
  const ext = path.extname(relFile).toLowerCase();
  const kind = ext === '.tsx' ? ts.ScriptKind.TSX
    : ext === '.jsx' ? ts.ScriptKind.JSX
    : ext === '.ts' || ext === '.mts' || ext === '.cts' ? ts.ScriptKind.TS
    : ts.ScriptKind.JS;
  return ts.createSourceFile(relFile, text, ts.ScriptTarget.Latest, true, kind);
}

export function position(sf, node) {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { line: line + 1, col: character + 1 };
}

export function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (c) => walk(c, visit));
}

/** Every module specifier in a file. `literal: null` = a dynamic specifier that cannot be read statically. */
export function collectModuleSpecifiers(sf) {
  const out = [];
  const add = (node, literal, typeOnly, via, detail = null) => out.push({ node, spec: literal, typeOnly, via, detail });
  walk(sf, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const nb = clause?.namedBindings;
      const typeOnly = !!clause && (clause.isTypeOnly
        || (!clause.name && !!nb && ts.isNamedImports(nb) && nb.elements.length > 0 && nb.elements.every((e) => e.isTypeOnly)));
      const names = [];
      let kind = 'side-effect';
      if (clause?.name) kind = 'default';
      if (nb && ts.isNamespaceImport(nb)) kind = 'namespace';
      if (nb && ts.isNamedImports(nb)) {
        if (!clause.name) kind = 'named';
        for (const e of nb.elements) names.push({ name: (e.propertyName ?? e.name).text, typeOnly: !!clause.isTypeOnly || e.isTypeOnly });
      }
      add(node, node.moduleSpecifier.text, typeOnly, 'import', { kind, names });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const ec = node.exportClause;
      const typeOnly = node.isTypeOnly || (!!ec && ts.isNamedExports(ec) && ec.elements.length > 0 && ec.elements.every((e) => e.isTypeOnly));
      const names = [];
      let kind = 'star';
      if (ec && ts.isNamedExports(ec)) {
        kind = 'named';
        for (const e of ec.elements) names.push({ name: (e.propertyName ?? e.name).text, typeOnly: node.isTypeOnly || e.isTypeOnly });
      } else if (ec && ts.isNamespaceExport(ec)) kind = 'namespace';
      add(node, node.moduleSpecifier.text, typeOnly, 'export', { kind, names });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const e = node.moduleReference.expression;
      add(node, ts.isStringLiteral(e) ? e.text : null, node.isTypeOnly, 'import=');
    } else if (ts.isImportTypeNode(node)) {
      const lit = ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal) ? node.argument.literal.text : null;
      add(node, lit, true, 'import-type');
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamic = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if (isDynamic || isRequire) {
        const arg = node.arguments[0];
        const lit = arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? arg.text : null;
        add(node, lit, false, isDynamic ? 'dynamic-import' : 'require');
      } else if (ts.isPropertyAccessExpression(callee) && ts.isMetaProperty(callee.expression) && /^glob/.test(callee.name.text)) {
        add(node, null, false, 'import-meta-glob');
      }
    }
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------- resolution

export function createResolver(root) {
  const rootReal = fs.realpathSync(root);
  const cfg = ts.readConfigFile(path.join(rootReal, 'tsconfig.json'), ts.sys.readFile);
  const rawPaths = cfg.config?.compilerOptions?.paths ?? { '~/*': ['./src/*'] };
  const options = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    allowJs: true,
    resolveJsonModule: true,
    jsx: ts.JsxEmit.ReactJSX,
    paths: rawPaths,
    pathsBasePath: rootReal,
  };
  const host = {
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    directoryExists: ts.sys.directoryExists,
    realpath: ts.sys.realpath,
    getCurrentDirectory: () => rootReal,
    getDirectories: ts.sys.getDirectories,
  };

  const aliasKeys = Object.keys(rawPaths);
  const isAlias = (spec) => aliasKeys.some((k) => (k.endsWith('*') ? spec.startsWith(k.slice(0, -1)) : spec === k));

  function aliasCandidates(spec) {
    const out = [];
    for (const [key, targets] of Object.entries(rawPaths)) {
      if (key.endsWith('*')) {
        const prefix = key.slice(0, -1);
        if (!spec.startsWith(prefix)) continue;
        for (const t of targets) out.push(path.resolve(rootReal, t.split('*').join(spec.slice(prefix.length))));
      } else if (spec === key) {
        for (const t of targets) out.push(path.resolve(rootReal, t));
      }
    }
    return out;
  }

  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

  /** @returns {{rel: string} | {error: string, message: string}} */
  function resolve(spec, fromRel) {
    const clean = spec.replace(/[?#].*$/, '');
    const containing = path.join(rootReal, fromRel);
    let abs;
    const ext = path.extname(clean).toLowerCase();
    const codeLike = ext === '' || ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].includes(ext);
    if (codeLike) {
      const r = ts.resolveModuleName(clean, containing, options, host).resolvedModule;
      if (r && !r.isExternalLibraryImport) abs = r.resolvedFileName;
    }
    if (!abs) {
      const candidates = clean.startsWith('.') ? [path.resolve(path.dirname(containing), clean)] : aliasCandidates(clean);
      abs = candidates.find(isFile);
    }
    if (!abs && !codeLike) {
      // a dotted module name such as '~/theme/theme.config' has a non-code "extension" but is still a TS module
      const r = ts.resolveModuleName(clean, containing, options, host).resolvedModule;
      if (r && !r.isExternalLibraryImport) abs = r.resolvedFileName;
    }
    if (!abs) return { error: 'import-unresolved', message: `cannot resolve '${spec}'` };
    const real = fs.realpathSync(abs);
    const rel = path.relative(rootReal, real);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      return { error: 'import-outside-root', message: `'${spec}' resolves outside the project root` };
    }
    return { rel: rel.split(path.sep).join('/') };
  }

  return { rootReal, isAlias, resolve };
}

// ---------------------------------------------------------------------------------------------------- checks

const finding = (file, sf, node, rule, message) => ({ file, ...(node ? position(sf, node) : { line: 1, col: 1 }), rule, message });

function isForbiddenSpecifier(layers, spec) {
  const clean = spec.replace(/[?#].*$/, '');
  return (layers.imports.forbidden ?? []).some((f) => clean === f || clean.startsWith(`${f}/`));
}

const isBuiltinSpecifier = (spec) => spec.startsWith('node:') || builtinModules.includes(spec) || builtinModules.includes(spec.split('/')[0]);

/** rel path -> allowed names ('*' or a list) for every platformApi.public module that exists in the tree. */
function publicModules(ctx) {
  if (ctx.publicCache) return ctx.publicCache;
  const map = new Map();
  for (const [spec, names] of Object.entries(ctx.layers.platformApi.public ?? {})) {
    const r = ctx.resolver.resolve(spec, 'src/__public_probe__.ts');
    if (!r.error) map.set(r.rel, names);
  }
  ctx.publicCache = map;
  return map;
}

/** rel paths of the reviewed L1 re-export targets (platformApi.reexports) and the type-only allow list. */
function resolvedSet(ctx, key, specs) {
  ctx[key] ??= new Set(specs.map((spec) => ctx.resolver.resolve(spec, 'src/__public_probe__.ts')).filter((r) => !r.error).map((r) => r.rel));
  return ctx[key];
}
const reexportTargets = (ctx) => resolvedSet(ctx, 'reexportCache', Object.values(ctx.layers.platformApi.reexports ?? {}).filter((s) => s.startsWith('~/') || s.startsWith('.')));
const typeOnlyTargets = (ctx) => resolvedSet(ctx, 'typeOnlyCache', ctx.layers.imports.typeOnlyAllow ?? []);

/** r2: bare specifiers and the names imported from them. */
function frameworkFindings(ctx, relFile, sf, node, spec, via, detail, typeOnly) {
  const fw = ctx.layers.imports.framework ?? {};
  const f = (msg) => finding(relFile, sf, node, 'import-framework-symbol', msg);
  if (via === 'dynamic-import' || via === 'require' || via === 'import=') return [f(`'${spec}': a ${via} of a bare package cannot be name-checked; use a static named import`)];
  if (via === 'import-type') return [];
  const allowed = fw[spec];
  if (!Array.isArray(allowed)) return [f(`'${spec}' is not an allowed framework package (layers.json imports.framework)`)];
  if (!detail || detail.kind === 'namespace' || detail.kind === 'default' || detail.kind === 'star') return [f(`'${spec}': namespace, default and \`export *\` forms are not allowed; import allowed names`)];
  if (detail.kind === 'side-effect') return [f(`'${spec}': a bare side-effect import is not allowed`)];
  const out = [];
  for (const { name, typeOnly: nameTypeOnly } of detail.names) {
    const okValue = allowed.includes(name);
    const okType = allowed.includes(`type:${name}`);
    if (nameTypeOnly ? !(okValue || okType) : !okValue) {
      out.push(f(okType && !nameTypeOnly ? `'${name}' from '${spec}' may only be imported as a type (import type)` : `'${name}' from '${spec}' is not in the allowed framework symbols`));
    }
  }
  return out;
}

/** Import findings of one source file. `ctx` = { layers, resolver }. */
export function importFindings(ctx, relFile, text) {
  const { layers, resolver } = ctx;
  const sf = parseSource(relFile, text);
  const out = [];
  for (const { node, spec, typeOnly, via, detail } of collectModuleSpecifiers(sf)) {
    if (via === 'import-meta-glob') {
      out.push(finding(relFile, sf, node, 'import-glob', 'import.meta.glob pulls files in by pattern and cannot be layer-checked'));
      continue;
    }
    if (spec === null) {
      out.push(finding(relFile, sf, node, 'import-dynamic', `${via} with a non-literal specifier cannot be layer-checked`));
      continue;
    }
    if (isForbiddenSpecifier(layers, spec)) {
      out.push(finding(relFile, sf, node, 'import-forbidden', `'${spec}' is forbidden in overlay files (use the platform API)`));
      continue;
    }
    if (isBuiltinSpecifier(spec)) {
      out.push(finding(relFile, sf, node, 'import-node', `Node built-in '${spec}' is not allowed in overlay files`));
      continue;
    }
    if (spec.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(spec) && !resolver.isAlias(spec)) {
      out.push(finding(relFile, sf, node, 'import-absolute', `absolute specifier '${spec}' is not allowed`));
      continue;
    }
    if (!spec.startsWith('.') && !resolver.isAlias(spec)) { // a bare package
      out.push(...frameworkFindings(ctx, relFile, sf, node, spec, via, detail, typeOnly));
      continue;
    }
    const r = resolver.resolve(spec, relFile);
    if (r.error) {
      out.push(finding(relFile, sf, node, r.error, r.message));
      continue;
    }
    const ext = path.extname(r.rel).toLowerCase();
    if (layers.imports.assetExtensions.includes(ext)) continue; // asset
    const pub = publicModules(ctx).get(r.rel);
    if (pub !== undefined) { // platform API: only the listed public modules and names
      if (pub !== '*' && !typeOnly) {
        if (!detail || detail.kind !== 'named') out.push(finding(relFile, sf, node, 'import-platform-private', `'${spec}' exports only ${pub.join(', ')}: use named imports`));
        else for (const n of detail.names) if (!n.typeOnly && !pub.includes(n.name)) out.push(finding(relFile, sf, node, 'import-platform-private', `'${n.name}' is not a public export of '${spec}' (${pub.join(', ')})`));
      }
      continue;
    }
    if (isPlatformPath(layers, r.rel)) {
      if (typeOnly) out.push(finding(relFile, sf, node, 'import-type-only-l1', `'${spec}' is a private platform module; only ~/platform/views and ~/platform/head are public`));
      else out.push(finding(relFile, sf, node, 'import-platform-private', `'${spec}' is a private platform module; only ~/platform/views and ~/platform/head are public`));
      continue;
    }
    let target;
    try {
      target = classify(layers, r.rel);
    } catch (e) {
      out.push(finding(relFile, sf, node, 'layer-ambiguous', e.message));
      continue;
    }
    if (typeOnly) { // types: only L1 files outside the allow list are a problem (r6)
      if (target?.layer === 'L1' && !typeOnlyTargets(ctx).has(r.rel)) {
        out.push(finding(relFile, sf, node, 'import-type-only-l1', `'${spec}' resolves to L1 file ${r.rel}; type-only L1 imports are limited to ${(layers.imports.typeOnlyAllow ?? []).join(', ')}`));
      }
      continue;
    }
    if (!target) {
      out.push(finding(relFile, sf, node, 'import-unclassified', `'${spec}' resolves to ${r.rel}, which is in no layer`));
    } else if (target.layer === 'L1') {
      out.push(finding(relFile, sf, node, 'import-l1-bypass', `'${spec}' resolves to L1 file ${r.rel}; use ~/platform/* instead`));
    }
    // L2 / L3 targets: presentation, allowed here; their own imports are walked by transitiveFindings (r1)
  }
  return out;
}

/**
 * r1: walks the local import graph below an overlay file. A reached base file may import another presentation
 * (L2/L3) file, an asset, a public platform module, a reviewed re-export target or an allow-listed pure L1 file
 * (imports.transitiveL1Allow); anything else in L1 (contexts, providers, services, controllers, ...) is an
 * import-l1-transitive finding that names the chain, so an L2 re-export cannot launder a forbidden module.
 */
export function transitiveFindings(ctx, startRel, readFile) {
  const { layers, resolver } = ctx;
  const out = [];
  const seen = new Set([startRel]);
  const allowL1 = (rel) => (layers.imports.transitiveL1Allow ?? []).some((g) => matchGlob(g, rel));
  const visit = (rel, chain) => {
    let text;
    try { text = readFile(rel); } catch { return; }
    if (text === null || text === undefined) return;
    const sf = parseSource(rel, text);
    const here = [...chain, rel].join(' -> ');
    for (const { node, spec, typeOnly, via, detail } of collectModuleSpecifiers(sf)) {
      if (typeOnly) continue;
      if (spec === null) { out.push(finding(startRel, null, null, 'import-l1-transitive', `${here}: ${via} with a non-literal specifier in a reached file cannot be layer-checked`)); continue; }
      if (isForbiddenSpecifier(layers, spec)) { out.push(finding(startRel, null, null, 'import-l1-transitive', `${here} imports forbidden '${spec}'`)); continue; }
      if (isBuiltinSpecifier(spec)) { out.push(finding(startRel, null, null, 'import-l1-transitive', `${here} imports Node built-in '${spec}'`)); continue; }
      if (!spec.startsWith('.') && !resolver.isAlias(spec)) { // a bare package: the framework packages get the r2 name check, any other package must be reviewed
        const fw = layers.imports.framework ?? {};
        if (Array.isArray(fw[spec])) {
          for (const f of frameworkFindings(ctx, rel, sf, node, spec, via, detail, false)) out.push(finding(startRel, null, null, 'import-l1-transitive', `${here}: ${f.message}`));
        } else if (!(layers.imports.transitivePackagesAllow ?? []).includes(spec)) {
          out.push(finding(startRel, null, null, 'import-l1-transitive', `${here} imports package '${spec}', which is not in layers.json imports.transitivePackagesAllow`));
        }
        continue;
      }
      const r = resolver.resolve(spec, rel);
      if (r.error) continue;
      if (layers.imports.assetExtensions.includes(path.extname(r.rel).toLowerCase())) continue;
      if (publicModules(ctx).has(r.rel) || reexportTargets(ctx).has(r.rel)) continue;
      let target;
      try { target = classify(layers, r.rel); } catch { continue; }
      if (isPlatformPath(layers, r.rel) || (target?.layer === 'L1' && !allowL1(r.rel))) {
        out.push(finding(startRel, null, null, 'import-l1-transitive', `${here} -> ${r.rel}: a reached base file imports non-public L1 file ${r.rel}`));
        continue;
      }
      // L2 / L3 files and the reviewed pure L1 files are walked too: nothing is exempt from the rules below it
      if (!seen.has(r.rel)) { seen.add(r.rel); visit(r.rel, [...chain, rel]); }
    }
  };
  // start from the overlay file's own presentation imports
  const startText = readFile(startRel);
  if (startText === null || startText === undefined) return out;
  const sf0 = parseSource(startRel, startText);
  for (const { spec, typeOnly } of collectModuleSpecifiers(sf0)) {
    if (spec === null || typeOnly) continue;
    if (!spec.startsWith('.') && !resolver.isAlias(spec)) continue;
    const r = resolver.resolve(spec, startRel);
    if (r.error || layers.imports.assetExtensions.includes(path.extname(r.rel).toLowerCase())) continue;
    if (publicModules(ctx).has(r.rel) || isPlatformPath(layers, r.rel) || reexportTargets(ctx).has(r.rel)) continue;
    let target;
    try { target = classify(layers, r.rel); } catch { continue; }
    if (target && !seen.has(r.rel) && (target.layer !== 'L1' || allowL1(r.rel))) { seen.add(r.rel); visit(r.rel, [startRel]); }
  }
  return out;
}

/**
 * Layer-placement findings of an overlay file path (code files only). `deployFiles` are the brand's
 * declared deployment files (brand.json deployFiles, validated by compose): a code file there may sit in
 * no layer (ecosystem.config.cjs). Nothing else changes: a deploy file in L1 or on two layers still fails,
 * and every file not declared stays strictly classified.
 */
export function placementFindings(layers, relFile, deployFiles = []) {
  if (!isCodeFile(layers, relFile)) return [];
  const f = (rule, message) => ({ file: relFile, line: 1, col: 1, rule, message });
  let c;
  try {
    c = classify(layers, relFile);
  } catch (e) {
    return [f('layer-ambiguous', e.message)];
  }
  if (!c && new Set(deployFiles).has(relFile)) return [];
  if (!c) return [f('layer-unclassified', `${relFile} is in no layer; list it in layers.json before overlaying it`)];
  if (c.layer === 'L1') return [f('layer-l1-overlay', `${relFile} is L1 (${c.via}); L1 is locked and not ejectable`)];
  return [];
}

const EXECUTABLE_ASSET = /\.(js|mjs|cjs|wasm|html|htm)$/i;

/** r11: an overlay public/** file that the browser would run or render as a document. */
export function executableAssetFindings(relFile, readText) {
  if (!relFile.startsWith('public/')) return [];
  const f = (message) => ({ file: relFile, line: 1, col: 1, rule: 'overlay-executable-asset', message });
  if (EXECUTABLE_ASSET.test(relFile)) return [f(`${relFile}: overlay public files may not ship executable or document content (.js, .mjs, .cjs, .wasm, .html, .htm)`)];
  if (/\.svg$/i.test(relFile)) {
    const text = readText() ?? '';
    if (/<script[\s>]/i.test(text) || /\son[a-z]+\s*=/i.test(text) || /javascript:/i.test(text)) return [f(`${relFile}: an SVG with <script>, an on*= handler or a javascript: URL is executable`)];
  }
  return [];
}

export function checkOverlayImports({ root, layers, files, deployFiles = [] }) {
  const resolver = createResolver(root);
  const ctx = { layers, resolver };
  const readBase = (rel) => { const p = path.join(resolver.rootReal, rel); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };
  const findings = [];
  let checked = 0;
  for (const raw of files) {
    const rel = normalizeRel(raw);
    const placement = placementFindings(layers, rel, deployFiles);
    findings.push(...placement);
    const abs = path.join(resolver.rootReal, rel);
    if (rel.startsWith('public/')) {
      findings.push(...executableAssetFindings(rel, () => { try { return fs.readFileSync(abs, 'utf8'); } catch { return null; } }));
    }
    if (!isCodeFile(layers, rel)) continue;
    // One open decides everything: O_NOFOLLOW refuses a symlink atomically, so nothing can be swapped in between a check and the read.
    let fd;
    try {
      fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (e) {
      if (e.code === 'ENOENT') findings.push({ file: rel, line: 1, col: 1, rule: 'file-missing', message: `${rel} is listed but does not exist` });
      else if (e.code === 'ELOOP') findings.push({ file: rel, line: 1, col: 1, rule: 'file-symlink', message: `${rel} is a symlink` });
      else throw e;
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(fd, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    checked++;
    findings.push(...importFindings(ctx, rel, text));
    findings.push(...transitiveFindings(ctx, rel, readBase));
  }
  return { findings, checked };
}

/** Walks src/, public/ and adapters/ of root; returns relative file paths (sorted). */
export function listProjectFiles(root) {
  const rootReal = fs.realpathSync(root);
  const out = [];
  const visit = (dirRel) => {
    for (const ent of fs.readdirSync(path.join(rootReal, dirRel), { withFileTypes: true })) {
      if (ent.name === 'node_modules') continue;
      const rel = `${dirRel}/${ent.name}`;
      if (ent.isDirectory()) visit(rel);
      else if (ent.isFile()) out.push(rel);
    }
  };
  for (const top of ['src', 'public', 'adapters']) if (fs.existsSync(path.join(rootReal, top))) visit(top);
  return out.sort();
}

/** --validate: classify the whole tree. Returns { counts, unclassified, ambiguous }. */
export function validateTree(root, layers) {
  const counts = { L1: 0, L2: 0, L3: 0, unclassified: 0 };
  const unclassified = [];
  const ambiguous = [];
  for (const rel of listProjectFiles(root)) {
    try {
      const c = classify(layers, rel);
      if (c) counts[c.layer]++;
      else { counts.unclassified++; unclassified.push(rel); }
    } catch (e) {
      ambiguous.push(e.message);
    }
  }
  return { counts, unclassified, ambiguous };
}

export function formatFinding(f) {
  return `${f.file}:${f.line}:${f.col} ${f.rule} ${f.message}`;
}

export function parseArgs(argv, flags = []) {
  const opts = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root' || a === '--layers' || a === '--overlay-list' || a === '--mode') opts[a.slice(2)] = argv[++i];
    else if (flags.includes(a)) opts[a.slice(2)] = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else opts.files.push(a);
  }
  return opts;
}

export function resolveOverlayFiles(opts, root) {
  if (opts.files.length > 0) return opts.files;
  const list = opts['overlay-list'] ? path.resolve(opts['overlay-list']) : path.join(root, '.compose-overlay-files.txt');
  if (fs.existsSync(list)) return readOverlayList(list);
  if (opts['overlay-list']) throw new Error(`overlay list not found: ${list}`);
  return [];
}

function main() {
  const opts = parseArgs(process.argv.slice(2), ['--validate']);
  const root = path.resolve(opts.root ?? PACKAGE_ROOT);
  const layers = loadLayers(opts.layers ? path.resolve(opts.layers) : path.join(root, 'layers.json'));
  if (opts.validate) {
    const { counts, unclassified, ambiguous } = validateTree(root, layers);
    console.log(`check-imports: layers.json valid; L1 ${counts.L1}, L2 ${counts.L2}, L3 ${counts.L3}, unclassified ${counts.unclassified}`);
    for (const u of unclassified) console.log(`  unclassified ${u}`);
    for (const a of ambiguous) console.error(`check-imports: ${a}`);
    process.exit(ambiguous.length > 0 ? 1 : 0);
  }
  const files = resolveOverlayFiles(opts, root);
  if (files.length === 0) {
    console.log('check-imports: no overlay files (base alone), nothing to check');
    return;
  }
  const { findings, checked } = checkOverlayImports({ root, layers, files });
  for (const f of findings) console.error(formatFinding(f));
  if (findings.length > 0) {
    console.error(`check-imports: ${findings.length} finding(s) in ${files.length} overlay file(s)`);
    process.exit(1);
  }
  console.log(`check-imports: ${checked} overlay code file(s) clean`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
