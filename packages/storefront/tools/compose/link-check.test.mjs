import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkLinks } from './link-check.mjs';

const world = () => {
	const base = mkdtempSync(path.join(tmpdir(), 'link-check-'));
	const store = path.join(base, 'store');
	const shared = path.join(base, 'sellright/packages/storefront/node_modules/.bin');
	mkdirSync(path.join(store, 'vendor/storefront-client'), { recursive: true });
	mkdirSync(path.join(store, 'node_modules/@sellright'), { recursive: true });
	mkdirSync(shared, { recursive: true });
	writeFileSync(path.join(store, 'vendor/storefront-client/package.json'), '{}');
	return { base, store, shared, done: () => rmSync(base, { recursive: true, force: true }) };
};

test('relative workspace links inside the store pass', () => {
	const w = world();
	symlinkSync('../../vendor/storefront-client', path.join(w.store, 'node_modules/@sellright/storefront-client'));
	const r = checkLinks(w.store);
	assert.equal(r.ok, true);
	assert.equal(r.links, 1);
	w.done();
});

test('an absolute link is refused even when it resolves inside the store (a copy would point at the original)', () => {
	const w = world();
	symlinkSync(path.join(w.store, 'vendor/storefront-client'), path.join(w.store, 'node_modules/@sellright/storefront-client'));
	const r = checkLinks(w.store);
	assert.equal(r.ok, false);
	assert.deepEqual(r.problems.map((p) => p.kind), ['absolute']);
	w.done();
});

test('a .bin linked into the shared SellRight checkout is refused; a declared external is accepted', () => {
	const w = world();
	symlinkSync(w.shared, path.join(w.store, 'node_modules/.bin'));
	const r = checkLinks(w.store);
	assert.equal(r.ok, false);
	assert.deepEqual(r.problems.map((p) => [p.kind, p.path]), [['escapes', 'node_modules/.bin']]);
	assert.equal(checkLinks(w.store, { externals: [path.join(w.base, 'sellright')] }).ok, true);
	w.done();
});

test('relative links that climb out of the store are refused', () => {
	const w = world();
	symlinkSync('../../sellright', path.join(w.store, 'node_modules/escape'));
	assert.deepEqual(checkLinks(w.store).problems.map((p) => p.kind), ['escapes']);
	w.done();
});
