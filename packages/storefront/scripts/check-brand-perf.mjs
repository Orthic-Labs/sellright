#!/usr/bin/env node
// Brand performance guards over the composed tree (src/brand-slots, src/brand). Run by `pnpm build` (check:brand-perf) and by the
// client build itself (src/platform/build-guards.ts), so a brand build script that runs the checks one by one cannot skip it.
//
//   node scripts/check-brand-perf.mjs [--root DIR]
//   Exit 1 on any error; warnings are printed and never fail. Finding format: "<file>:<line>:<col> <rule> <message>".
//
// Rules:
//   img-lazy-priority   (error) a TSX element in src/brand-slots/** or src/brand/** asks for high fetch priority (fetchpriority/
//                       fetchPriority "high", or a `priority` flag) and is lazy-loaded: loading="lazy", or no `loading` on a component
//                       (OptimizedImage defaults loading to 'lazy' unless priority). A plain <img> without loading is eager.
//   img-hero-lazy       (error) the first image route.home renders (the hero, the usual LCP element) is lazy-loaded.
//   font-display-swap   (error) an @font-face of the brand display/heading family (first family of --brand-font-display /
//                       --brand-font-heading in src/brand/tokens.css) has a font-display other than swap (missing = the auto/block
//                       default). Only url() faces count; src/brand/license.css (license flow) is not scanned.
//   font-fallback-face  (error) that family has url() faces but no '<Family> Fallback' @font-face with size-adjust (layout shift on swap).
//   lcp-hidden-start    (error) an LCP candidate image — the first image route.home renders, or any image asking for high fetch
//                       priority in src/brand-slots/** or src/brand/** — or one of its JSX ancestors starts hidden: a `data-reveal`
//                       attribute, or a static class that a brand stylesheet (src/brand/**/*.css) gives opacity: 0, visibility: hidden,
//                       or an animation whose first keyframe (from / 0%) has opacity 0 (a fade-in or JS reveal). The browser does
//                       not paint the LCP element until it is visible. Animations on it may only transform. Rules inside
//                       @media (prefers-reduced-motion) and :hover/:focus/:active states are ignored.
//   font-preload-high   (warning) a display-family face at weight 700 or at the h1 weight (700 unless a brand rule on h1 sets it) has no
//                       head.json fontPreloads entry for its file with fetchpriority "high".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_H1_WEIGHT = 700; // src/global.css: h1..h6 { font-family: var(--font-display); font-weight: 700 }

function walk(root, dirRel, accept) {
  const out = [];
  const abs = path.join(root, dirRel);
  if (!fs.existsSync(abs)) return out;
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '__stubs__' || ent.name === '__fixtures__') continue;
    const rel = `${dirRel}/${ent.name}`;
    if (ent.isDirectory()) out.push(...walk(root, rel, accept));
    else if (ent.isFile() && accept(rel)) out.push(rel);
  }
  return out.sort();
}

const isTsx = (rel) => /\.tsx$/.test(rel) && !/\.test\.tsx$/.test(rel);

// ── images ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Static value of a JSX attribute: a string, true/false, undefined (absent) or DYNAMIC. */
const DYNAMIC = Symbol('dynamic');
function attrValue(attrs, names) {
  for (const a of attrs.properties) {
    if (!ts.isJsxAttribute(a) || !names.includes(a.name.getText())) continue;
    const init = a.initializer;
    if (!init) return true;
    if (ts.isStringLiteral(init)) return init.text;
    if (ts.isJsxExpression(init) && init.expression) {
      const e = init.expression;
      if (ts.isStringLiteralLike(e)) return e.text;
      if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
      if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
    }
    return DYNAMIC;
  }
  for (const a of attrs.properties) if (ts.isJsxSpreadAttribute(a)) return DYNAMIC;
  return undefined;
}

/** Static class tokens of a JSX class/className attribute (string or template literal; tokens next to `${}` are dropped). */
function staticClasses(attrs) {
  const out = [];
  for (const a of attrs.properties) {
    if (!ts.isJsxAttribute(a) || !['class', 'className'].includes(a.name.getText())) continue;
    let e = a.initializer;
    if (e && ts.isJsxExpression(e)) e = e.expression;
    if (!e) continue;
    if (ts.isStringLiteralLike(e)) out.push(...e.text.split(/\s+/));
    else if (ts.isTemplateExpression(e)) {
      const parts = [e.head.text, ...e.templateSpans.map((sp) => sp.literal.text)];
      parts.forEach((t, i) => {
        const toks = t.split(/(\s+)/);
        // a token glued to an interpolation (first token after `${}`, last before one) is not a whole class name
        const words = toks.filter((x) => x && !/^\s+$/.test(x));
        if (words.length === 0) return;
        if (i > 0 && !/^\s/.test(t)) words.shift();
        if (i < parts.length - 1 && !/\s$/.test(t)) words.pop();
        out.push(...words);
      });
    }
  }
  return out.filter(Boolean);
}

