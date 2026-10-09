// Structural CI check for the settlement chokepoint (de-fork plan 2.8; SETTLEMENT-OPS.md 7.3).
//
// Runs the TypeScript compiler API WITH a type checker over the package tsconfig (not regex,
// not ESLint). Protected tables are resolved by TYPE (the drizzle table type whose `_.name`
// literal is the SQL name), so aliases, re-exports, `import * as s`, destructuring, parameter
// passing and generics all resolve. Rules:
//   S1 direct write      insert|update|delete of a protected table outside the allowed locus
//   S2 unresolvable      a write whose table argument is not a concrete table literal (fail closed)
//   S3 Paid-capable      `order` insert/update/onConflictDoUpdate whose `state` can be 'Paid'
//   S4 raw SQL           sql`...` / .query('...') writing a protected table, or a dynamic table
//   S5 laundering        `.insert/.update/.delete` referenced but not directly called (bind, element
//                        access, destructuring) or called on an `any` receiver
//   S6 dynamic code      eval / new Function / import(non-literal) in files that import the db
//   S7 wrong kind        a literal recordSettlementOperation kind with an ineligible literal effect kind,
//                        or stripe_invoice_paid without `classification`
//   S8 allowlist drift   an allowlist entry whose site count differs, or whose fixture is missing
// Allowed locus: the body of `recordSettlementOperation` in src/payments/settlement/record.ts, plus
// the enumerated, fixture-backed entries of scripts/settlement-chokepoint.allowlist.json.
// Usage: node scripts/assert-settlement-chokepoint.mjs        (run via `pnpm assert:settlement`)
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const LOCUS = { file: 'src/payments/settlement/record.ts', symbol: 'recordSettlementOperation' };
const PROTECTED = new Set(['payment', 'order', 'subscription_invoice_payment', 'settlement_operation', 'order_pending_effect']);
const ALWAYS_PROTECTED = new Set(['payment', 'subscription_invoice_payment', 'settlement_operation', 'order_pending_effect']); // any write
const WRITE = new Set(['insert', 'update', 'delete']);
const isTest = (f) => /\.(test|spec)\.ts$/.test(f);

export function loadAllowlist(path) {
  return JSON.parse(readFileSync(path, 'utf8')).entries;
}

