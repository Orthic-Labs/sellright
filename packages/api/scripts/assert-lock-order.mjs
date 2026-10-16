// Static lock-order audit (STOREKIT.md §5.7 A; de-fork plan 3.3/3.4 step 1).
//
// Syntactic TypeScript-AST scan (no type checker). Lock sites:
//   - `.for('update')`                                  row lock, class from the table in the statement
//   - `tx.update|delete|insert(s.<table>)`               row lock on order/license/licenseActivation/orderReservation
//   - raw SQL `UPDATE|DELETE FROM|INSERT INTO <table>`  same tables, from string/template text
//   - `withAdvisoryLock(key)`                           L0 session advisory (gateway-event < pay < refund)
//   - `pg_advisory_xact_lock(`                          xact advisory (L5 leaf/loyalty)
//   - `withLockedSet(...)`                              the sanctioned plan→lock→verify entry (acquires L2/L3/L4)
// Classes: L0 (rank 0; gateway-event 0, pay 0.1, refund 0.2), L2 license, L3 order, L4 order_reservation,
// L5 leaf (license_activation, payment_attempt, payment, xact advisories). Rank order = class order.
// Rules (per named function):
//   O2 order      a site acquires a lower rank than a site already seen in that function (outside a set).
//   M1 mixed      the function takes an order-class lock (L3/L4) AND a licence lock (L2) without
//                 withLockedSet in its body, and is not allow-listed.
//   S8 drift      an allow-list entry whose recorded class sequence no longer matches, or that is no
//                 longer mixed/ordering-violating (the list may only shrink). Fails closed.
// Limits (documented, not hidden): syntactic only, so an aliased table (`const T = s.order`) is not
// classified; textual order approximates acquisition order; the call graph is not followed (a function
// that calls a mixed helper is not itself flagged). The runtime LockOrderRecorder is the complement.
// Usage: node scripts/assert-lock-order.mjs            (run via `pnpm assert:locks`)
//        node scripts/assert-lock-order.mjs --seed    (print allow-list entries for current mixed/violating fns)
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const LOCK_TABLE_CLASS = {
  order: 'L3',
  license: 'L2',
  orderReservation: 'L4',
  order_reservation: 'L4',
  licenseActivation: 'L5',
  license_activation: 'L5',
  payment_attempt: 'L5',
  paymentAttempt: 'L5',
  paymentAttemptRow: 'L5',
};
const WRITE_TABLES = new Set(['order', 'license', 'licenseActivation', 'orderReservation']);
const RANK = { L0: 0, L2: 2, L3: 3, L4: 4, L5: 5 };
const L0_RANK = { 'gateway-event': 0, pay: 0.1, refund: 0.2 };

function unwrap(n) {
  while (n && (ts.isAsExpression(n) || ts.isParenthesizedExpression(n) || ts.isSatisfiesExpression(n))) n = n.expression;
  return n;
}

function literalText(n) {
  n = unwrap(n);
  if (!n) return null;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text;
  return null;
}

function tableFromText(text) {
  const m = /\bs\.(\w+)/.exec(text) ?? /\b(?:FROM|UPDATE|INTO)\s+"?(\w+)"?/i.exec(text);
  return m ? m[1] : null;
}

// FOR UPDATE on a table outside the ladder (customer, gift_card, ...) is not a ladder class (null).
// cart is outside L1–L4 but must not precede a licence/order lock (STOREKIT §5.1 exempt row): class L5.
// An unidentifiable target is fail-closed: L5.
function classForForUpdate(t) {
  if (t === null) return 'L5';
  if (LOCK_TABLE_CLASS[t]) return LOCK_TABLE_CLASS[t];
  if (t === 'cart') return 'L5';
  return null;
}

function nameOf(node) {
  if (!node) return null;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return null;
}

