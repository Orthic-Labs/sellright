/**
 * SR-CLIENT-1: keeps `SHOP_API_ERROR_CODES` (registered as the `ApiErrorCode`
 * OpenAPI components schema in app.ts) honest against every literal code an
 * `errJson(...)` call site in `routes/` actually passes. Two directions:
 *  - a route using a code NOT in the list would silently fall out of the
 *    generated client's `ApiErrorCode` union (client can't narrow on it);
 *  - a listed code no route uses anymore is dead documentation.
 * Only literal string codes are checked (`errJson(c, 404, 'FOO', ...)`) —
 * a dynamic/templated code (none exist today) can't be statically verified
 * and is intentionally ignored rather than failing the build.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { SHOP_API_ERROR_CODES } from './api-error.js';

const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'routes');

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) return [];
    return [path];
  });
}

/** Literal string codes passed as `errJson`'s 3rd argument across every route file. */
function literalErrJsonCodes(): Set<string> {
  const found = new Set<string>();
  for (const path of routeFiles(ROUTES_DIR)) {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'errJson' &&
        node.arguments[2] &&
        ts.isStringLiteralLike(node.arguments[2])
      ) {
        found.add(node.arguments[2].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

describe('ApiErrorCode components schema stays in sync with errJson call sites', () => {
  it('lists every literal code a shop-facing route passes to errJson', () => {
    const used = literalErrJsonCodes();
    const declared = new Set<string>(SHOP_API_ERROR_CODES);
    const missing = [...used].filter((code) => !declared.has(code)).sort();
    expect(missing, `errJson code(s) missing from SHOP_API_ERROR_CODES: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no declared code that no route actually uses', () => {
    const used = literalErrJsonCodes();
    const stale = SHOP_API_ERROR_CODES.filter((code) => !used.has(code));
    expect(stale, `SHOP_API_ERROR_CODES entr(y/ies) no route uses: ${stale.join(', ')}`).toEqual([]);
  });
});
