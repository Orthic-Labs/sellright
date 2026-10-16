// node --test scripts/assert-no-gql-tags.test.mjs   (from the repo root)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { symlinkSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findGqlTags, findUnexpectedVendureMentions } from './assert-no-gql-tags.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const positives = {
  'bare tag': 'const q = gql`{ a }`;',
  'parenthesised tag': 'const q = (gql)`{ a }`;',
  'double parentheses': 'const q = ((gql))`{ a }`;',
  'member access': 'const q = apollo.gql`{ a }`;',
  'parenthesised member access': 'const q = (apollo.gql)`{ a }`;',
  'element access': "const q = apollo['gql']`{ a }`;",
  'as cast': 'const q = (gql as any)`{ a }`;',
  'as cast to a function type': 'const q = (gql as (s: TemplateStringsArray) => string)`{ a }`;',
  'angle-bracket assertion (.ts)': 'const q = (<any>gql)`{ a }`;',
  'satisfies': 'const q = (gql satisfies Tag)`{ a }`;',
  'non-null on the tag': 'const q = gql!`{ a }`;',
  'non-null member': 'const q = apollo.gql!`{ a }`;',
  'parenthesised non-null': 'const q = (gql!)`{ a }`;',
  'comma sequence': 'const q = (0, gql)`{ a }`;',
  'nested wrappers': 'const q = ((apollo.gql as any)!)`{ a }`;',
  'graphql tag': 'const q = (graphql)`{ a }`;',
  'substitution inside': 'const q = (gql)`{ a(id: ${id}) }`;',
  'nested inside another expression': 'export default () => [(gql)`{ a }`];',
};
const negatives = {
  'other tag': 'const q = sql`select 1`;',
  'parenthesised other tag': 'const q = (sql)`select 1`;',
  'gql identifier, not a tag': 'const gql = 1; const x = (gql);',
  'gql called as a function': 'const q = gql("{ a }");',
  'gql in a plain template': 'const q = `${gql}`;',
  'gql inside a string': "const q = 'gql`x`';",
  'gql inside a comment': '// (gql)`x`\n/* gql`x` */',
  'member named differently': 'const q = apollo.gqlish`x`;',
  'element access on another key': "const q = apollo['sql']`x`;",
  'comma sequence ending elsewhere': 'const q = (gql, sql)`x`;',
};

for (const [name, src] of Object.entries(positives)) {
  test(`detects: ${name}`, () => {
    assert.equal(findGqlTags('x.ts', src).length, 1, src);
  });
}
for (const [name, src] of Object.entries(negatives)) {
  test(`ignores: ${name}`, () => {
    assert.deepEqual(findGqlTags('x.ts', src), [], src);
  });
}

test('parses .tsx and .js sources', () => {
  assert.equal(findGqlTags('x.tsx', 'const a = <div>{(gql)`{ a }`}</div>;').length, 1);
  assert.equal(findGqlTags('x.js', 'const q = (gql)`{ a }`;').length, 1);
});

test('CLI exits 1 on a hit and 0 on a clean tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'sr-gql-'));
  dirs.push(root);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'ok.ts'), 'export const a = sql`x`;');
  const run = () => spawnSync('node', [join(here, 'assert-no-gql-tags.mjs'), join(root, 'src')], { encoding: 'utf8' });
  assert.equal(run().status, 0);
  writeFileSync(join(root, 'src', 'bad.ts'), 'export const a = (gql as any)`x`;');
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /bad\.ts:1:\d+: tagged template/);
});

// The shell guard, in a throwaway repo layout (it cd's to its own parent dir).
function guardRepo({ scanner, files = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'sr-guard-'));
  dirs.push(root);
  mkdirSync(join(root, 'scripts'));
  copyFileSync(join(here, 'assert-no-vendure.sh'), join(root, 'scripts', 'assert-no-vendure.sh'));
  if (scanner === 'real') copyFileSync(join(here, 'assert-no-gql-tags.mjs'), join(root, 'scripts', 'assert-no-gql-tags.mjs'));
  else writeFileSync(join(root, 'scripts', 'assert-no-gql-tags.mjs'), scanner);
  mkdirSync(join(root, 'packages', 'api', 'src'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  // typescript resolves from the real repo's node_modules
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(join(here, '..', 'node_modules', 'typescript'), join(root, 'node_modules', 'typescript'));
  return spawnSync('bash', [join(root, 'scripts', 'assert-no-vendure.sh')], { encoding: 'utf8' });
}

test('shell guard: a crashing scanner fails the guard instead of passing it', () => {
  for (const scanner of ['throw new Error("boom");', 'process.exit(2);', 'process.exit(1);']) {
    const r = guardRepo({ scanner });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /AST scanner failed/);
  }
});

