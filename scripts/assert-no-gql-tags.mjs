// Syntax-aware half of the no-Vendure guard (see assert-no-vendure.sh).
//
// The shell guard greps for a literal gql` — which misses a tag that is wrapped:
// (gql)`…`, (0, gql)`…`, (gql as T)`…`, gql!`…`, ns.gql`…`, ns['gql']`…`. This script parses every file with the
// TypeScript compiler API and flags any tagged template whose tag expression, once parentheses / `as` / `satisfies` /
// non-null / type assertions / comma sequences are peeled, is an identifier or member named gql or graphql.
//
// Known gaps (a syntactic check cannot follow values): an aliased tag (`const q = gql; q\`...\``), a renamed import
// (`import { gql as g }` then g\`...\``), and a tag obtained from a call or a computed key. The grep pass for the
// `@vendure` / `graphql` words still catches the usual import that would introduce such a tag.
//
// Exit codes: 0 clean, 1 hits found (printed on stdout), 2 usage error or unreadable file. The shell guard treats any
// non-zero exit with no hit lines as a scanner failure, so an uncaught crash (also exit 1 in node) cannot pass.
// Usage: node scripts/assert-no-gql-tags.mjs [--words] [--skip <dir>]... <dir-or-file>...
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const TAG_NAMES = new Set(['gql', 'graphql']);
const EXTS = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

// Exact compatibility syntax at reviewed migration boundaries. Identifiers are parsed as whole JS tokens
// (including $, Unicode ID_Continue, ZWNJ & ZWJ); strings/template fragments must match complete values.
// These exceptions never affect the independent hard-coupling checks over original source.
const CART_SUMMARY = 'Adopt a frozen Vendure cart or reconcile a browser snapshot once';
const COMPATIBILITY = {
  'packages/api/src/auth/cookies.ts': {
    identifiers: ['__vendure_session'], strings: ['x-vendure-session-token'],
    comments: [
      '/** Vendure carriers are untrusted transport, consumed only by migration bootstrap. */',
      '/** Preserve original signed HttpOnly Vendure cookie throughout rollback window. */',
    ],
  },
  'packages/api/src/auth/legacy-cookies.test.ts': {
    strings: ['__vendure_session'], templates: ['__vendure_session=', 'authToken=opaque_456; __vendure_session='],
  },
  'packages/api/src/routes/disputes-nmi.db.test.ts': { identifiers: ['vendure', 'vendureMethod'] },
  'packages/api/src/routes/cart.ts': {
    strings: [CART_SUMMARY], templates: ["->>'vendureId' = ", 'vendure-unresolved:'],
  },
  'packages/api/src/routes/gateway-payments.webhook.test.ts': {
    identifiers: ['vendure', 'vendureMethod'], strings: ['vendure:damned'],
  },
  'packages/api/src/routes/legacy-session-cart.db.test.ts': {
    identifiers: ['vendureId'], strings: ['vendure:test', '__vendure_session=', 'vendure-unresolved:999'],
    templates: ['__vendure_session='],
  },
  'packages/api/src/payments/sezzle-reconcile.test.ts': {
    identifiers: ['vendure', 'vendureMethod'], strings: ['vendure:damned', 'vendure:other'],
  },
  'packages/api/src/payments/sezzle-reconcile.ts': { identifiers: ['vendure', 'vendureMethod'] },
  'packages/storefront-client/src/generated/schema.d.ts': { comments: [`/** ${CART_SUMMARY} */`] },
  'packages/storefront-client/dist/generated/schema.d.ts': { comments: [`/** ${CART_SUMMARY} */`] },
  'packages/storefront/src/services/CartService.test.ts': { strings: ['vendure_local_cart'] },
  'packages/storefront/src/services/legacy-cart.test.ts': { strings: ['vendure_local_cart'] },
  'packages/storefront/src/services/CartService.ts': { strings: ['vendure_local_cart'] },
  'packages/storefront/src/services/CountryPreferenceService.ts': { strings: ['vendure_local_cart'] },
  'packages/storefront/src/providers/shop/account/bootstrap.test.ts': { strings: ['__vendure_session='] },
  'packages/storefront/src/routes/account/layout.tsx': { strings: ['__vendure_session'] },
  'packages/storefront/src/routes/layout.tsx': { strings: ['__vendure_session'] },
};

function requireParsedSource(sf) {
  const diagnostic = sf.parseDiagnostics[0];
  if (!diagnostic) return;
  const { line, character } = sf.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
  throw new Error(`Cannot parse ${sf.fileName}:${line + 1}:${character + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
}

/** Bare-word findings after removing only exact declared syntax, retaining original source positions. */
export function findUnexpectedVendureMentions(fileName, text) {
  const rel = fileName.replaceAll('\\', '/').replace(/^\.\//, '');
  const allowed = COMPATIBILITY[rel] ?? {};
  const kind = /\.[jt]sx$/.test(rel) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(rel) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
  requireParsedSource(sf);
  const remaining = text.split('');
  const erase = (start, end) => {
    for (let i = start; i < end; i++) if (remaining[i] !== '\n' && remaining[i] !== '\r') remaining[i] = ' ';
  };
  (function visit(node) {
    if (ts.isIdentifier(node) && allowed.identifiers?.includes(node.text)) erase(node.getStart(sf), node.end);
    else if (ts.isStringLiteralLike(node) && allowed.strings?.includes(node.text)) erase(node.getStart(sf), node.end);
    else if ([ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail].includes(node.kind) &&
      allowed.templates?.includes(node.text)) erase(node.getStart(sf), node.end);
    for (const comment of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) {
      if (allowed.comments?.includes(text.slice(comment.pos, comment.end))) erase(comment.pos, comment.end);
    }
    ts.forEachChild(node, visit);
  })(sf);
  return [...remaining.join('').matchAll(/vendure/gi)].map((match) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(match.index);
    return { line: line + 1, col: character + 1 };
  });
}

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
  requireParsedSource(sf);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let failed = false;
  const args = process.argv.slice(2);
  const skip = [];
  const roots = [];
  let words = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--words') words = true;
    else if (args[i] === '--skip') skip.push(resolve(args[++i]));
    else roots.push(args[i]);
  }
  if (roots.length === 0) { console.error('assert-no-gql-tags: no path given'); process.exit(2); }
  for (const root of roots) {
    if (!statSync(root, { throwIfNoEntry: false })) { console.error(`assert-no-gql-tags: missing path ${root}`); process.exit(2); }
    for (const f of walk(root, skip)) {
      const text = readFileSync(f, 'utf8');
      for (const h of words ? findUnexpectedVendureMentions(f, text) : findGqlTags(f, text)) {
        console.log(`${f}:${h.line}:${h.col}: ${words ? "unexpected 'vendure' mention" : `tagged template with '${h.name}' tag`}`);
        failed = true;
      }
    }
  }
  process.exit(failed ? 1 : 0);
}