/** The element and its JSX ancestors, innermost first: tag, static classes, data-reveal. */
function elementChain(node, sf) {
  const chain = [];
  const push = (el) => chain.push({ tag: el.tagName.getText(sf), classes: staticClasses(el.attributes), reveal: attrValue(el.attributes, ['data-reveal']) !== undefined });
  push(node);
  for (let p = ts.isJsxOpeningElement(node) ? node.parent.parent : node.parent; p; p = p.parent) {
    if (ts.isJsxElement(p)) push(p.openingElement);
  }
  return chain;
}

function imageElements(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = [];
  const visit = (node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText(sf);
      const isImg = tag === 'img';
      const isComponent = /^[A-Z]/.test(tag) && /Image$/.test(tag);
      if (isImg || isComponent) {
        const fetchpriority = attrValue(node.attributes, ['fetchpriority', 'fetchPriority']);
        const priority = attrValue(node.attributes, ['priority']);
        const loading = attrValue(node.attributes, ['loading']);
        const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        out.push({ tag, isImg, fetchpriority, priority, loading, line: line + 1, col: character + 1, chain: elementChain(node, sf) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** 'lazy' | 'eager' | 'dynamic' as rendered: a component without `loading` renders lazy, unless it has priority (OptimizedImage
 *  defaults a priority image to eager, #360). */
function effectiveLoading(el) {
  if (el.loading === DYNAMIC) return 'dynamic';
  if (el.loading === undefined) return el.isImg || el.priority === true ? 'eager' : 'lazy';
  return el.loading === 'lazy' ? 'lazy' : 'eager';
}

const isHigh = (el) => el.fetchpriority === 'high' || el.priority === true;

export function checkImages(root) {
  const findings = [];
  const files = [...walk(root, 'src/brand-slots', isTsx), ...walk(root, 'src/brand', isTsx)];
  const hidden = hiddenStartClasses(root);
  for (const rel of files) {
    const els = imageElements(rel, fs.readFileSync(path.join(root, rel), 'utf8'));
    const lcp = new Set(els.filter(isHigh));
    if (rel === 'src/brand-slots/route.home.tsx' && els.length > 0) lcp.add(els[0]);
    for (const el of lcp) {
      for (const [depth, a] of el.chain.entries()) {
        const who = depth === 0 ? `the LCP image <${a.tag}>` : `an ancestor <${a.tag}> of the LCP image <${el.tag}>`;
        const reason = a.reveal ? 'has data-reveal (an opacity-0 reveal animation)' : (() => {
          const c = a.classes.find((k) => hidden.has(k));
          return c ? `has class "${c}", which ${hidden.get(c)}` : null;
        })();
        if (reason) {
          findings.push({ file: rel, line: el.line, col: el.col, rule: 'lcp-hidden-start', level: 'error', message: `${who} ${reason}; the LCP element must be visible at first paint (animate transform only)` });
          break;
        }
      }
    }
    for (const el of els) {
      if (isHigh(el) && effectiveLoading(el) === 'lazy') {
        const why = el.loading === undefined ? `<${el.tag}> has no loading attribute (defaults to lazy)` : `<${el.tag}> has loading="lazy"`;
        findings.push({ file: rel, line: el.line, col: el.col, rule: 'img-lazy-priority', level: 'error', message: `${why} with high fetch priority; set loading="eager"` });
      }
    }
    if (rel === 'src/brand-slots/route.home.tsx' && els.length > 0) {
      const hero = els[0];
      if (effectiveLoading(hero) === 'lazy') {
        findings.push({ file: rel, line: hero.line, col: hero.col, rule: 'img-hero-lazy', level: 'error', message: `the first image route.home renders (<${hero.tag}>, the hero/LCP) is lazy-loaded; set loading="eager"` });
      }
    }
  }
  return findings;
}

// ── hidden-start styles ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Top-level blocks of a CSS text: { prelude, body, index } with balanced braces. */
function cssBlocks(text) {
  const out = [];
  let depth = 0, start = 0, open = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') { if (depth === 0) open = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && open >= 0) { out.push({ prelude: text.slice(start, open).trim(), body: text.slice(open + 1, i), index: start }); start = i + 1; open = -1; }
      if (depth < 0) depth = 0;
    } else if (ch === ';' && depth === 0) start = i + 1;
  }
  return out;
}

const isZero = (v) => v !== undefined && /^0*\.?0*%?$/.test(v.replace(/!important/, '').trim()) && /0/.test(v);

/** Keyframes whose first frame (from / 0%) has opacity 0. */
function hiddenKeyframes(blocks, acc = new Set()) {
  for (const b of blocks) {
    const kf = /^@(?:-webkit-)?keyframes\s+([\w-]+)/.exec(b.prelude);
    if (kf) {
      for (const f of cssBlocks(b.body)) {
        if (f.prelude.split(',').some((x) => /^(from|0%)$/.test(x.trim())) && isZero(descriptors(f.body).opacity)) acc.add(kf[1]);
      }
    } else if (/^@/.test(b.prelude)) hiddenKeyframes(cssBlocks(b.body), acc);
  }
  return acc;
}

const STATE_PSEUDO = /:(hover|focus|focus-visible|focus-within|active|checked|disabled|target)\b/;

/** class -> why it starts hidden, from every brand stylesheet. */
export function hiddenStartClasses(root) {
  const cssFiles = walk(root, 'src/brand', (rel) => /\.css$/.test(rel));
  const all = cssFiles.map((rel) => cssBlocks(stripComments(fs.readFileSync(path.join(root, rel), 'utf8'))));
  const keyframes = new Set();
  for (const blocks of all) hiddenKeyframes(blocks, keyframes);
  const out = new Map();
  const visit = (blocks) => {
    for (const b of blocks) {
      if (/^@(?:-webkit-)?keyframes/.test(b.prelude)) continue;
      if (/^@media[^{]*prefers-reduced-motion/.test(b.prelude)) continue;
      if (/^@/.test(b.prelude)) { visit(cssBlocks(b.body)); continue; }
      const d = descriptors(b.body);
      let why = null;
      if (isZero(d.opacity)) why = 'sets opacity: 0';
      else if (d.visibility && /^hidden/.test(d.visibility.trim())) why = 'sets visibility: hidden';
      else {
        const anim = `${d.animation ?? ''} ${d['animation-name'] ?? ''}`;
        const name = anim.split(/[\s,]+/).find((t) => keyframes.has(t));
        if (name) why = `animates from opacity 0 (@keyframes ${name})`;
      }
      if (!why) continue;
      for (const sel of b.prelude.split(',')) {
        if (STATE_PSEUDO.test(sel)) continue;
        const subject = sel.trim().split(/\s*[\s>+~]\s*/).pop() ?? '';
        const classes = [...subject.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
        // only a single-class subject: `.a.b` is a state of `.a` (e.g. `.reveal.in`), judged by its own declarations
        if (classes.length === 1 && !out.has(classes[0])) out.set(classes[0], why);
      }
    }
  };
  for (const blocks of all) visit(blocks);
  return out;
}

// ── fonts ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const unquote = (s) => s.trim().replace(/^['"]|['"]$/g, '').trim();
const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/** First family of a font token (e.g. --brand-font-display) declared in tokens.css, or null. The last declaration wins. */
export function firstFamily(tokensCss, token) {
  const re = new RegExp(`${token.replace(/[-]/g, '\\-')}\\s*:\\s*([^;}]+)`, 'g');
  let last = null;
  for (const m of stripComments(tokensCss).matchAll(re)) last = m[1];
  if (!last) return null;
  const first = unquote(last.split(',')[0]);
  return first && !/^var\(/.test(first) ? first : null;
}

function descriptors(body) {
  const d = {};
  for (const decl of body.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    d[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim();
  }
  return d;
}

/** Every @font-face block of a stylesheet (comments stripped), with its descriptors. */
export function fontFaces(css, file = '') {
  const text = stripComments(css);
  const out = [];
  for (const m of text.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const d = descriptors(m[1]);
    const urls = [...(d.src ?? '').matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((u) => u[2]);
    out.push({
      file,
      line: lineAt(text, m.index),
      family: d['font-family'] ? unquote(d['font-family']) : '',
      display: d['font-display']?.toLowerCase(),
      weight: (d['font-weight'] ?? '400').toLowerCase(),
      style: (d['font-style'] ?? 'normal').toLowerCase(),
      sizeAdjust: d['size-adjust'],
      urls,
    });
  }
  return out;
}

const WEIGHT_WORDS = { normal: 400, bold: 700 };
const toWeight = (w) => WEIGHT_WORDS[w] ?? (Number.isFinite(Number(w)) ? Number(w) : null);

function weightCovers(faceWeight, w) {
  const parts = faceWeight.split(/\s+/).map(toWeight);
  if (parts.some((p) => p === null)) return false;
  return parts.length === 2 ? w >= parts[0] && w <= parts[1] : parts[0] === w;
}

/** The h1 weight: the last brand rule whose selector names h1 and sets font-weight, else the base 700. */
export function h1Weight(cssTexts) {
  let weight = BASE_H1_WEIGHT;
  for (const css of cssTexts) {
    const text = stripComments(css).replace(/@font-face\s*\{[^}]*\}/g, '');
    for (const m of text.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
      if (!/(^|[\s,(>+~])h1(?![\w-])/.test(m[1])) continue;
      const fw = descriptors(m[2])['font-weight'];
      const w = fw ? toWeight(fw.replace(/!important/, '').trim().toLowerCase()) : null;
      if (w) weight = w;
    }
  }
  return weight;
}

const urlPath = (u) => u.split(/[?#]/)[0];

export function checkFonts(root) {
  const findings = [];
  const tokensRel = 'src/brand/tokens.css';
  const tokensAbs = path.join(root, tokensRel);
  if (!fs.existsSync(tokensAbs)) return findings;
  const tokens = fs.readFileSync(tokensAbs, 'utf8');
  const display = firstFamily(tokens, '--brand-font-display');
  const heading = firstFamily(tokens, '--brand-font-heading');
  const cssFiles = walk(root, 'src/brand', (rel) => /\.css$/.test(rel) && rel !== 'src/brand/license.css');
  const cssTexts = cssFiles.map((rel) => fs.readFileSync(path.join(root, rel), 'utf8'));
  const faces = cssFiles.flatMap((rel, i) => fontFaces(cssTexts[i], rel));
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();

  const families = [...new Set([display, heading].filter(Boolean).map((f) => f.toLowerCase()))].map((lc) => [display, heading].find((f) => f && f.toLowerCase() === lc));
  for (const family of families) {
    const webFaces = faces.filter((f) => same(f.family, family) && f.urls.length > 0);
    if (webFaces.length === 0) continue; // a system or unhosted family: nothing to swap
    for (const f of webFaces) {
      if (f.display !== 'swap') {
        findings.push({ file: f.file, line: f.line, col: 1, rule: 'font-display-swap', level: 'error', message: `@font-face '${family}' ${f.weight}${f.style === 'normal' ? '' : ` ${f.style}`} has font-display: ${f.display ?? '(unset)'}; the brand display/heading family must use font-display: swap` });
      }
    }
    const fallback = faces.find((f) => same(f.family, `${family} Fallback`) && f.sizeAdjust);
    if (!fallback) {
      findings.push({ file: webFaces[0].file, line: webFaces[0].line, col: 1, rule: 'font-fallback-face', level: 'error', message: `no metric fallback @font-face '${family} Fallback' with size-adjust (needed to keep the swap from shifting layout)` });
    }
  }

  if (display) {
    const targets = [...new Set([700, h1Weight(cssTexts)])];
    const hero = faces.filter((f) => same(f.family, display) && f.urls.length > 0 && f.style === 'normal' && targets.some((w) => weightCovers(f.weight, w)));
    if (hero.length > 0) {
      const headRel = 'src/brand/head.json';
      let preloads = [];
      try {
        preloads = JSON.parse(fs.readFileSync(path.join(root, headRel), 'utf8')).fontPreloads ?? [];
      } catch {
        preloads = [];
      }
      for (const f of hero) {
        const file = urlPath(f.urls.find((u) => /\.woff2$/i.test(urlPath(u))) ?? f.urls[0]);
        const p = preloads.find((x) => x && urlPath(String(x.href)) === file);
        if (!p || p.fetchpriority !== 'high') {
          findings.push({ file: headRel, line: 1, col: 1, rule: 'font-preload-high', level: 'warning', message: `display face '${display}' ${f.weight} (${file}) ${p ? 'is preloaded without fetchpriority "high"' : 'is not in fontPreloads'}; add { "href": "${file}", "type": "font/woff2", "fetchpriority": "high" }` });
        }
      }
    }
  }
  return findings;
}

export function checkBrandPerf({ root }) {
  const findings = [...checkImages(root), ...checkFonts(root)];
  return { errors: findings.filter((f) => f.level === 'error'), warnings: findings.filter((f) => f.level === 'warning') };
}

export const formatFinding = (f) => `${f.file}:${f.line}:${f.col} ${f.rule} ${f.message}`;

/** Prints the findings; returns the error count. */
export function reportBrandPerf(root, log = console) {
  const { errors, warnings } = checkBrandPerf({ root });
  for (const f of warnings) log.warn(`warning ${formatFinding(f)}`);
  for (const f of errors) log.error(formatFinding(f));
  if (errors.length > 0) log.error(`check-brand-perf: ${errors.length} error(s), ${warnings.length} warning(s)`);
  else log.log(`check-brand-perf: clean${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
  return errors.length;
}

function main() {
  const args = process.argv.slice(2);
  let root = PACKAGE_ROOT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root') root = path.resolve(args[++i]);
    else throw new Error(`unknown option ${args[i]}`);
  }
  if (reportBrandPerf(root) > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
