#!/usr/bin/env node
// Scoped brand-literal lint (plan A19). Node built-ins plus the TypeScript compiler API only.
//
//   node scripts/brand-lint.mjs [--root DIR] [--layers FILE] [--overlay-list FILE] [--mode warn|block] [FILE...]
//
// Finds brand identity baked into BASE code, where the theme/tokens/slots should carry it:
//   identity-colour  a hex colour (or its r,g,b triplet) from the identity palette in layers.json brandLint
//   brand-font       a brand font family name
//   brand-name       a brand or product-family name (Damned Designs, Rotten Hand, Stunning Strangers, RightSites)
//   vendor-ui        Sezzle marketing strings (UI copy, asset URLs); the provider id `provider: 'sezzle'` is exempt
// Only text a reader or the browser sees is scanned: string and template literals, JSX text and CSS values. Comments,
// identifiers and module specifiers are not.
// Scope: src files matching brandLint.include/exclude that are not L3 and not listed in .compose-overlay-files.txt
// (brand-owned code may name its brand). FILE... bypasses the scope and lints exactly those files.
// Mode: layers.json brandLint.mode, "warn" until plan A20 clears the base (exit 0), then "block" (exit 1 on any finding).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
  PACKAGE_ROOT,
  classify,
  listProjectFiles,
  loadLayers,
  matchGlob,
  parseArgs,
  parseSource,
  readOverlayList,
  walk,
} from './check-imports.mjs';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function hexToTriplet(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(',');
}

export function compileLint(layers) {
  const cfg = layers.brandLint;
  if (!cfg) throw new Error('layers.json: brandLint section missing');
  const colours = new Set(cfg.identityColours.map((c) => c.toLowerCase().replace('#', '')));
  const triplets = new Set(cfg.identityColours.map(hexToTriplet));
  const word = (names) => new RegExp(`(?<![A-Za-z])(?:${names.map(escapeRe).join('|')})(?![A-Za-z])`, 'gi');
  return {
    cfg,
    colours,
    triplets,
    hexRe: /#([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?(?![0-9a-zA-Z])/g,
    tripletRe: /(?<![\d.])(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?![\d.])/g,
    fontRe: word(cfg.brandFonts),
    nameRe: word(cfg.brandNames),
    vendorRe: new RegExp(cfg.vendorUi.map(escapeRe).join('|'), 'gi'),
    exemptProviders: new Set(cfg.vendorUiExemptProviderValues ?? []),
  };
}

/** Rule hits inside one piece of visible text. `vendorExempt` suppresses vendor-ui for that text only. */
function scanText(rules, text, vendorExempt) {
  const hits = [];
  for (const m of text.matchAll(rules.hexRe)) {
    if (rules.colours.has(m[1].toLowerCase())) hits.push({ index: m.index, rule: 'identity-colour', message: `identity colour ${m[0]}: take it from a token (var(--color-*))` });
  }
  for (const m of text.matchAll(rules.tripletRe)) {
    if (rules.triplets.has(`${+m[1]},${+m[2]},${+m[3]}`)) hits.push({ index: m.index, rule: 'identity-colour', message: `identity colour as rgb triplet ${m[0]}: take it from a token` });
  }
  for (const m of text.matchAll(rules.fontRe)) hits.push({ index: m.index, rule: 'brand-font', message: `brand font "${m[0]}": use var(--font-*)` });
  for (const m of text.matchAll(rules.nameRe)) hits.push({ index: m.index, rule: 'brand-name', message: `brand name "${m[0]}": read it from the theme identity` });
  if (!vendorExempt) {
    for (const m of text.matchAll(rules.vendorRe)) hits.push({ index: m.index, rule: 'vendor-ui', message: `vendor UI string "${m[0]}": belongs in a slot or the provider label map` });
  }
  return hits;
}

function lineCol(text, offset) {
  let line = 1;
  let last = -1;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) { line++; last = i; }
  return { line, col: offset - last };
}