/** Collect lock sites + managed-set spans + named functions for one source file. */
export function scanFile(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sites = []; // {fn, cls, rank, pos, kind, detail}
  const sets = []; // {fn, start, end}
  const fnNameStack = [];

  const currentFn = () => fnNameStack[fnNameStack.length - 1] ?? '<module>';

  const pushSite = (cls, rank, node, kind, detail) =>
    sites.push({ fn: currentFn(), cls, rank, pos: node.getStart(sf), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, kind, detail });

  const stmtText = (node) => {
    let n = node;
    while (n.parent && !ts.isExpressionStatement(n) && !ts.isReturnStatement(n) && !ts.isVariableStatement(n) && !ts.isSourceFile(n)) n = n.parent;
    return n.getText(sf);
  };

  const visit = (node) => {
    let pushed = false;
    if (ts.isFunctionDeclaration(node) && node.name) { fnNameStack.push(node.name.text); pushed = true; }
    else if (ts.isMethodDeclaration(node) && node.name) { fnNameStack.push(node.name.getText(sf)); pushed = true; }
    else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent) {
      const p = node.parent;
      let nm = ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) ? p.name.text
        : ts.isPropertyAssignment(p) ? p.name.getText(sf) : null;
      // Anonymous handler passed to a call (e.g. app.post('/x', async (c) => ...)) at module level:
      // name it by callee + first string argument so each route is its own path. Nested callbacks
      // (transaction bodies) inherit the enclosing named function.
      if (!nm && ts.isCallExpression(p) && fnNameStack.length === 0) {
        const first = literalText(p.arguments[0]);
        nm = `${p.expression.getText(sf)}(${first ?? `@${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`})`;
      }
      if (nm) { fnNameStack.push(nm); pushed = true; }
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const cname = nameOf(callee);
      if (cname === 'withLockedSet') {
        sets.push({ fn: currentFn(), start: node.getStart(sf), end: node.getEnd() });
        pushSite('L2', RANK.L2, node, 'set', 'withLockedSet');
      } else if (cname === 'withAdvisoryLock') {
        const key = literalText(node.arguments[0]);
        const pre = key ? Object.keys(L0_RANK).find((p) => key === p || key.startsWith(p + ':') || key.startsWith(p + '-')) : undefined;
        if (pre) pushSite('L0', L0_RANK[pre], node, 'advisory', pre);
        else pushSite('A', null, node, 'advisory', key ?? '<dynamic>'); // disjoint key class (migration, telemetry, blog): counted, not ordered
      } else if (cname === 'pg_advisory_xact_lock' || cname === 'lockCustomerLoyalty') {
        pushSite('L5', RANK.L5, node, 'advisory', cname);
      } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'for' && node.arguments.length === 1 && literalText(node.arguments[0]) === 'update') {
        const t = tableFromText(stmtText(node));
        const cls = classForForUpdate(t);
        if (cls) pushSite(cls, RANK[cls], node, 'for-update', t ?? '<unknown>');
      } else if (ts.isPropertyAccessExpression(callee) && ['update', 'delete', 'insert'].includes(callee.name.text) && node.arguments.length >= 1) {
        const arg = unwrap(node.arguments[0]);
        if (ts.isPropertyAccessExpression(arg) && WRITE_TABLES.has(arg.name.text)) {
          const cls = LOCK_TABLE_CLASS[arg.name.text];
          pushSite(cls, RANK[cls], node, `write-${callee.name.text}`, arg.name.text);
        }
      }
    } else if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) || ts.isStringLiteral(node)) {
      const text = node.getText(sf); // full text incl. ${} parts, so SQL split across substitutions is seen
      if (/\bpg_advisory_xact_lock\(/i.test(text)) pushSite('L5', RANK.L5, node, 'advisory', 'pg_advisory_xact_lock');
      const m = /\b(UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+"?(order|license|license_activation|order_reservation)"?\b/i.exec(text);
      if (m) {
        const t = m[2].toLowerCase();
        const cls = LOCK_TABLE_CLASS[t];
        pushSite(cls, RANK[cls], node, 'raw-write', t);
      }
      if (/\bFOR\s+UPDATE\b/i.test(text) && !m) {
        const t = tableFromText(text);
        const cls = classForForUpdate(t);
        if (cls) pushSite(cls, RANK[cls], node, 'raw-for-update', t ?? '<unknown>');
      }
    }

    ts.forEachChild(node, visit);
    if (pushed) fnNameStack.pop();
  };
  visit(sf);

  // Named function for each set span is its enclosing function; sites inside a set span are set-managed.
  return { file, sites, sets };
}

