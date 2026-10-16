#!/usr/bin/env node
// Brand views gateway, import-graph rule (docs/plans/2026-10-11-brand-views-gateway.md §5; layers.json `gateway`).
//
//   node scripts/check-gateway.mjs [--root DIR] [--layers FILE]
//   Exit 1 on any finding. Finding format: "<file>:<line>:<col> <rule> <message>".
//
// The gateway (layers.json gateway.dir) is the only L1 access to presentation implementations: L2/L3 modules and the slot lookup.
// Resolution is check-imports.mjs's (tsconfig paths, index files, re-exports). Rules, for every non-test code file under src/:
//   gateway-import          a file that is neither presentation (L2/L3) nor in gateway.dir value-imports, re-exports (named or *),
//                           dynamically imports or globs a presentation module or a gateway.implementationModules file, or imports a
//                           gateway.virtualImplementations specifier from a file not listed for it. Type-only imports pass. Inside
//                           gateway.dir the slot lookup may only be imported by gateway.slotLookupImporters.
//   gateway-dynamic-import  a non-presentation file calls import()/require() with a non-literal specifier (it cannot be resolved)
//   gateway-raw-escape      in gateway.dir, a raw presentation binding is used other than as a direct argument of a gateway.factories
//                           call (exported, aliased, returned, rendered, stored), or a presentation module is re-exported
//   gateway-action-literal  an object literal with `kind: '<gateway.actionKind>'` outside gateway.actionModule (handles come only
//                           from platformAction)
// Any path from L1 to an implementation has a first edge leaving a non-presentation file, and that edge is a finding: an L1 helper that
// re-exports a raw component is itself the flagged file. Presentation files may import each other freely.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
  PACKAGE_ROOT,
  classify,
  collectModuleSpecifiers,
  createResolver,
  formatFinding,
  isCodeFile,
  loadLayers,
  parseArgs,
  parseSource,
  position,
  walk,
} from './check-imports.mjs';

// Test code: *.test.* files and `__stubs__/` (vitest aliases only; never part of a build).
const isTest = (rel) => /\.test\.[cm]?[jt]sx?$/.test(rel) || /(^|\/)__stubs__\//.test(rel);

function gatewayConfig(layers) {
  const g = layers.gateway;
  if (!g || typeof g.dir !== 'string' || !g.dir.endsWith('/')) throw new Error('layers.json: gateway.dir (ending in "/") is required');
  return {
    dir: g.dir,
    implementationModules: new Set(g.implementationModules ?? []),
    slotLookupImporters: new Set(g.slotLookupImporters ?? []),
    virtualImplementations: g.virtualImplementations ?? {},
    factories: new Set(g.factories ?? []),
    actionModule: g.actionModule,
    actionKind: g.actionKind ?? 'sr-action',
  };
}

const layerOf = (layers, rel) => {
  try {
    return classify(layers, rel)?.layer ?? null;
  } catch {
    return null;
  }
};

const isPresentation = (layers, rel) => ['L2', 'L3'].includes(layerOf(layers, rel));

function listCodeFiles(root, layers) {
  const out = [];
  const visit = (dirRel) => {
    for (const ent of fs.readdirSync(path.join(root, dirRel), { withFileTypes: true })) {
      if (ent.name === 'node_modules') continue;
      const r = `${dirRel}/${ent.name}`;
      if (ent.isDirectory()) visit(r);
      else if (ent.isFile() && isCodeFile(layers, r) && !isTest(r)) out.push(r);
    }
  };
  visit('src');
  return out.sort();
}

/** What an import edge reaches, or null when it is not an implementation. */
function implementationTarget(ctx, relFile, spec) {
  const { layers, resolver, cfg } = ctx;
  if (spec in cfg.virtualImplementations) return { kind: 'virtual', rel: spec };
  if (!spec.startsWith('.') && !resolver.isAlias(spec)) return null;
  const r = resolver.resolve(spec, relFile);
  if (r.error) return null;
  if (cfg.implementationModules.has(r.rel)) return { kind: 'slot-lookup', rel: r.rel };
  if (isPresentation(layers, r.rel)) return { kind: 'presentation', rel: r.rel };
  return null;
}

