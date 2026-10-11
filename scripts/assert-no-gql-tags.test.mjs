// node --test scripts/assert-no-gql-tags.test.mjs   (from the repo root)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { symlinkSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findGqlTags } from './assert-no-gql-tags.mjs';

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
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(root, rel), body);
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