test('shell guard: a missing typescript module fails the guard', () => {
  const r = guardRepo({ scanner: "import ts from 'definitely-not-installed-pkg'; console.log(ts);" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /AST scanner failed/);
});

test('shell guard: real scanner passes a clean tree and fails a wrapped tag', () => {
  const ok = guardRepo({ scanner: 'real', files: { 'packages/api/src/a.ts': 'export const a = sql`x`;' } });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const bad = guardRepo({ scanner: 'real', files: { 'packages/api/src/a.ts': 'export const a = (gql)`x`;' } });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /GraphQL tagged template found/);
});

const cartSummary = 'Adopt a frozen Vendure cart or reconcile a browser snapshot once';
const compatibilityFixtures = {
  'packages/api/src/auth/cookies.ts': `/** Vendure carriers are untrusted transport, consumed only by migration bootstrap. */
    const carrier = headers.__vendure_session; const header = 'x-vendure-session-token';
    /** Preserve original signed HttpOnly Vendure cookie throughout rollback window. */
    function clearReadableLegacyToken() {}`,
  'packages/api/src/auth/legacy-cookies.test.ts': "const key = '__vendure_session'; const a = `__vendure_session=${wrapped}`; const b = `authToken=opaque_456; __vendure_session=${wrapped}`;",
  'packages/api/src/routes/disputes-nmi.db.test.ts': "const metadata = { vendure: { vendureMethod: 'nmi-payment' } };",
  'packages/api/src/routes/cart.ts': `const summary = '${cartSummary}';` + "const query = sql`${field}->>'vendureId' = ${id}`; const sku = `vendure-unresolved:${id}`;",
  'packages/api/src/routes/gateway-payments.webhook.test.ts': "const metadata = { vendure: { vendureMethod: 'sezzle', sourceKey: 'vendure:damned' } };",
  'packages/api/src/routes/legacy-session-cart.db.test.ts': "const metadata = { vendureId: 17 }; const sourceKey = 'vendure:test'; const key = '__vendure_session='; const cookie = `__vendure_session=${wrapped}`; const sku = 'vendure-unresolved:999';",
  'packages/api/src/payments/sezzle-reconcile.test.ts': "const metadata = { vendure: { vendureMethod: 'sezzle', sourceKey: 'vendure:damned' } }; const other = 'vendure:other';",
  'packages/api/src/payments/sezzle-reconcile.ts': 'const method = metadata.vendure.vendureMethod;',
  'packages/storefront-client/src/generated/schema.d.ts': `interface Routes {
  /** ${cartSummary} */
  migration: unknown;
}`,
  'packages/storefront-client/dist/generated/schema.d.ts': `interface Routes {
  /** ${cartSummary} */
  migration: unknown;
}`,
  'packages/storefront/src/services/CartService.test.ts': "const key = 'vendure_local_cart';",
  'packages/storefront/src/services/legacy-cart.test.ts': "const key = 'vendure_local_cart';",
  'packages/storefront/src/services/CartService.ts': "export const LEGACY_CART_KEY = 'vendure_local_cart';",
  'packages/storefront/src/services/CountryPreferenceService.ts': "const raw = localStorage.getItem('vendure_local_cart');",
  'packages/storefront/src/providers/shop/account/bootstrap.test.ts': "const cleared = value.startsWith('__vendure_session=');",
  'packages/storefront/src/routes/account/layout.tsx': "const carrier = cookie.get('__vendure_session');",
  'packages/storefront/src/routes/layout.tsx': "const carrier = cookie.get('__vendure_session');",
};

