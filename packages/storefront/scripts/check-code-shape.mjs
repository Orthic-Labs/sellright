#!/usr/bin/env node
// Code-shape enforcement (plan A14), TypeScript compiler API only. Rejects, in EVERY overlay-origin file (L3 files and
// L2 ejects alike), anything that would reintroduce platform logic outside the platform API:
//   definition-call     routeLoader$, routeAction$, globalAction$, server$ (and their Qrl forms), under any alias
//   global-network      global fetch, XMLHttpRequest, WebSocket, navigator.sendBeacon (also via window/globalThis/self)
//   orchestration-call  refreshCartStock, placeOrder, stock refresh helpers, gateway names as call targets
//   import-forbidden    @sellright/storefront-client, ~/sellright/client
// Re-exports of platform loaders and actions (export { useX } from '~/platform/...') are allowed (plan A12).
//
//   node scripts/check-code-shape.mjs [--root DIR] [--layers FILE] [--overlay-list FILE] [FILE...]
//       Overlay mode: FILE... or the overlay list (default <root>/.compose-overlay-files.txt). Exit 1 on any finding.
//   node scripts/check-code-shape.mjs --base [--root DIR] [--layers FILE] [--overlay-list FILE]
//       Base L2 files (classified L2, not overlay) with the same rules. Base-reviewed code that still calls
//       orchestration directly is exempt until plan A13 lands: with layers.json codeShape.baseL2Enforcement = "report"
//       the findings are listed and the exit code is 0; "block" makes them fail.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
  PACKAGE_ROOT,
  classify,
  collectModuleSpecifiers,
  formatFinding,
  isCodeFile,
  listProjectFiles,
  loadLayers,
  normalizeRel,
  parseArgs,
  parseSource,
  position,
  readOverlayList,
  resolveOverlayFiles,
  walk,
} from './check-imports.mjs';

function compile(layers) {
  const cs = layers.codeShape;
  return {
    definitions: new Set(cs.definitionCalls),
    networkGlobals: new Set(cs.networkGlobals),
    networkMethods: new Set(cs.networkMethods),
    globalObjects: new Set(cs.globalObjects),
    orchestrationNames: new Set(cs.orchestrationCalls),
    orchestrationPatterns: (cs.orchestrationPatterns ?? []).map((p) => new RegExp(p)),
    gateway: new RegExp(cs.gatewayNamePattern, 'i'),
  };
}

/** Strips wrappers that do not change the value: `(x)`, `x!`, `x as T`, `<T>x`, `x satisfies T`. */
function unwrap(expr) {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
}

/** True when a receiver is one of the global objects (window, globalThis, self, global), however it is wrapped. */
function isGlobalReceiver(rules, expr) {
  const e = unwrap(expr);
  return ts.isIdentifier(e) && rules.globalObjects.has(e.text);
}

/** Names along a callee: `a.b['c']()` gives ['a', 'b', 'c']. */
function calleeChain(expr) {
  const names = [];
  let e = expr;
  for (;;) {
    e = unwrap(e);
    if (ts.isPropertyAccessExpression(e)) { names.unshift(e.name.text); e = e.expression; }
    else if (ts.isElementAccessExpression(e)) {
      if (ts.isStringLiteralLike(e.argumentExpression)) names.unshift(e.argumentExpression.text);
      e = e.expression;
    } else if (ts.isIdentifier(e)) { names.unshift(e.text); return names; }
    else return names;
  }
}

/** True when an identifier is a name position, not a reference (a.NAME, { NAME: 1 }, NAME() {}, <X NAME="">). */
function isNamePosition(id) {
  const p = id.parent;
  if (!p) return false;
  return (ts.isPropertyAccessExpression(p) && p.name === id)
    || (ts.isPropertyAssignment(p) && p.name === id)
    || (ts.isPropertyDeclaration(p) && p.name === id)
    || (ts.isPropertySignature(p) && p.name === id)
    || (ts.isMethodDeclaration(p) && p.name === id)
    || (ts.isMethodSignature(p) && p.name === id)
    || (ts.isJsxAttribute(p) && p.name === id)
    || (ts.isQualifiedName(p) && p.right === id)
    || ts.isTypeReferenceNode(p);
}

