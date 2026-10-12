#!/usr/bin/env node
// r5 `public-export-surface` (brand-views plan §2.6): every export of a platformApi.public module is a type, a definition in
// src/platform/**, or a reviewed re-export named in layers.json platformApi.reexports (its name AND its source module must match).
// That is what keeps `~/platform/views` and `~/platform/head` from becoming a back door: a brand may import anything they export, so
// they may not re-export a context, a service, a provider or a loader.
//
//   node scripts/check-public-surface.mjs [--root DIR] [--layers FILE]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { PACKAGE_ROOT, createResolver, loadLayers, parseArgs, parseSource, position } from './check-imports.mjs';

/**
 * Findings for one public module's text. `isPlatformSpecifier(spec)` says whether a module specifier resolves inside src/platform/**.
 */
export function surfaceFindings({ relFile, text, reexports, isPlatformSpecifier }) {
  const sf = parseSource(relFile, text);
  const out = [];
  const add = (node, message) => out.push({ file: relFile, ...position(sf, node), rule: 'public-export-surface', message });

  // import bindings (value imports only) -> module specifier
  const imported = new Map();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.importClause) continue;
    const clause = st.importClause;
    if (clause.isTypeOnly) continue;
    const spec = st.moduleSpecifier.text;
    if (clause.name) imported.set(clause.name.text, spec);
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) imported.set(nb.name.text, spec);
    if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) if (!e.isTypeOnly) imported.set(e.name.text, spec);
  }

  const checkReexport = (node, name, spec) => {
    if (isPlatformSpecifier(spec)) return;
    if (reexports[name] === spec) return;
    add(node, `export '${name}' re-exports '${spec}', which is neither a src/platform/** module nor a reviewed re-export (layers.json platformApi.reexports)`);
  };

  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st)) {
      if (st.isTypeOnly) continue;
      const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
      if (spec !== null) {
        if (!st.exportClause) { if (!isPlatformSpecifier(spec)) add(st, `\`export * from '${spec}'\` is not allowed outside src/platform/**`); continue; }
        if (ts.isNamespaceExport(st.exportClause)) { if (!isPlatformSpecifier(spec)) add(st, `\`export * as ${st.exportClause.name.text} from '${spec}'\` is not allowed outside src/platform/**`); continue; }
        for (const e of st.exportClause.elements) if (!e.isTypeOnly) checkReexport(e, e.name.text, spec);
      } else if (st.exportClause && ts.isNamedExports(st.exportClause)) {
        // `export { X }` of a local binding: a value imported from outside src/platform/** is a re-export in disguise
        for (const e of st.exportClause.elements) {
          if (e.isTypeOnly) continue;
          const local = (e.propertyName ?? e.name).text;
          const spec2 = imported.get(local);
          if (spec2 !== undefined) checkReexport(e, e.name.text, spec2);
        }
      }
    } else if (ts.isExportAssignment(st)) {
      const id = ts.isIdentifier(st.expression) ? st.expression.text : null;
      const spec = id ? imported.get(id) : undefined;
      if (spec !== undefined && !isPlatformSpecifier(spec)) add(st, `a default export of '${id}' from '${spec}' is not allowed`);
    }
  }
  return out;
}

/** The list of public module files (relative paths) that exist in the tree, with their text. */
export function checkPublicSurface({ root, layers }) {
  const resolver = createResolver(root);
  const findings = [];
  let checked = 0;
  const platformDir = layers.platformApi.dir;
  const isPlatformFrom = (fromRel) => (spec) => {
    if (!spec.startsWith('.') && !resolver.isAlias(spec)) return false;
    const r = resolver.resolve(spec, fromRel);
    return !r.error && r.rel.startsWith(platformDir);
  };
  for (const spec of Object.keys(layers.platformApi.public ?? {})) {
    const r = resolver.resolve(spec, 'src/__public_probe__.ts');
    if (r.error) continue;
    checked++;
    const text = fs.readFileSync(path.join(resolver.rootReal, r.rel), 'utf8');
    findings.push(...surfaceFindings({ relFile: r.rel, text, reexports: layers.platformApi.reexports ?? {}, isPlatformSpecifier: isPlatformFrom(r.rel) }));
  }
  return { findings, checked };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = path.resolve(opts.root ?? PACKAGE_ROOT);
  const layers = loadLayers(opts.layers ? path.resolve(opts.layers) : path.join(root, 'layers.json'));
  const { findings, checked } = checkPublicSurface({ root, layers });
  for (const f of findings) console.error(`${f.file}:${f.line}:${f.col} ${f.rule} ${f.message}`);
  if (findings.length > 0) { console.error(`check-public-surface: ${findings.length} finding(s)`); process.exit(1); }
  console.log(`check-public-surface: ${checked} public module(s) clean`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
