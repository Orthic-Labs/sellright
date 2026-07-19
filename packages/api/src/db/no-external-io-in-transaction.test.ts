import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN_IDENTIFIERS = new Set([
  'executeGatewayRefund',
  'fetch',
  'safeOutboundFetch',
  'sendApns',
  'sendEmail',
]);
const FORBIDDEN_METHODS = new Set(['createPayment', 'refundPayment']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) return [];
    return [path];
  });
}

function callName(call: ts.CallExpression): string | null {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
  return null;
}

function externalCallsInsideStoreTransaction(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations: string[] = [];

  function inspectStoreCallback(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const name = callName(node);
      if (name && (FORBIDDEN_IDENTIFIERS.has(name) || FORBIDDEN_METHODS.has(name))) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push(`${relative(SRC_ROOT, path)}:${position.line + 1} (${name})`);
      }
    }
    ts.forEachChild(node, inspectStoreCallback);
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && callName(node) === 'withStore') {
      const callback = node.arguments[1];
      if (callback) inspectStoreCallback(callback);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return violations;
}

describe('database transaction boundaries', () => {
  it('never performs known external I/O inside withStore callbacks', () => {
    const violations = sourceFiles(SRC_ROOT).flatMap(externalCallsInsideStoreTransaction);
    expect(violations, `external I/O found inside withStore:\n${violations.join('\n')}`).toEqual([]);
  });
});
