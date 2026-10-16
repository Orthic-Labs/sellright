// Brand views, plan §2.7 "Fallback proof": the SSR output of the same pages is captured on main and on the branch
// (e2e/ssr-fallback-capture.spec.ts, E2E_FALLBACK_OUT) and compared on what a browser renders: every element, attribute and text node.
// Only Qwik runtime bookkeeping is normalised (handler refs, vnode/state data, per-render ids, chunk and manifest names, nonces);
// anything else that differs is a real difference. The comparison is tied to the inventory in e2e/support/ssr-pages.json: every listed
// page must exist on both sides with its expected status and marker, nothing else may be present, and an empty inventory, an empty
// directory or a page that is not what it should be fails the run.
//
// One kind of documented difference is supported beyond ignoreAttrs/ignorePreloads: `expectedDifference: { reason, afterOnlyMarker }` on a
// page whose main build lacks a control the branch renders (a fix, not a regression). The before side may lack the marker; the after
// side must have it; when the before side lacks it, only that one marked element is removed from the after side and everything else is
// compared strictly. When the before side has the marker too, the page is compared in full like any other.
//
//   node scripts/ssr-normalize.mjs <dirBefore> <dirAfter> [--inventory FILE]
//       Exit 0 only when every inventory page matches on both sides. Exit 1 on any problem, 2 on bad usage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_INVENTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'e2e', 'support', 'ssr-pages.json');

/** Attribute names that are Qwik bookkeeping, not rendered output. */
const BOOKKEEPING_ATTR = /^(q:|q-[a-z]:|:$|:=|preventdefault:)/;

/**
 * Normalises one HTML document for comparison. Strict on elements, attributes and text: the tag/attribute pass only drops
 * bookkeeping attributes and sorts the rest. `ignoreAttrs` ([{ tag, attr }]) drops a documented, expected attribute difference; `ignorePreloads` drops the modulepreload links.
 */
export function normalizeHtml(html, ignoreAttrs = [], ignorePreloads = false) {
  const ignored = new Map();
  for (const { tag, attr } of ignoreAttrs) ignored.set(tag.toLowerCase(), [...(ignored.get(tag.toLowerCase()) ?? []), attr]);
  const out = html
    .replace(/,0,"[a-z0-9]{6}"\)/g, ',0,"I")')
    .replace(/<script q:func="qwik\/json"[\s\S]*?<\/script>/g, '<QFUNCS>')
    .replace(/<script type="qwik\/(state|vnode)"[\s\S]*?<\/script>/g, '<$1>')
    .replace(/bundle-graph-[A-Za-z0-9_-]+\.json/g, 'bg.json')
    .replace(/\bq-[A-Za-z0-9_-]{8}\.js\b/g, 'q-C.js')
    .replace(/(nonce=)"[^"]*"/g, '$1"N"')
    .replace(/<([a-zA-Z][\w-]*)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*(\/?)>/g, (_m, tag, attrs, selfClose) => {
      const drop = ignored.get(tag.toLowerCase()) ?? [];
      const list = (attrs.match(/[^\s=>]+(?:="[^"]*")?/g) || []).filter((a) => !BOOKKEEPING_ATTR.test(a) && !drop.includes(a.split('=')[0]));
      list.sort();
      return `<${tag}${list.length ? ` ${list.join(' ')}` : ''}${selfClose}>`;
    });
  // A documented per-page difference: the set of preloaded chunks (a page that imports one more module preloads one more chunk).
  return ignorePreloads ? out.replace(/<link [^>]*rel="modulepreload"[^>]*>/g, '') : out;
}

/** A capture file: `status: N`, `content-type: ...`, a blank line, then the body. */
export function parseCapture(text) {
  const m = /^status: (\d+)\ncontent-type: ([^\n]*)\n\n([\s\S]*)$/.exec(text);
  return m ? { status: Number(m[1]), contentType: m[2], body: m[3] } : null;
}

export function loadInventory(file = DEFAULT_INVENTORY) {
  const inv = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(inv.pages) || inv.pages.length === 0) throw new Error(`${file}: the capture inventory is empty`);
  return inv.pages;
}

function readSide(dir, label, page, problems) {
  const file = path.join(dir, `${page.name}.txt`);
  if (!fs.existsSync(file)) { problems.push(`${page.name}: missing on the ${label} side (${file})`); return null; }
  const cap = parseCapture(fs.readFileSync(file, 'utf8'));
  if (!cap) { problems.push(`${page.name}: ${label} capture is not in the capture format`); return null; }
  if (cap.status !== page.status) problems.push(`${page.name}: ${label} status is ${cap.status}, expected ${page.status}`);
  if (cap.body.trim() === '' && !page.allowEmptyBody) problems.push(`${page.name}: ${label} body is empty`);
  const optionalHere = label === 'before' && page.expectedDifference?.afterOnlyMarker;
  if (page.marker && !optionalHere && !cap.body.includes(page.marker)) problems.push(`${page.name}: ${label} body does not contain the marker ${JSON.stringify(page.marker)}`);
  return cap;
}

