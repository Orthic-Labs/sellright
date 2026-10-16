import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareCaptures, loadInventory, normalizeHtml, parseCapture, stripMarkedElement } from './ssr-normalize.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ssr-normalize.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssr-cmp-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
const dir = (files) => {
  const d = path.join(root, `d${n++}`);
  fs.mkdirSync(d);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(d, `${name}.txt`), text);
  return d;
};
const cap = (body, status = 200, type = 'text/html; charset=utf-8') => `status: ${status}\ncontent-type: ${type}\n\n${body}`;
const PAGES = [{ name: 'home', path: '/', status: 200, marker: 'hello' }, { name: 'gone', path: '/x/', status: 404, marker: '', allowEmptyBody: true }];
const ok = (home = '<p>hello</p>') => ({ home: cap(home), gone: cap('', 404, 'text/plain') });

test('normalises Qwik bookkeeping (state, ids, keys, nonces) and nothing visible', () => {
  const a = '<html><script nonce="N1">x</script><button q:id="1" q:key="a" class="b a">go</button><p class="x">hi</p><script type="qwik/state">{"a":1}</script></html>';
  const b = '<html><script nonce="N2">x</script><button q:id="9" q:key="z" class="b a">go</button><p class="x">hi</p><script type="qwik/state">{"a":2}</script></html>';
  assert.equal(normalizeHtml(a), normalizeHtml(b));
});

test('strict on elements, attributes and text: each visible difference survives normalisation', () => {
  const base = '<main><p class="x" id="a">hi</p><img src="/a.png" alt="A"></main>';
  assert.notEqual(normalizeHtml(base), normalizeHtml(base.replace('hi', 'bye')), 'text');
  assert.notEqual(normalizeHtml(base), normalizeHtml(base.replace('class="x"', 'class="y"')), 'attribute value');
  assert.notEqual(normalizeHtml(base), normalizeHtml(base.replace(' id="a"', '')), 'attribute removed');
  assert.notEqual(normalizeHtml(base), normalizeHtml(base.replace('<p', '<div').replace('</p>', '</div>')), 'element');
  assert.notEqual(normalizeHtml(base), normalizeHtml(base.replace('alt="A"', 'alt="B"')), 'alt text');
  assert.notEqual(normalizeHtml(base), normalizeHtml(base.replace('</main>', '<span>extra</span></main>')), 'extra element');
});

test('documented per-page differences: ignoreAttrs only drops that attribute on that tag; ignorePreloads only drops modulepreload links', () => {
  const a = '<h2 id="intro">T</h2><p id="intro">x</p><link rel="modulepreload" href="/build/q-AAAA1111.js"><link rel="stylesheet" href="/a.css">';
  const b = '<h2>T</h2><p id="intro">x</p><link rel="modulepreload" href="/build/q-AAAA1111.js"><link rel="modulepreload" href="/build/q-BBBB2222.js"><link rel="stylesheet" href="/a.css">';
  assert.notEqual(normalizeHtml(a), normalizeHtml(b));
  assert.notEqual(normalizeHtml(a, [{ tag: 'h2', attr: 'id' }]), normalizeHtml(b, [{ tag: 'h2', attr: 'id' }]), 'preload still differs');
  assert.equal(normalizeHtml(a, [{ tag: 'h2', attr: 'id' }], true), normalizeHtml(b, [{ tag: 'h2', attr: 'id' }], true));
  assert.notEqual(normalizeHtml(a.replace('<p id="intro">', '<p>'), [{ tag: 'h2', attr: 'id' }], true), normalizeHtml(b, [{ tag: 'h2', attr: 'id' }], true), 'the p id is not ignored');
  assert.ok(!normalizeHtml(a, [], true).includes('modulepreload'));
  assert.ok(normalizeHtml(a, [], true).includes('<link href="/a.css" rel="stylesheet">'), 'a stylesheet link is not a preload');
});