/** Code-shape findings of one source file. */
export function shapeFindings(layers, relFile, text) {
  const rules = compile(layers);
  const sf = parseSource(relFile, text);
  const out = [];
  const seen = new Set();
  const add = (node, rule, message) => {
    const pos = position(sf, node);
    const key = `${pos.line}:${pos.col}:${rule}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ file: relFile, ...pos, rule, message });
  };

  // Local names that alias a forbidden definer or an exact orchestration entry point.
  const aliasDef = new Set();
  const aliasOrch = new Set();
  walk(sf, (node) => {
    if (!ts.isImportSpecifier(node)) return;
    const imported = (node.propertyName ?? node.name).text;
    if (rules.definitions.has(imported)) aliasDef.add(node.name.text);
    if (rules.orchestrationNames.has(imported)) aliasOrch.add(node.name.text);
  });

  for (const { node, spec } of collectModuleSpecifiers(sf)) {
    if (spec === null) continue;
    const clean = spec.replace(/[?#].*$/, '');
    if ((layers.imports.forbidden ?? []).some((f) => clean === f || clean.startsWith(`${f}/`))) {
      add(node, 'import-forbidden', `'${spec}' is forbidden in overlay files (use the platform API)`);
    }
  }

  walk(sf, (node) => {
    if (ts.isIdentifier(node) && !isNamePosition(node)) {
      const t = node.text;
      if (rules.definitions.has(t) || aliasDef.has(t)) add(node, 'definition-call', `${t}: loaders, actions and server functions are defined only in the platform; re-export them from ~/platform/*`);
      else if (rules.networkGlobals.has(t)) add(node, 'global-network', `global ${t} is not allowed in overlay files; call a platform hook`);
      else if (rules.orchestrationNames.has(t) || aliasOrch.has(t)) add(node, 'orchestration-call', `${t} is platform orchestration; overlay files may not call or reference it`);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      const onGlobal = isGlobalReceiver(rules, node.expression);
      if (rules.definitions.has(name)) add(node.name, 'definition-call', `.${name}: loaders, actions and server functions are defined only in the platform`);
      if (rules.networkMethods.has(name)) add(node.name, 'global-network', `.${name} is not allowed in overlay files`);
      if (onGlobal && rules.networkGlobals.has(name)) add(node.name, 'global-network', `${unwrap(node.expression).text}.${name} is not allowed in overlay files`);
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      const name = node.argumentExpression.text;
      const onGlobal = isGlobalReceiver(rules, node.expression);
      if (rules.definitions.has(name)) add(node.argumentExpression, 'definition-call', `['${name}'] is a platform-only definer`);
      if (rules.networkMethods.has(name) || (onGlobal && rules.networkGlobals.has(name))) add(node.argumentExpression, 'global-network', `['${name}'] is not allowed in overlay files`);
    }
    if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
      const chain = calleeChain(node.expression);
      const last = chain[chain.length - 1];
      if (last !== undefined) {
        const byName = rules.orchestrationNames.has(last) || aliasOrch.has(last) || rules.orchestrationPatterns.some((re) => re.test(last));
        const byGateway = chain.some((n) => rules.gateway.test(n));
        if (byName || byGateway) add(node, 'orchestration-call', `call target ${chain.join('.')} is payment or stock orchestration; use a ~/platform/* hook`);
      }
    }
  });
  return out;
}

export function checkOverlayShape({ root, layers, files }) {
  const rootReal = fs.realpathSync(root);
  const findings = [];
  let checked = 0;
  for (const raw of files) {
    const rel = normalizeRel(raw);
    if (!isCodeFile(layers, rel)) continue;
    const abs = path.join(rootReal, rel);
    if (!fs.existsSync(abs)) { findings.push({ file: rel, line: 1, col: 1, rule: 'file-missing', message: `${rel} is listed but does not exist` }); continue; }
    checked++;
    findings.push(...shapeFindings(layers, rel, fs.readFileSync(abs, 'utf8')));
  }
  return { findings, checked };
}

/** Base L2 code files (classified L2, not overlay-origin) run through the same rules. */
export function checkBaseL2Shape({ root, layers, overlay = [] }) {
  const rootReal = fs.realpathSync(root);
  const skip = new Set(overlay);
  const files = listProjectFiles(rootReal).filter((rel) => {
    if (skip.has(rel) || !isCodeFile(layers, rel)) return false;
    try { return classify(layers, rel)?.layer === 'L2'; } catch { return false; }
  });
  const findings = [];
  for (const rel of files) findings.push(...shapeFindings(layers, rel, fs.readFileSync(path.join(rootReal, rel), 'utf8')));
  return { findings, checked: files.length };
}

function main() {
  const opts = parseArgs(process.argv.slice(2), ['--base']);
  const root = path.resolve(opts.root ?? PACKAGE_ROOT);
  const layers = loadLayers(opts.layers ? path.resolve(opts.layers) : path.join(root, 'layers.json'));
  if (opts.base) {
    const listFile = opts['overlay-list'] ? path.resolve(opts['overlay-list']) : path.join(root, '.compose-overlay-files.txt');
    const overlay = fs.existsSync(listFile) ? readOverlayList(listFile) : [];
    const { findings, checked } = checkBaseL2Shape({ root, layers, overlay });
    const block = layers.codeShape.baseL2Enforcement === 'block';
    for (const f of findings) console.log(`${block ? 'FAIL' : 'report'} ${formatFinding(f)}`);
    console.log(`check-code-shape: base L2, ${checked} file(s), ${findings.length} finding(s), enforcement ${block ? 'block' : 'report'}`);
    process.exit(block && findings.length > 0 ? 1 : 0);
  }
  const files = resolveOverlayFiles(opts, root);
  if (files.length === 0) {
    console.log('check-code-shape: no overlay files (base alone), nothing to check');
    return;
  }
  const { findings, checked } = checkOverlayShape({ root, layers, files });
  for (const f of findings) console.error(formatFinding(f));
  if (findings.length > 0) {
    console.error(`check-code-shape: ${findings.length} finding(s) in ${files.length} overlay file(s)`);
    process.exit(1);
  }
  console.log(`check-code-shape: ${checked} overlay code file(s) clean`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