/**
 * `html` without the one element that carries `marker` (its start tag through its matching end tag, nesting of the same tag counted),
 * or null when the marker is missing or the element is not closed.
 */
export function stripMarkedElement(html, marker) {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const open = html.lastIndexOf('<', at);
  const tag = /^<([a-zA-Z][\w-]*)/.exec(html.slice(open))?.[1];
  if (!tag) return null;
  const re = new RegExp(`<(/?)${tag}(?=[\\s>/])[^>]*>`, 'g');
  re.lastIndex = open;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1] === '') { if (!m[0].endsWith('/>')) depth++; else if (depth === 0) return html.slice(0, open) + html.slice(m.index + m[0].length); } else depth--;
    if (depth === 0) return html.slice(0, open) + html.slice(m.index + m[0].length);
  }
  return null;
}

/**
 * Compares two capture directories against the inventory. Returns { problems, same, different } where `problems` lists everything
 * that makes the comparison invalid or the pages different (empty = proven identical on rendered markup).
 */
export function compareCaptures(dirA, dirB, pages) {
  const problems = [];
  let same = 0;
  let different = 0;
  let expected = 0; // pages compared with their documented expectedDifference applied
  if (!Array.isArray(pages) || pages.length === 0) return { problems: ['the capture inventory is empty'], same, different, expected };
  for (const [label, dir] of [['before', dirA], ['after', dirB]]) {
    if (!fs.existsSync(dir)) { problems.push(`${label} directory ${dir} does not exist`); continue; }
    const expected = new Set(pages.map((p) => `${p.name}.txt`));
    for (const f of fs.readdirSync(dir)) if (!expected.has(f)) problems.push(`${label}: ${f} is not in the inventory`);
  }
  if (problems.length > 0) return { problems, same, different, expected };
  for (const page of pages) {
    const before = readSide(dirA, 'before', page, problems);
    const after = readSide(dirB, 'after', page, problems);
    if (!before || !after) continue;
    if (before.contentType !== after.contentType) { problems.push(`${page.name}: content-type differs (${before.contentType} vs ${after.contentType})`); different++; continue; }
    let beforeBody = before.body;
    let afterBody = after.body;
    const ed = page.expectedDifference;
    if (ed && !beforeBody.includes(ed.afterOnlyMarker)) {
      if (!afterBody.includes(ed.afterOnlyMarker)) { problems.push(`${page.name}: the after side lacks the expected-difference marker ${JSON.stringify(ed.afterOnlyMarker)}`); different++; continue; }
      const stripped = stripMarkedElement(afterBody, ed.afterOnlyMarker);
      if (stripped === null) { problems.push(`${page.name}: the element marked ${JSON.stringify(ed.afterOnlyMarker)} could not be isolated on the after side`); different++; continue; }
      afterBody = stripped;
      expected++;
    }
    const a = normalizeHtml(beforeBody, page.ignoreAttrs, page.ignorePreloads);
    const b = normalizeHtml(afterBody, page.ignoreAttrs, page.ignorePreloads);
    if (a === b) { same++; continue; }
    different++;
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    const cut = (s) => s.slice(Math.max(0, i - 160), i + 240).replace(/\n/g, ' ');
    problems.push(`${page.name}: rendered markup differs\n    before: ${cut(a)}\n    after:  ${cut(b)}`);
  }
  return { problems, same, different, expected };
}

function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--inventory');
  const inventoryFile = at >= 0 ? args.splice(at, 2)[1] : DEFAULT_INVENTORY;
  const [a, b] = args;
  if (!a || !b || args.length !== 2) { console.error('usage: ssr-normalize.mjs <dirBefore> <dirAfter> [--inventory FILE]'); process.exit(2); }
  let pages;
  try { pages = loadInventory(inventoryFile); } catch (e) { console.error(`ssr-normalize: ${e.message}`); process.exit(1); }
  const { problems, same, different, expected } = compareCaptures(a, b, pages);
  if (problems.length > 0) {
    console.error(`ssr-normalize: ${problems.length} problem(s) (${same} identical, ${different} different of ${pages.length} pages):\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`ssr-normalize: all ${same} inventory pages are identical on rendered markup${expected > 0 ? ` (${expected} with its documented expected difference removed)` : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