/** @returns {{file:string,line:number,column:number,rule:string,message:string}[]} */
export function checkSettlementChokepoint({ program, baseDir, include, allowlist = [], locus = LOCUS, fixtureRoot }) {
  const checker = program.getTypeChecker();
  const raw = [];

  // eligible effects per kind, read from OPERATION_POLICY in ops.ts (single source of truth)
  const eligible = new Map();
  const eligibleMutations = new Map();
  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.endsWith('/settlement/ops.ts')) continue;
    const walk = (n) => {
      if (ts.isVariableDeclaration(n) && n.name.getText() === 'OPERATION_POLICY') {
        let init = n.initializer;
        while (init && (ts.isAsExpression(init) || ts.isSatisfiesExpression(init))) init = init.expression;
        for (const p of init?.properties ?? []) {
          const eff = p.initializer?.properties?.find((q) => q.name?.getText() === 'effects')?.initializer;
          let arr = eff; while (arr && (ts.isAsExpression(arr) || ts.isSatisfiesExpression(arr))) arr = arr.expression;
          eligible.set(p.name.getText(), (arr?.elements ?? []).map((e) => e.text));
          const mu = p.initializer?.properties?.find((q) => q.name?.getText() === 'mutations')?.initializer;
          let marr = mu; while (marr && (ts.isAsExpression(marr) || ts.isSatisfiesExpression(marr))) marr = marr.expression;
          eligibleMutations.set(p.name.getText(), (marr?.elements ?? []).map((e) => e.text));
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || sf.fileName.includes('/node_modules/')) continue;
    const rel = relative(baseDir, sf.fileName).split('\\').join('/');
    if (include && !include(rel)) continue;
    if (isTest(rel)) continue;
    const importsDb = /from\s+['"][^'"]*(db\/client|db\/schema)[^'"]*['"]/.test(sf.text);

    const inLocus = (node) => {
      if (rel !== locus.file) return false;
      for (let p = node.parent; p; p = p.parent) {
        if (ts.isFunctionDeclaration(p) && p.name?.text === locus.symbol) return true;
      }
      return false;
    };
    const report = (node, rule, message, table = null, op = null) => {
      if (inLocus(node)) return;
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      raw.push({ file: rel, line: line + 1, column: character + 1, rule, message, table, op });
    };

    const tableOf = (expr) => {
      const t = checker.getTypeAtLocation(expr);
      if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return { kind: 'unknown' };
      const parts = t.isUnion() ? t.types : [t];
      const names = [];
      for (const part of parts) {
        const meta = part.getProperty('_');
        if (!meta) { names.push(null); continue; }
        const nameProp = checker.getTypeOfSymbolAtLocation(meta, expr).getProperty('name');
        const nt = nameProp ? checker.getTypeOfSymbolAtLocation(nameProp, expr) : null;
        names.push(nt && nt.isStringLiteral() ? nt.value : undefined);
      }
      if (names.every((n) => n === null)) return { kind: 'not-a-table' };
      if (names.some((n) => n === undefined)) return { kind: 'unknown' };
      const prot = names.filter((n) => n && PROTECTED.has(n));
      if (prot.length) return names.length > 1 ? { kind: 'unknown' } : { kind: 'table', name: prot[0] };
      return { kind: 'table', name: names[0] };
    };
    const isDbLike = (expr) => {
      const t = checker.getTypeAtLocation(expr);
      return !!(t.getProperty('execute') || t.getProperty('$client') || t.getProperty('transaction') || t.getProperty('query') && t.getProperty('release'));
    };
    const isAnyLike = (expr) => !!(checker.getTypeAtLocation(expr).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));

    const literalSet = (t) => {
      const acc = new Set();
      const walk = (x) => {
        if (x.isUnion()) return x.types.every(walk);
        if (x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) return true;
        if (x.isStringLiteral()) { acc.add(x.value); return true; }
        return false;
      };
      return walk(t) ? acc : 'unknown';
    };
    const stateValues = (type, node, depth = 0) => {
      if (depth > 6 || type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return 'unknown';
      if (type.isUnion()) {
        const acc = new Set(); let absent = false;
        for (const t of type.types) {
          if (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) continue;
          const r = stateValues(t, node, depth + 1);
          if (r === 'unknown') return 'unknown';
          if (r === 'absent') { absent = true; continue; }
          r.forEach((v) => acc.add(v));
        }
        return acc.size ? acc : absent ? 'absent' : 'unknown';
      }
      const prop = type.getProperty('state');
      if (!prop) { const el = type.getNumberIndexType(); return el ? stateValues(el, node, depth + 1) : 'absent'; }
      return literalSet(checker.getTypeOfSymbolAtLocation(prop, node));
    };
    const paidCapable = (arg) => { const r = stateValues(checker.getTypeAtLocation(arg), arg); return r === 'unknown' || (r instanceof Set && r.has('Paid')); };

    const rawText = (tpl) => ts.isNoSubstitutionTemplateLiteral(tpl) || ts.isStringLiteralLike(tpl)
      ? tpl.text : tpl.head.text + tpl.templateSpans.map((sp) => '${}' + sp.literal.text).join('');
    const inspectRaw = (text0, node) => {
      const text = text0.replace(/\s+/g, ' ');
      const verb = '(insert\\s+into|update|delete\\s+from|merge\\s+into|copy|truncate(?:\\s+table)?)';
      if (new RegExp(`\\b${verb}\\s+(only\\s+)?\\$\\{\\}`, 'i').test(text)) report(node, 'S4', 'raw SQL write with a dynamic table name');
      const re = new RegExp(`\\b${verb}\\s+(?:only\\s+)?(?:"?public"?\\.)?"?(payment|order|subscription_invoice_payment|settlement_operation|order_pending_effect)"?(?![\\w])`, 'ig');
      for (let m; (m = re.exec(text));) {
        const table = m[2];
        if (table !== 'order') { report(node, 'S4', `raw SQL write to "${table}"`, table); continue; }
        const verbText = m[1].toLowerCase();
        if (verbText !== 'update') { report(node, 'S4', 'raw SQL insert/delete/copy on "order"', table); continue; }
        const set = /^\s*(?:as\s+\w+\s+)?set\s+(.*)$/i.exec(text.slice(m.index + m[0].length));
        if (!set) { report(node, 'S4', 'raw SQL update of "order" that cannot be analysed', table); continue; }
        const clause = set[1].split(/\bwhere\b|\breturning\b|\bfrom\b/i)[0];
        const st = /(?:^|,|\s)"?state"?\s*=\s*('([^']*)'|[^,\s]+)/i.exec(clause);
        if (st && !(st[2] !== undefined && st[2] !== 'Paid')) report(node, 'S4', 'raw SQL "order" update with a state that can be Paid', table);
      }
    };

    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        // S7
        const opArg = node.arguments.find((a) => ts.isObjectLiteralExpression(a));
        if (callee.getText() === 'recordSettlementOperation' && opArg) {
          const props = opArg.properties;
          const get = (n) => props.find((p) => p.name?.getText() === n)?.initializer;
          const kindNode = get('kind');
          if (kindNode && ts.isStringLiteralLike(kindNode)) {
            const kind = kindNode.text;
            if (kind === 'stripe_invoice_paid' && !get('classification')) report(node, 'S7', 'stripe_invoice_paid without classification');
            const muts = get('mutations');
            if (muts && ts.isArrayLiteralExpression(muts)) {
              const okm = eligibleMutations.get(kind) ?? [];
              for (const m of muts.elements) {
                if (!ts.isObjectLiteralExpression(m)) continue;
                const k = m.properties.find((p) => p.name?.getText() === 'type')?.initializer;
                if (k && ts.isStringLiteralLike(k) && !okm.includes(k.text)) report(m, 'S7', `mutation "${k.text}" is not allowed for "${kind}"`);
              }
            }
            const effects = get('effects');
            const ok = eligible.get(kind) ?? [];
            if (effects && ts.isArrayLiteralExpression(effects)) {
              for (const e of effects.elements) {
                if (!ts.isObjectLiteralExpression(e)) continue;
                const k = e.properties.find((p) => p.name?.getText() === 'kind')?.initializer;
                if (k && ts.isStringLiteralLike(k) && !ok.includes(k.text)) report(e, 'S7', `effect "${k.text}" is not eligible for "${kind}"`);
              }
            }
          }
        }
        // S6
        if (importsDb) {
          if (ts.isIdentifier(callee) && callee.text === 'eval') report(node, 'S6', 'eval in a file that imports the db');
          if (callee.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && !ts.isStringLiteralLike(node.arguments[0])) report(node, 'S6', 'dynamic import() in a file that imports the db');
        }
        if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
          const name = ts.isPropertyAccessExpression(callee) ? callee.name.text
            : ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text : null;
          const recv = callee.expression;
          if (ts.isElementAccessExpression(callee) && name && WRITE.has(name) && isDbLike(recv)) report(node, 'S5', `element access "${name}" on a db`);
          if (name && WRITE.has(name) && isAnyLike(recv)) report(node, 'S5', `"${name}" called on an any/unknown receiver`);
          if (name && WRITE.has(name) && node.arguments.length >= 1 && !isAnyLike(recv)) inspectWrite(node, name, recv);
          if (name && (name === 'bind' || name === 'call' || name === 'apply') && ts.isPropertyAccessExpression(callee) && ts.isPropertyAccessExpression(recv) && WRITE.has(recv.name.text) && isDbLike(recv.expression)) report(node, 'S5', `${recv.name.text}.${name} launders the db method`);
          if ((name === 'query' || name === 'execute') && node.arguments[0]) {
            const a = node.arguments[0];
            if (ts.isStringLiteralLike(a) || ts.isTemplateExpression(a)) inspectRaw(rawText(a), node);
          }
        }
        if (ts.isIdentifier(callee) && callee.text === 'sql') { /* plain call form is not a template */ }
      }
      if (ts.isTaggedTemplateExpression(node)) {
        const tag = node.tag.getText();
        if (tag === 'sql' || tag.endsWith('.sql')) inspectRaw(rawText(node.template), node);
      }
      if (ts.isNewExpression(node) && importsDb && node.expression.getText() === 'Function') report(node, 'S6', 'new Function in a file that imports the db');
      // S5: referenced, not called
      if (ts.isPropertyAccessExpression(node) && WRITE.has(node.name.text) && isDbLike(node.expression)) {
        const p = node.parent;
        const called = ts.isCallExpression(p) && p.expression === node;
        const viaBind = ts.isPropertyAccessExpression(p) && ts.isCallExpression(p.parent) && p.parent.expression === p; // tx.insert.bind(tx) is reported at the call
        if (!called && !viaBind) report(node, 'S5', `"${node.name.text}" of a db referenced without a direct call`);
        if (viaBind) report(node, 'S5', `"${node.name.text}" of a db is bound/applied indirectly`);
      }
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const nm = (node.propertyName ?? node.name).getText();
        if (WRITE.has(nm) && node.parent.parent && (ts.isVariableDeclaration(node.parent.parent) || ts.isParameter(node.parent.parent))) {
          const init = ts.isVariableDeclaration(node.parent.parent) ? node.parent.parent.initializer : null;
          if ((init && isDbLike(init)) || ts.isParameter(node.parent.parent)) report(node, 'S5', `destructured "${nm}" from a db`);
        }
      }
      ts.forEachChild(node, visit);
    };

    function inspectWrite(call, op, recv) {
      const arg = call.arguments[0];
      const table = tableOf(arg);
      if (table.kind === 'not-a-table') return;
      if (table.kind === 'unknown') { if (isDbLike(recv)) report(call, 'S2', `${op}() on a table the checker cannot resolve to a concrete table`); return; }
      if (!PROTECTED.has(table.name)) return;
      if (ALWAYS_PROTECTED.has(table.name) || op === 'delete') { report(call, 'S1', `${op} of "${table.name}" outside recordSettlementOperation`, table.name, op); return; }
      // order insert/update: only a Paid-capable state matters
      const chain = []; // calls chained after insert()/update()
      for (let n = call; n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n && n.parent.parent && ts.isCallExpression(n.parent.parent); n = n.parent.parent) chain.push(n.parent.parent);
      const wanted = op === 'insert' ? 'values' : 'set';
      const w = chain.find((c) => c.expression.name.text === wanted);
      if (!w || !w.arguments[0]) { report(call, 'S3', `"order" ${op} whose .${wanted}(...) cannot be analysed`, 'order', op); return; }
      if (paidCapable(w.arguments[0])) report(call, 'S3', `"order" ${op} with a state that can be 'Paid'`, 'order', op);
      const upd = chain.find((c) => c.expression.name.text === 'onConflictDoUpdate');
      if (upd && upd.arguments[0] && ts.isObjectLiteralExpression(upd.arguments[0])) {
        const setProp = upd.arguments[0].properties.find((p) => p.name?.getText() === 'set');
        if (setProp?.initializer && paidCapable(setProp.initializer)) report(call, 'S3', '"order" onConflictDoUpdate set with a state that can be Paid', 'order', op);
      }
    }

    visit(sf);
  }

  // allowlist: remove violations covered by an entry; S8 on count / fixture drift
  const out = [];
  const byFile = new Map();
  for (const v of raw) { if (!byFile.has(v.file)) byFile.set(v.file, []); byFile.get(v.file).push(v); }
  const covered = new Set();
  for (const e of allowlist) {
    const sites = (byFile.get(e.file) ?? []).filter((v) => v.rule !== 'S5' && v.rule !== 'S6' && v.rule !== 'S7');
    sites.forEach((v) => covered.add(v));
    if (sites.length !== e.count) out.push({ file: e.file, line: 1, column: 1, rule: 'S8', message: `allowlist ${e.reasonId}: recorded ${e.count} site(s), found ${sites.length}` });
    const fx = resolve(fixtureRoot ?? baseDir, e.fixture);
    if (!existsSync(fx)) out.push({ file: e.file, line: 1, column: 1, rule: 'S8', message: `allowlist ${e.reasonId}: positive fixture ${e.fixture} is missing` });
  }
  for (const v of raw) if (!covered.has(v)) out.push(v);
  return out;
}

export function programFromTsconfig(tsconfigPath) {
  const cfg = ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); } });
  return { program: ts.createProgram({ rootNames: cfg.fileNames, options: { ...cfg.options, noEmit: true } }), baseDir: dirname(tsconfigPath), options: cfg.options };
}

export function formatViolations(vs) {
  return vs.map((v) => `${v.file}:${v.line}:${v.column} [${v.rule}] ${v.message}`).join('\n');
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(here, '..');
  const { program, baseDir } = programFromTsconfig(join(root, 'tsconfig.json'));
  const violations = checkSettlementChokepoint({
    program, baseDir, include: (p) => p.startsWith('src/'),
    allowlist: loadAllowlist(join(here, 'settlement-chokepoint.allowlist.json')),
  });
  if (violations.length) {
    console.error('[assert-settlement-chokepoint] FAIL — payment / Paid-order / settlement-table writes outside recordSettlementOperation:');
    console.error(formatViolations(violations));
    process.exit(1);
  }
  console.log('[assert-settlement-chokepoint] OK — no protected write outside the chokepoint (allowlist counts verified).');
}