function isModuleSpecifier(node) {
  const p = node.parent;
  if (!p) return false;
  if ((ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === node) return true;
  if (ts.isExternalModuleReference(p)) return true;
  if (ts.isCallExpression(p) && p.arguments[0] === node && (p.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(p.expression) && p.expression.text === 'require'))) return true;
  return ts.isLiteralTypeNode(p) && !!p.parent && ts.isImportTypeNode(p.parent);
}

function isProviderIdLiteral(rules, node) {
  const p = node.parent;
  if (!p || !ts.isPropertyAssignment(p) || p.initializer !== node) return false;
  const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : '';
  return key === 'provider' && rules.exemptProviders.has(node.text);
}

function lintTs(rules, relFile, text) {
  const sf = parseSource(relFile, text);
  const out = [];
  walk(sf, (node) => {
    const stringy = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node);
    if (!stringy) return;
    if (ts.isStringLiteral(node) && (isModuleSpecifier(node) || (node.parent && ts.isLiteralTypeNode(node.parent)))) return;
    const start = node.getStart(sf);
    const raw = text.slice(start, node.getEnd());
    for (const hit of scanText(rules, raw, ts.isStringLiteral(node) && isProviderIdLiteral(rules, node))) {
      out.push({ file: relFile, ...lineCol(text, start + hit.index), rule: hit.rule, message: hit.message });
    }
  });
  return out;
}

function lintCss(rules, relFile, text) {
  // Blank comments, keeping newlines so line numbers stay true.
  const blanked = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  return scanText(rules, blanked, false).map((hit) => ({ file: relFile, ...lineCol(text, hit.index), rule: hit.rule, message: hit.message }));
}

/** Lint findings of one file (.ts/.tsx/.js/.jsx/.mjs through the compiler API, .css by text). */
export function lintText(layers, relFile, text) {
  const rules = compileLint(layers);
  const ext = path.extname(relFile).toLowerCase();
  const found = ext === '.css' ? lintCss(rules, relFile, text) : lintTs(rules, relFile, text);
  return found.sort((a, b) => a.line - b.line || a.col - b.col || a.rule.localeCompare(b.rule));
}

/** Base files in scope: matches include/exclude, not L3, not overlay-origin. */
export function scopedFiles(root, layers, overlay = []) {
  const { include, exclude = [] } = layers.brandLint;
  const skip = new Set(overlay);
  return listProjectFiles(root).filter((rel) => {
    if (skip.has(rel)) return false;
    if (!include.some((g) => matchGlob(g, rel)) || exclude.some((g) => matchGlob(g, rel))) return false;
    try { return classify(layers, rel)?.layer !== 'L3'; } catch { return true; }
  });
}

export function lintProject({ root, layers, files }) {
  const rootReal = fs.realpathSync(root);
  const findings = [];
  for (const rel of files) findings.push(...lintText(layers, rel, fs.readFileSync(path.join(rootReal, rel), 'utf8')));
  return findings;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = path.resolve(opts.root ?? PACKAGE_ROOT);
  const layers = loadLayers(opts.layers ? path.resolve(opts.layers) : path.join(root, 'layers.json'));
  const mode = opts.mode ?? layers.brandLint.mode;
  if (mode !== 'warn' && mode !== 'block') throw new Error(`--mode must be warn or block, got ${mode}`);
  let files = opts.files;
  if (files.length === 0) {
    const listFile = opts['overlay-list'] ? path.resolve(opts['overlay-list']) : path.join(root, '.compose-overlay-files.txt');
    files = scopedFiles(root, layers, fs.existsSync(listFile) ? readOverlayList(listFile) : []);
  }
  const findings = lintProject({ root, layers, files });
  const label = mode === 'block' ? 'error' : 'warning';
  for (const f of findings) console.log(`${label} ${f.file}:${f.line}:${f.col} ${f.rule} ${f.message}`);
  const counts = {};
  for (const f of findings) counts[f.rule] = (counts[f.rule] ?? 0) + 1;
  console.log(`brand-lint: ${files.length} file(s), ${findings.length} ${label}(s) ${JSON.stringify(counts)}, mode ${mode}`);
  process.exit(mode === 'block' && findings.length > 0 ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
