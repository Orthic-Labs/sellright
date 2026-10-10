#!/usr/bin/env node
// A18 token inventory. Scans src/** and public/** for CSS custom properties:
// consumers (`var(--name)`, Tailwind's `utility-(--name)`) and declarations
// (`--name:` in CSS and in strings, `@property --name`, `setProperty('--name', ...)`),
// and classifies every name:
//   global            declared in a global scope (:root, html, body, :host, @theme, @property,
//                     or set on document.documentElement) or listed in --known
//   scoped-local      declared only inside some other rule or inline style
//   tailwind-builtin  not declared here, but a Tailwind v4 default theme name (listed in the report)
//   optional-undeclared  not declared anywhere, every consumer has a var() fallback (does not fail)
//   undeclared        consumed, declared nowhere: FAILS (exit 1)
// It moves no CSS. Output is deterministic (sorted, no timestamps).
//
//   node scripts/token-inventory.mjs [--root <dir>] [--json <file>] [--report <file>] [--known <file>]
//   --known: JSON array of names (or newline separated text) declared outside the scanned tree.
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCAN_DIRS = ['src', 'public'];
const EXTS = new Set(['.css', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.html', '.svg', '.mdx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'server', '.cache', 'tmp', 'test-results']);

/** Known brand-named globals from plan A18 (reported separately). */
export const BRAND_NAMED = [
  '--color-accent',
  '--color-accent-hover',
  '--color-accent-rgb',
  '--color-card-border',
  '--color-ink',
  '--color-ink-contrast',
  '--color-ink-muted',
  '--color-ink-soft',
  '--color-parchment',
  '--color-tint',
  '--font-body',
  '--font-display',
  '--font-heading',
  '--font-mono',
];

const PALETTE = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone';
const TAILWIND_BUILTIN = [
  /^--tw-/,
  new RegExp(`^--color-(${PALETTE})-\\d{2,3}$`),
  /^--color-(black|white|transparent|current)$/,
  /^--font-(sans|serif)$/,
  /^--spacing$/,
  /^--radius-(xs|sm|md|lg|xl|2xl|3xl|4xl)$/,
  /^--(breakpoint|container|ease|animate|blur|leading|tracking|font-weight)-[\w-]+$/,
  /^--text-(xs|sm|base|lg|xl|[2-9]xl)(--line-height)?$/,
  /^--default-(font-family|mono-font-family|font-feature-settings|font-variation-settings|transition-duration|transition-timing-function)$/,
];