test('identical captures pass; a visible difference fails and names the page', () => {
  assert.deepEqual(compareCaptures(dir(ok()), dir(ok()), PAGES), { problems: [], same: 2, different: 0, expected: 0 });
  const r = compareCaptures(dir(ok()), dir(ok('<p>hello world</p>')), PAGES);
  assert.equal(r.different, 1);
  assert.match(r.problems[0], /^home: rendered markup differs/);
});

test('two empty directories fail (identically empty is not proof)', () => {
  const r = compareCaptures(dir({}), dir({}), PAGES);
  assert.ok(r.problems.length >= 2);
  assert.match(r.problems.join('\n'), /home: missing on the before side/);
  assert.equal(r.same, 0);
});

test('an empty inventory fails', () => {
  assert.deepEqual(compareCaptures(dir(ok()), dir(ok()), []).problems, ['the capture inventory is empty']);
});

test('matching error pages cannot stand in for the intended page: status and marker are checked on both sides', () => {
  const broken = { home: cap('<p>Not found</p>', 404), gone: cap('', 404, 'text/plain') };
  const r = compareCaptures(dir(broken), dir(broken), PAGES);
  assert.match(r.problems.join('\n'), /home: before status is 404, expected 200/);
  assert.match(r.problems.join('\n'), /home: after status is 404, expected 200/);
  assert.match(r.problems.join('\n'), /does not contain the marker "hello"/);
  assert.ok(compareCaptures(dir({ home: cap(''), gone: cap('', 404) }), dir(ok()), PAGES).problems.some((p) => /home: before body is empty/.test(p)));
});

test('a page missing on one side, an unlisted extra file and a wrong content type fail', () => {
  const a = ok();
  assert.match(compareCaptures(dir({ home: a.home }), dir(ok()), PAGES).problems.join('\n'), /gone: missing on the before side/);
  assert.match(compareCaptures(dir({ ...ok(), extra: cap('x') }), dir(ok()), PAGES).problems.join('\n'), /extra\.txt is not in the inventory/);
  assert.match(compareCaptures(dir(ok()), dir({ home: cap('<p>hello</p>', 200, 'text/plain'), gone: a.gone }), PAGES).problems.join('\n'), /content-type differs/);
  assert.match(compareCaptures(path.join(root, 'nope'), dir(ok()), PAGES).problems.join('\n'), /does not exist/);
});

test('parseCapture reads the capture format and refuses anything else', () => {
  assert.deepEqual(parseCapture(cap('b', 404, 'text/plain')), { status: 404, contentType: 'text/plain', body: 'b' });
  assert.equal(parseCapture('<html>'), null);
});

test('the real inventory covers the widened set: a real blog post and a successful IndexNow key, every page with an expected status', () => {
  const pages = loadInventory();
  const names = pages.map((p) => p.name);
  for (const must of ['blog-post', 'indexnow-key-hit', 'indexnow-key-miss', 'blog-missing-post', 'home', 'contact']) assert.ok(names.includes(must), must);
  assert.equal(new Set(names).size, names.length, 'unique names');
  assert.equal(pages.find((p) => p.name === 'blog-post').status, 200);
  assert.equal(pages.find((p) => p.name === 'indexnow-key-hit').status, 200);
  assert.ok(pages.every((p) => Number.isInteger(p.status) && p.path.startsWith('/') && (p.marker || p.allowEmptyBody)));
  assert.deepEqual(pages.filter((p) => p.ignoreAttrs || p.ignorePreloads).map((p) => p.name).sort(), ['blog-post', 'contact']);
});

const LOY = { name: 'co', path: '/c/', status: 200, marker: 'data-testid="redeem"', expectedDifference: { reason: 'main lacks it', afterOnlyMarker: 'data-testid="redeem"' } };
const withControl = '<main><h1>Pay</h1><div class="w"><div data-testid="redeem"><div>inner</div><button>Use</button></div></div><p>total</p></main>';
const withoutControl = '<main><h1>Pay</h1><div class="w"></div><p>total</p></main>';
const co = (body) => ({ co: cap(body) });

