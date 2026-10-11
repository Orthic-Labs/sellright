// Syntax-aware half of the no-Vendure guard (see assert-no-vendure.sh).
//
// The shell guard greps for a literal gql` — which misses a tag that is wrapped:
// (gql)`…`, (0, gql)`…`, (gql as T)`…`, gql!`…`, ns.gql`…`, ns['gql']`…`. This script parses every file with the
// TypeScript compiler API and flags any tagged template whose tag expression, once parentheses / `as` / `satisfies` /
// non-null / type assertions / comma sequences are peeled, is an identifier or member named gql or graphql.
//
// Usage: node scripts/assert-no-gql-tags.mjs [--skip <dir>]... <dir-or-file>...   (exit 1 on any hit; hits printed as file:line:col)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const TAG_NAMES = new Set(['gql', 'graphql']);
const EXTS = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

/** Peel every wrapper that does not change which value is called as the tag. */
function unwrap(node) {
  for (;;) {
    if (
      ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) ||
      ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)
    ) { node = node.expression; continue; }
    // (0, gql)`…` — the comma operator yields its last operand.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) { node = node.right; continue; }
    return node;
  }
}

/** The name the tag ultimately resolves to, or null when it is not a plain name/member. */
export function tagName(tag) {
  const n = unwrap(tag);
  if (ts.isIdentifier(n)) return n.text;
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if (ts.isElementAccessExpression(n)) {
    const arg = unwrap(n.argumentExpression);
    if (ts.isStringLiteralLike(arg)) return arg.text;
  }
  return null;
}

export function findGqlTags(fileName, text) {
  const kind = /\.[jt]sx$/.test(fileName) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const hits = [];
  (function visit(node) {
    if (ts.isTaggedTemplateExpression(node)) {
      const name = tagName(node.tag);
      if (name && TAG_NAMES.has(name)) {
        const { line, character } = sf.getLineAndCharacterOfPosition(node.tag.getStart(sf));
        hits.push({ line: line + 1, col: character + 1, name });
      }
    }
    ts.forEachChild(node, visit);
  })(sf);
  return hits;
}

function* walk(p, skip = []) {
  if (skip.includes(resolve(p))) return;
  const st = statSync(p, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isFile()) { if (EXTS.test(p)) yield p; return; }
  for (const e of readdirSync(p, { withFileTypes: true })) {
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
    yield* walk(join(p, e.name), skip);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let failed = false;
  const args = process.argv.slice(2);
  const skip = [];
  const roots = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--skip') skip.push(resolve(args[++i]));
    else roots.push(args[i]);
  }
  for (const root of roots) {
    for (const f of walk(root, skip)) {
      for (const h of findGqlTags(f, readFileSync(f, 'utf8'))) {
        console.log(`${f}:${h.line}:${h.col}: tagged template with '${h.name}' tag`);
        failed = true;
      }
    }
  }
  process.exit(failed ? 1 : 0);
}