const CONSUMER_RES = [/var\(\s*(--[A-Za-z0-9_-]+)\s*(,)?/g, /(?<=[A-Za-z0-9\]]-)\(\s*(--[A-Za-z0-9_-]+)\s*\)/g];
const DECL_RE = /(?<![\w-])(--[A-Za-z][A-Za-z0-9_-]*)['"`]?\s*:/g;
const SETPROP_RE = /setProperty\(\s*['"`](--[A-Za-z][A-Za-z0-9_-]*)['"`]/g;
const AT_PROPERTY_RE = /@property\s+(--[A-Za-z][A-Za-z0-9_-]*)/g;

const GLOBAL_SELECTOR = /(?:^|[^\w.#-])(?::root|html|:host|body)(?:\[[^\]]*\]|\.[\w-]+|:[\w-]+)*$/;
const THEME_AT_RULE = /(?:^|\s)@theme(?:\s+[\w-]+)*$/;

function walk(root, rel, out) {
  const dir = path.join(root, rel);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    const r = `${rel}/${name}`;
    const abs = path.join(root, r);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(root, r, out);
    } else if (st.isFile() && EXTS.has(path.extname(name))) out.push(r);
  }
}

function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (idx) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** [start, end] index ranges of blocks whose selector or at-rule is global. */
function globalRanges(text) {
  const ranges = [];
  const stack = [];
  let boundary = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') {
      const prelude = text.slice(boundary, i);
      const parts = prelude.split(',').map((s) => s.trim());
      const global = parts.some((p) => GLOBAL_SELECTOR.test(p)) || THEME_AT_RULE.test(prelude.trim());
      stack.push({ start: i, global });
      boundary = i + 1;
    } else if (c === '}') {
      const top = stack.pop();
      if (top?.global) ranges.push([top.start, i]);
      boundary = i + 1;
    } else if (c === ';') boundary = i + 1;
  }
  return ranges;
}

export function scanFile(rel, text) {
  const isCss = rel.endsWith('.css');
  const body = isCss ? stripCssComments(text) : text;
  const lineOf = lineIndex(body);
  const ranges = globalRanges(body);
  const inGlobal = (idx) => ranges.some(([a, b]) => idx > a && idx < b);
  const decls = [];
  const consumers = [];
  for (const re of CONSUMER_RES) {
    for (const m of body.matchAll(re)) consumers.push({ name: m[1], file: rel, line: lineOf(m.index), fallback: m[2] === ',' });
  }
  for (const m of body.matchAll(DECL_RE)) {
    decls.push({ name: m[1], file: rel, line: lineOf(m.index), scope: inGlobal(m.index) ? 'global' : 'local', kind: isCss ? 'css' : 'inline' });
  }
  for (const m of body.matchAll(SETPROP_RE)) {
    const before = body.slice(Math.max(0, m.index - 120), m.index);
    decls.push({ name: m[1], file: rel, line: lineOf(m.index), scope: /documentElement|document\.body/.test(before) ? 'global' : 'local', kind: 'setProperty' });
  }
  for (const m of body.matchAll(AT_PROPERTY_RE)) decls.push({ name: m[1], file: rel, line: lineOf(m.index), scope: 'global', kind: 'property' });
  return { decls, consumers };
}

export function inventory({ root, known = [] }) {
  const files = [];
  for (const d of SCAN_DIRS) walk(root, d, files);
  const byName = new Map();
  const entry = (n) => {
    if (!byName.has(n)) byName.set(n, { declarations: [], consumers: [] });
    return byName.get(n);
  };
  for (const rel of files) {
    const { decls, consumers } = scanFile(rel, readFileSync(path.join(root, rel), 'utf8'));
    for (const d of decls) entry(d.name).declarations.push({ file: d.file, line: d.line, scope: d.scope, kind: d.kind });
    for (const c of consumers) entry(c.name).consumers.push({ file: c.file, line: c.line, fallback: c.fallback });
  }
  const knownSet = new Set(known);
  const tokens = {};
  for (const name of [...byName.keys()].sort()) {
    const e = byName.get(name);
    const sortLoc = (a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1);
    e.declarations.sort(sortLoc);
    e.consumers.sort(sortLoc);
    let cls;
    if (e.declarations.some((d) => d.scope === 'global') || knownSet.has(name)) cls = 'global';
    else if (e.declarations.length) cls = 'scoped-local';
    else if (TAILWIND_BUILTIN.some((re) => re.test(name))) cls = 'tailwind-builtin';
    else if (e.consumers.length && e.consumers.every((c) => c.fallback)) cls = 'optional-undeclared';
    else cls = 'undeclared';
    tokens[name] = { class: cls, external: knownSet.has(name) && !e.declarations.length, declarations: e.declarations, consumers: e.consumers, unused: e.consumers.length === 0 };
  }
  const names = Object.keys(tokens);
  const of = (c) => names.filter((n) => tokens[n].class === c);
  const brandNamed = {};
  for (const n of BRAND_NAMED) brandNamed[n] = tokens[n] ? tokens[n].class : 'absent';
  return {
    version: 1,
    scanned: files.length,
    summary: {
      names: names.length,
      global: of('global').length,
      scopedLocal: of('scoped-local').length,
      tailwindBuiltin: of('tailwind-builtin').length,
      optionalUndeclared: of('optional-undeclared').length,
      undeclared: of('undeclared').length,
    },
    undeclared: of('undeclared'),
    brandNamed,
    tokens,
  };
}

export function renderReport(inv) {
  const L = [];
  const s = inv.summary;
  L.push('# Token inventory', '');
  L.push(`Scanned ${inv.scanned} files under ${SCAN_DIRS.map((d) => `${d}/`).join(' and ')}.`, '');
  L.push('| class | names |', '|---|---|');
  L.push(`| global | ${s.global} |`, `| scoped-local | ${s.scopedLocal} |`, `| tailwind-builtin | ${s.tailwindBuiltin} |`, `| optional-undeclared | ${s.optionalUndeclared} |`, `| undeclared (fails) | ${s.undeclared} |`, '');
  const first = (t) => `${t.file}:${t.line}`;
  L.push('## Undeclared', '');
  if (!inv.undeclared.length) L.push('None.', '');
  for (const n of inv.undeclared) L.push(`- \`${n}\`: ${inv.tokens[n].consumers.slice(0, 5).map(first).join(', ')}${inv.tokens[n].consumers.length > 5 ? ', ...' : ''}`);
  if (inv.undeclared.length) L.push('');
  L.push('## Global tokens', '', '| name | declared at | consumers |', '|---|---|---|');
  for (const [n, t] of Object.entries(inv.tokens)) {
    if (t.class !== 'global') continue;
    L.push(`| \`${n}\` | ${t.external ? '(external, --known)' : t.declarations.filter((d) => d.scope === 'global').map(first).join(', ')} | ${t.consumers.length} |`);
  }
  L.push('', '## Brand-named globals (plan A18 list)', '', '| name | class |', '|---|---|');
  for (const [n, c] of Object.entries(inv.brandNamed)) L.push(`| \`${n}\` | ${c} |`);
  const section = (title, cls, detail) => {
    const list = Object.entries(inv.tokens).filter(([, t]) => t.class === cls);
    L.push('', `## ${title}`, '');
    if (!list.length) L.push('None.');
    for (const [n, t] of list) L.push(`- \`${n}\`${detail(t)}`);
  };
  section('Scoped-local tokens', 'scoped-local', (t) => ` (${t.declarations.map(first).join(', ')})`);
  section('Tailwind built-ins consumed', 'tailwind-builtin', (t) => ` (${t.consumers.length} consumer(s))`);
  section('Optional (undeclared, always with a fallback)', 'optional-undeclared', (t) => ` (${t.consumers.map(first).join(', ')})`);
  const unused = Object.entries(inv.tokens).filter(([, t]) => t.unused && t.class !== 'tailwind-builtin');
  L.push('', '## Declared and never consumed', '');
  if (!unused.length) L.push('None.');
  for (const [n] of unused) L.push(`- \`${n}\``);
  return `${L.join('\n')}\n`;
}

function readKnown(file) {
  const text = readFileSync(file, 'utf8');
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j)) return j.map(String);
  } catch {
    /* plain text list */
  }
  return text.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('--'));
}

export function main(argv, out = (s) => process.stdout.write(s)) {
  const v = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--root', '--json', '--report', '--known'].includes(argv[i]) || argv[i + 1] === undefined) {
      out('usage: token-inventory.mjs [--root <dir>] [--json <file>] [--report <file>] [--known <file>]\n');
      return 2;
    }
    v.set(argv[i], argv[i + 1]);
  }
  const root = path.resolve(v.get('--root') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const inv = inventory({ root, known: v.has('--known') ? readKnown(v.get('--known')) : [] });
  if (v.has('--json')) writeFileSync(v.get('--json'), `${JSON.stringify(inv, null, 2)}\n`);
  if (v.has('--report')) writeFileSync(v.get('--report'), renderReport(inv));
  const s = inv.summary;
  out(`token inventory: ${s.names} names (${s.global} global, ${s.scopedLocal} scoped-local, ${s.tailwindBuiltin} tailwind-builtin, ${s.optionalUndeclared} optional-undeclared, ${s.undeclared} undeclared) in ${inv.scanned} files\n`);
  for (const n of inv.undeclared) out(`undeclared: ${n} (${inv.tokens[n].consumers.slice(0, 3).map((c) => `${c.file}:${c.line}`).join(', ')})\n`);
  return s.undeclared > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