test('expectedDifference: a before side without the control matches an after side with it, nothing else may differ', () => {
  const r = compareCaptures(dir(co(withoutControl)), dir(co(withControl)), [LOY]);
  assert.deepEqual(r, { problems: [], same: 1, different: 0, expected: 1 });
  // the rest of the page is still strict
  assert.equal(compareCaptures(dir(co(withoutControl)), dir(co(withControl.replace('<p>total</p>', '<p>totals</p>'))), [LOY]).different, 1);
  assert.equal(compareCaptures(dir(co(withoutControl)), dir(co(withControl.replace('<h1>Pay</h1>', '<h1>Pay</h1><span>x</span>'))), [LOY]).different, 1);
  assert.equal(compareCaptures(dir(co(withoutControl.replace('class="w"', 'class="v"'))), dir(co(withControl)), [LOY]).different, 1, 'the wrapper attributes are compared');
});

test('expectedDifference: the after side must have the control; with the control on both sides the page is compared in full', () => {
  const missing = compareCaptures(dir(co(withoutControl)), dir(co(withoutControl)), [LOY]);
  assert.match(missing.problems.join('\n'), /after side lacks the expected-difference marker/);
  assert.deepEqual(compareCaptures(dir(co(withControl)), dir(co(withControl)), [LOY]), { problems: [], same: 1, different: 0, expected: 0 });
  assert.equal(compareCaptures(dir(co(withControl)), dir(co(withControl.replace('Use', 'Spend'))), [LOY]).different, 1);
});

test('expectedDifference does not excuse a page that has none: a missing marker on a plain page still fails', () => {
  const plain = { ...LOY }; delete plain.expectedDifference;
  assert.match(compareCaptures(dir(co(withoutControl)), dir(co(withControl)), [plain]).problems.join('\n'), /before body does not contain the marker/);
});

test('stripMarkedElement removes exactly the marked element, nested same-tag children included', () => {
  assert.equal(stripMarkedElement(withControl, 'data-testid="redeem"'), withoutControl);
  assert.equal(stripMarkedElement('<p>a</p>', 'x'), null);
  assert.equal(stripMarkedElement('<div data-x="1"><div>open</div>', 'data-x'), null);
  assert.equal(stripMarkedElement('<p>a</p><img data-x="1"/><p>b</p>', 'data-x'), '<p>a</p><p>b</p>');
});

test('the real inventory documents exactly one expected difference: checkout-loyalty', () => {
  const withEd = loadInventory().filter((p) => p.expectedDifference);
  assert.deepEqual(withEd.map((p) => p.name), ['checkout-loyalty']);
  assert.equal(withEd[0].expectedDifference.afterOnlyMarker, withEd[0].marker);
  assert.ok(withEd[0].expectedDifference.reason.length > 20);
});

test('CLI: exit 0 when identical, 1 on a difference or empty directories, 2 on bad usage', () => {
  const inv = path.join(root, 'inv.json');
  fs.writeFileSync(inv, JSON.stringify({ pages: PAGES }));
  const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a, '--inventory', inv], { encoding: 'utf8' });
  assert.equal(run(dir(ok()), dir(ok())).status, 0);
  assert.equal(run(dir(ok()), dir(ok('<p>hello!</p>'))).status, 1);
  const empty = run(dir({}), dir({}));
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /missing on the before side/);
  assert.equal(spawnSync(process.execPath, [SCRIPT, 'only-one'], { encoding: 'utf8' }).status, 2);
  const emptyInv = path.join(root, 'empty.json');
  fs.writeFileSync(emptyInv, JSON.stringify({ pages: [] }));
  assert.equal(spawnSync(process.execPath, [SCRIPT, dir(ok()), dir(ok()), '--inventory', emptyInv], { encoding: 'utf8' }).status, 1);
});