/** Group, classify, and check. Returns {violations, groups} where groups are all mixed/violating functions. */
export function analyze(scans) {
  const byFn = new Map();
  for (const { file, sites, sets } of scans) {
    for (const site of sites) {
      const key = `${file}::${site.fn}`;
      if (!byFn.has(key)) byFn.set(key, { key, file, fn: site.fn, sites: [], sets: [] });
      byFn.get(key).sites.push(site);
    }
    for (const set of sets) {
      const key = `${file}::${set.fn}`;
      if (!byFn.has(key)) byFn.set(key, { key, file, fn: set.fn, sites: [], sets: [] });
      byFn.get(key).sets.push(set);
    }
  }
  const violations = [];
  const groups = [];
  for (const g of byFn.values()) {
    const ordered = g.sites.filter((s) => s.cls !== 'A' && s.rank !== null).sort((a, b) => a.pos - b.pos);
    const inSet = (s) => g.sets.some((st) => s.pos >= st.start && s.pos <= st.end && s.kind !== 'set');
    const managed = g.sets.length > 0;
    const classes = ordered.map((s) => (s.kind === 'set' ? 'SET' : s.cls + (s.cls === 'L0' ? `:${s.detail}` : `:${s.detail}`)));
    const sequence = classes.join(' ');
    const hasOrder = ordered.some((s) => s.cls === 'L3' || s.cls === 'L4');
    const hasLicence = ordered.some((s) => s.cls === 'L2' || s.kind === 'set');
    const mixed = hasOrder && hasLicence && !managed;
    // O2: textual acquisition order (sites inside a set callback are skipped; the set orders itself)
    const o2 = [];
    let maxRank = -1;
    let maxSite = null;
    for (const s of ordered) {
      if (inSet(s)) continue;
      if (s.kind === 'set') { /* handled as rank L2 below */ }
      if (maxRank > s.rank) o2.push(s);
      if (s.rank > maxRank) { maxRank = s.rank; maxSite = s; }
    }
    // Pre-set sites with rank above L2 that precede a set are violations too (set acquires L2–L4).
    const orderViolation = o2.length > 0;
    const info = { key: g.key, file: g.file, fn: g.fn, mixed, orderViolation, sequence, lines: ordered.map((s) => s.line) };
    if (mixed || orderViolation) groups.push(info);
    if (orderViolation) {
      for (const s of o2) violations.push({ file: g.file, line: s.line, rule: 'O2', fn: g.fn, message: `${s.cls}(${s.detail}) acquired after a higher class in ${g.fn}` });
    }
    void maxSite;
  }
  return { violations, groups };
}

/** Apply the allow-list: exempt listed functions from M1/O2 and report stale (S8) entries. */
export function applyAllowlist(result, allowlist) {
  const out = [];
  const byKey = new Map(allowlist.map((e) => [e.key, e]));
  const seen = new Set();
  for (const v of result.violations) {
    const e = byKey.get(`${v.file}::${v.fn}`);
    if (e) { seen.add(e.key); continue; }
    out.push(v);
  }
  for (const g of result.groups) {
    const e = byKey.get(g.key);
    if (e) {
      seen.add(g.key);
      if (e.sequence !== g.sequence) out.push({ file: g.file, line: 0, rule: 'S8', fn: g.fn, message: `allow-list sequence drift: recorded "${e.sequence}" now "${g.sequence}"` });
      continue;
    }
    if (g.mixed) out.push({ file: g.file, line: g.lines[0] ?? 0, rule: 'M1', fn: g.fn, message: `mixed order+licence path not under withLockedSet and not allow-listed: ${g.sequence}` });
    if (g.orderViolation) out.push({ file: g.file, line: g.lines[0] ?? 0, rule: 'O2', fn: g.fn, message: `lock order violation (not allow-listed): ${g.sequence}` });
  }
  for (const e of allowlist) {
    if (!seen.has(e.key)) out.push({ file: e.key.split('::')[0], line: 0, rule: 'S8', fn: e.key, message: 'allow-list entry is stale (no longer mixed or ordering-violating); remove it' });
  }
  return out;
}

export function formatViolations(vs) {
  return vs.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.fn}: ${v.message}`).join('\n');
}

export function loadAllowlist(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).entries : [];
}

export function listSourceFiles(dir, skip = () => false) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listSourceFiles(p, skip));
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts') && !/\.test\.ts$/.test(p) && !skip(p)) out.push(p);
  }
  return out.sort();
}

const here = dirname(fileURLToPath(import.meta.url));
const API = resolve(here, '..');
// Allowed sites: the helper itself, and the advisory primitive in db/client.ts.
const EXEMPT = (p) => /[\\/]src[\\/]db[\\/](locks|client)\.ts$/.test(p);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = listSourceFiles(join(API, 'src'), EXEMPT);
  const scans = files.map((f) => scanFile(relative(API, f).split(sep).join('/'), readFileSync(f, 'utf8')));
  const result = analyze(scans);
  if (process.argv.includes('--seed')) {
    const entries = result.groups
      .filter((g) => g.mixed || g.orderViolation)
      .map((g) => ({ key: g.key, sequence: g.sequence, mixed: g.mixed, orderViolation: g.orderViolation, why: 'pre-migration: not yet under withLockedSet (STOREKIT §5.4/§5.8)' }));
    process.stdout.write(JSON.stringify({ entries }, null, 2) + '\n');
    process.exit(0);
  }
  const allow = loadAllowlist(join(here, 'lock-audit.allowlist.json'));
  const vs = applyAllowlist(result, allow);
  if (vs.length) { console.error(formatViolations(vs)); process.exit(1); }
  console.log(`lock-order audit: ok (${files.length} files, ${result.groups.length} mixed/ordering groups, ${allow.length} allow-listed)`);
}