/** Findings for one file. */
export function gatewayFileFindings(ctx, relFile, text) {
  const { layers, cfg } = ctx;
  const out = [];
  const sf = parseSource(relFile, text);
  const add = (node, rule, message) => out.push({ file: relFile, ...position(sf, node), rule, message });
  const inGateway = relFile.startsWith(cfg.dir);
  const presentation = isPresentation(layers, relFile);

  // gateway-action-literal (every file)
  if (relFile !== cfg.actionModule) {
    walk(sf, (node) => {
      if (!ts.isObjectLiteralExpression(node)) return;
      for (const p of node.properties) {
        if (ts.isPropertyAssignment(p) && p.name.getText(sf).replace(/['"]/g, '') === 'kind' && ts.isStringLiteralLike(p.initializer) && p.initializer.text === cfg.actionKind) {
          add(node, 'gateway-action-literal', `an action handle is built only by platformAction (${cfg.actionModule})`);
        }
      }
    });
  }
  if (presentation) return out;

  const rawBindings = new Set();
  for (const s of collectModuleSpecifiers(sf)) {
    if (s.spec === null) {
      if (s.via === 'import-meta-glob') add(s.node, 'gateway-import', 'import.meta.glob cannot be resolved: list the modules explicitly');
      else if (s.via === 'dynamic-import' || s.via === 'require') add(s.node, 'gateway-dynamic-import', `a non-literal ${s.via} cannot be resolved`);
      continue;
    }
    if (s.typeOnly || s.via === 'import-type') continue;
    const target = implementationTarget(ctx, relFile, s.spec);
    if (!target) continue;
    if (target.kind === 'virtual') {
      if (!(cfg.virtualImplementations[s.spec] ?? []).includes(relFile)) add(s.node, 'gateway-import', `'${s.spec}' (brand implementations) may only be imported by ${(cfg.virtualImplementations[s.spec] ?? []).join(', ')}`);
      continue;
    }
    if (!inGateway) {
      const what = target.kind === 'slot-lookup' ? 'the slot lookup' : `presentation module ${target.rel}`;
      add(s.node, 'gateway-import', `'${s.spec}' reaches ${what}: L1 renders presentation only through ~/platform/gateway handles`);
      continue;
    }
    if (target.kind === 'slot-lookup') {
      if (!cfg.slotLookupImporters.has(relFile)) add(s.node, 'gateway-import', `the slot lookup may only be imported by ${[...cfg.slotLookupImporters].join(', ')}`);
      continue;
    }
    // presentation module imported by a gateway file
    if (s.via === 'export') {
      add(s.node, 'gateway-raw-escape', `re-exporting ${target.rel} hands out the raw implementation`);
      continue;
    }
    if (s.via !== 'import') {
      add(s.node, 'gateway-raw-escape', `${s.via} of ${target.rel}: import it statically and pass it to a gateway factory`);
      continue;
    }
    const clause = s.node.importClause;
    if (clause?.name) rawBindings.add(clause.name.text);
    const nb = clause?.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) rawBindings.add(nb.name.text);
    if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) if (!clause.isTypeOnly && !e.isTypeOnly) rawBindings.add(e.name.text);
  }

  if (inGateway && rawBindings.size > 0) {
    walk(sf, (node) => {
      if (!ts.isIdentifier(node) || !rawBindings.has(node.text)) return;
      const parent = node.parent;
      if (ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent)) return;
      if (ts.isPropertyAccessExpression(parent) && parent.name === node) return;
      if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) return;
      if (ts.isCallExpression(parent) && parent.arguments.includes(node) && ts.isIdentifier(parent.expression) && ctx.cfg.factories.has(parent.expression.text)) return;
      add(node, 'gateway-raw-escape', `raw implementation '${node.text}' may only be passed to ${[...ctx.cfg.factories].join('/')}`);
    });
  }
  return out;
}

export function checkGateway({ root, layers }) {
  const rootReal = fs.realpathSync(root);
  const cfg = gatewayConfig(layers);
  const ctx = { layers, cfg, resolver: createResolver(rootReal) };
  const findings = [];
  for (const rel of listCodeFiles(rootReal, layers)) findings.push(...gatewayFileFindings(ctx, rel, fs.readFileSync(path.join(rootReal, rel), 'utf8')));
  return { findings };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = path.resolve(opts.root ?? PACKAGE_ROOT);
  const layers = loadLayers(opts.layers ? path.resolve(opts.layers) : path.join(root, 'layers.json'));
  const { findings } = checkGateway({ root, layers });
  for (const f of findings) console.error(formatFinding(f));
  if (findings.length > 0) {
    console.error(`check-gateway: ${findings.length} finding(s)`);
    process.exit(1);
  }
  console.log('check-gateway: clean');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
