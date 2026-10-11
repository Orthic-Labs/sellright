import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkNoVendure } from './assert-no-vendure.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assert-no-vendure.mjs');
const dirs = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** A throwaway package root: base file, brand overlay file, optional data files. */
function fixture({ overlay = {}, base = {}, list, exceptions, allowlist, config } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'no-vendure-'));
  dirs.push(root);
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put('src/base.ts', 'export const price = { priceWithTax: 1 }; // REST wire name\n');
  for (const [rel, text] of Object.entries(base)) put(rel, text);
  for (const [rel, text] of Object.entries(overlay)) put(rel, text);
  if (list) put('.compose-overlay-files.txt', list.join('\n') + '\n');
  if (exceptions) put('scripts/assert-no-vendure.exceptions', exceptions);
  if (allowlist) put('scripts/assert-no-vendure.allowlist', allowlist);
  if (config) put('package.json', config);
  return root;
}
const run = (root) => spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });

test('the base tree passes (tier 1 only, no overlay list)', () => {
  assert.deepEqual(checkNoVendure({ root: PACKAGE_ROOT }), []);
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: PACKAGE_ROOT });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /assert-no-vendure: OK/);
});

test('a planted graphql string in an overlay file fails, and the same file in the base fails too (tier 1)', () => {
  const planted = 'const q = "query { graphql }";\n';
  const overlay = fixture({ overlay: { 'src/brand/x.ts': planted }, list: ['src/brand/x.ts'] });
  const r = run(overlay);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /src\/brand\/x\.ts:1 \[tier 1\]/);
  assert.equal(run(fixture({ base: { 'src/routes/y.ts': planted } })).status, 1);
});

test('gql tag, @vendure import and __typename each fail', () => {
  for (const text of ['const a = gql`{ a }`;', "import x from '@vendure/core';", 'const t = o.__typename;']) {
    assert.equal(run(fixture({ base: { 'src/z.ts': text + '\n' } })).status, 1, text);
  }
});

test('tier 2: strict wire names fail in an overlay file only, not in the base file that holds them', () => {
  const root = fixture({ overlay: { 'src/brand/p.ts': 'const x = p.featuredAsset;\n' }, list: ['src/brand/p.ts'] });
  const found = checkNoVendure({ root });
  assert.deepEqual(found.map((f) => [f.file, f.tier, f.token]), [['src/brand/p.ts', 2, 'featuredAsset']]); // src/base.ts priceWithTax is not reported
  assert.equal(checkNoVendure({ root: fixture() }).length, 0); // no overlay list: tier 2 has no files
});

test('tier 2 exception is scoped to one file and one token', () => {
  const overlay = { 'src/brand/p.ts': 'const x = p.featuredAsset + p.facetValues;\n' };
  const root = fixture({ overlay, list: ['src/brand/p.ts'], exceptions: '# c\nsrc/brand/p.ts|featuredAsset|old stored shape\n' });
  assert.deepEqual(checkNoVendure({ root }).map((f) => f.token), ['facetValues']);
});

test('the bare word fails unless the file is allowlisted', () => {
  const base = { 'src/m.ts': '// from Vendure\n' };
  assert.equal(run(fixture({ base })).status, 1);
  assert.equal(run(fixture({ base, allowlist: 'src/m.ts\n' })).status, 0);
});

test('config files: a Vendure-shaped env name fails, a /home/vendure path does not', () => {
  assert.equal(run(fixture({ config: '{"x":"VITE_VENDURE_PROD_URL"}' })).status, 1);
  assert.equal(run(fixture({ config: '{"x":"/home/vendure/app"}' })).status, 0);
});

test('a missing explicit overlay list is an error, not a silent pass', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', fixture(), '--overlay-list', '/nonexistent/list.txt'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
});

test('every executable source extension is scanned (.jsx .cjs .mts .cts included)', () => {
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']) {
    const r = checkNoVendure({ root: fixture({ base: { [`src/planted${ext}`]: 'const q = "graphql";\n' } }) });
    assert.deepEqual(r.map((f) => f.file), [`src/planted${ext}`], ext);
  }
  assert.equal(checkNoVendure({ root: fixture({ base: { 'src/data.json': '{"q":"graphql"}\n', 'src/n.md': 'graphql\n' } }) }).length, 0); // not executable
});

test('a gql tagged template is found across whitespace, newlines and comments', () => {
  const bypasses = {
    space: 'const a = gql `{ a }`;\n',
    tab: 'const a = gql\t`{ a }`;\n',
    newline: 'const a = gql\n`{ a }`;\n',
    blank_lines: 'const a = gql\n\n  \n`{ a }`;\n',
    block_comment: 'const a = gql/* x */`{ a }`;\n',
    comment_newline: 'const a = gql /* a\nb */\n`{ a }`;\n',
    line_comment: 'const a = gql // note\n`{ a }`;\n',
    type_args: 'const a = gql<Vars>`{ a }`;\n',
    type_args_nested: 'const a = gql<Record<string, number>>\n`{ a }`;\n',
    member: 'const a = client\n  .gql\n`{ a }`;\n',
  };
  for (const [name, text] of Object.entries(bypasses)) {
    const found = checkNoVendure({ root: fixture({ base: { 'src/q.ts': text } }) });
    assert.ok(found.some((f) => f.file === 'src/q.ts' && f.tier === 1), name);
  }
});

test('a split gql tagged template is reported once, on its own line, and the CLI fails', () => {
  const root = fixture({ base: { 'src/q.mts': 'const ok = 1;\nconst a = gql\n`{ a }`;\n' } });
  const found = checkNoVendure({ root });
  assert.deepEqual(found.map((f) => [f.file, f.line]), [['src/q.mts', 2]]);
  assert.equal(run(root).status, 1);
});

test('the word gql without a template, and a same-line template, behave as before', () => {
  assert.equal(checkNoVendure({ root: fixture({ base: { 'src/ok.ts': 'const gqlish = 1; // the gql word alone\nconst s = `x`;\n' } }) }).length, 0);
  assert.equal(checkNoVendure({ root: fixture({ base: { 'src/q.ts': 'const a = gql`{ a }`;\n' } }) }).length, 1); // one finding, not two
});