test('word guard accepts only declared compatibility syntax in all 17 exact paths', () => {
  assert.equal(Object.keys(compatibilityFixtures).length, 17);
  for (const [file, text] of Object.entries(compatibilityFixtures)) {
    assert.deepEqual(findUnexpectedVendureMentions(file, text), [], file);
    assert.ok(findUnexpectedVendureMentions(file, `${text}\n// Vendure API`).length > 0, file);
    assert.ok(findUnexpectedVendureMentions(file.replace(/\.(ts|tsx)$/, '.other.$1'), text).length > 0, file);
  }
  const result = guardRepo({ scanner: 'real', files: compatibilityFixtures });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('word guard rejects longer Unicode identifiers, undeclared values & expanded descriptions', () => {
  const file = 'packages/api/src/payments/sezzle-reconcile.ts';
  for (const identifier of ['$vendure', 'vendure$', 'αvendure', 'vendureé', 'vendure\u200C', 'vendure\u200D', 'vendureMethodExtra']) {
    assert.ok(findUnexpectedVendureMentions(file, `const ${identifier} = 1;`).length > 0, identifier);
  }
  for (const text of ["const value = 'vendure';", "const value = 'vendure:damned';", '// vendure', '// Vendure API']) {
    assert.ok(findUnexpectedVendureMentions(file, text).length > 0, text);
  }
  for (const [path, text] of [
    ['packages/api/src/payments/sezzle-reconcile.test.ts', "const sourceKey = 'vendure:damned-extra';"],
    ['packages/api/src/payments/sezzle-reconcile.test.ts', "const sourceKey = 'vendure:unexpected';"],
    ['packages/api/src/routes/cart.ts', 'const sku = `vendure-unresolved:extra${id}`;'],
    ['packages/api/src/routes/cart.ts', `const summary = '${cartSummary} via Vendure API';`],
    ['packages/storefront-client/src/generated/schema.d.ts', `/** ${cartSummary} plus API */ interface Routes {}`],
    ['packages/storefront/src/services/CartService.ts', "const key = 'vendure_local_cart_extra';"],
  ]) assert.ok(findUnexpectedVendureMentions(path, text).length > 0, `${path}: ${text}`);
});

test('shell guard retains hard coupling checks inside compatibility paths', () => {
  const file = 'packages/api/src/payments/sezzle-reconcile.ts';
  for (const signal of ["import x from '@vendure/core';", "const api = 'graphql';", 'const type = value.__typename;', 'const query = (gql as any)`x`;']) {
    const result = guardRepo({ scanner: 'real', files: { [file]: `${compatibilityFixtures[file]}\n${signal}` } });
    assert.equal(result.status, 1, signal);
    assert.match(result.stdout, /GraphQL\/Vendure coupling signal|GraphQL tagged template found/);
  }
});

test('shell guard fails closed when compatibility scanner crashes or exits without findings', () => {
  for (const failure of ['throw new Error("word scan failed");', 'process.exit(2);', 'process.exit(1);']) {
    const result = guardRepo({
      scanner: `if (process.argv.includes('--words')) { ${failure} }`,
      files: { 'packages/api/src/payments/sezzle-reconcile.ts': 'const method = metadata.vendure;' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /compatibility scanner failed/);
  }
});

test('both scanner modes reject malformed syntax before masking an accepted compatibility identifier', () => {
  const file = 'packages/api/src/payments/sezzle-reconcile.ts';
  const text = 'const method = metadata.vendure; const =';
  const diagnostic = /Cannot parse packages\/api\/src\/payments\/sezzle-reconcile\.ts:\d+:\d+: .+/;
  for (const scan of [findGqlTags, findUnexpectedVendureMentions]) {
    assert.throws(() => scan(file, text), diagnostic);
  }

  const root = mkdtempSync(join(tmpdir(), 'sr-malformed-'));
  dirs.push(root);
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
  for (const mode of [[], ['--words']]) {
    const result = spawnSync(process.execPath, [join(here, 'assert-no-gql-tags.mjs'), ...mode, file], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, diagnostic);
  }
  const result = guardRepo({ scanner: 'real', files: { [file]: text } });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /AST scanner failed/);
  assert.match(result.stdout, /compatibility scanner failed/);
  assert.match(result.stderr, diagnostic);
});
