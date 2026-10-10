// node --test tools/inventory/inventory.test.mjs   (cwd: packages/storefront)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { equalSnapshots, snapshot } from '../compose/fixtures/support.mjs';
import { analyzeModule, dice, jaccard, lineBag, routeOf, strictTokenHits } from './analyze.mjs';
import { main } from './inventory.mjs';
import { COLUMNS, UNKNOWN, checkRecords, parseCsv, renderCsv, skeletonRecords, toDispositions } from './reconcile.mjs';
import { gitInfo, loadBaseTree, walkBrand } from './tree.mjs';
import { buildUnion } from './union.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE_FIXTURE = path.join(HERE, 'fixtures', 'base');
const BRAND_FIXTURE = path.join(HERE, 'fixtures', 'brand');
const SENTINEL = 'SECRET_SENTINEL_5b1f3c';

const write = (root, rel, text) => {
	const abs = path.join(root, rel);
	mkdirSync(path.dirname(abs), { recursive: true });
	writeFileSync(abs, text);
};

/** A scratch world: a copy of the brand fixture with runtime state, and the read-only base fixture. */
function world({ git = false } = {}) {
	const root = mkdtempSync(path.join(tmpdir(), 'inventory-test-'));
	const brand = path.join(root, 'brand');
	cpSync(BRAND_FIXTURE, brand, { recursive: true });
	write(brand, '.env', `VITE_SECRET=${SENTINEL}\n`);
	write(brand, 'tmp/tsconfig.tsbuildinfo', '{}');
	write(brand, 'node_modules/dep/index.js', 'module.exports = 1;');
	write(brand, 'dist/index.html', '<html></html>');
	write(brand, 'server/entry.express.js', '// built');
	if (git) {
		const g = (...args) => {
			const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: brand, encoding: 'utf8' });
			assert.equal(r.status, 0, r.stderr);
		};
		write(brand, '.gitignore', '.env\nnode_modules\ndist\nserver\ntmp\n');
		g('init', '-q');
		g('add', '.');
		g('commit', '-q', '-m', 'legacy');
		write(brand, 'src/stray.ts', 'export const stray = 1;\n');
	}
	return { root, brand, base: BASE_FIXTURE, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function union(w, opts = {}) {
	const base = loadBaseTree({ baseDir: w.base });
	try {
		return buildUnion({ brand: walkBrand(w.brand), base: base.files, layers: null, git: opts.git ?? null, exportsAll: opts.exportsAll ?? false });
	} finally {
		base.cleanup();
	}
}

const row = (u, kind, p, name = '') => u.rows.find((r) => r.kind === kind && r.path === p && r.name === name);

test('analyze: export hashes ignore comments and layout; re-exports and aliases are recorded', () => {
	const a = analyzeModule('x.ts', "// c\nexport function f(a:number){return a+1}\nexport const K = 1;\nexport { K as K2 };\nexport { y } from './y';\nexport * from './z';\nexport default class Foo {}\n");
	const b = analyzeModule('x.ts', 'export function f(a: number) {\n\t/* other */ return a + 1;\n}\n');
	assert.equal(a.exports.get('f').hash, b.exports.get('f').hash);
	assert.deepEqual([...a.exports.keys()].sort(), ['K', 'K2', 'default', 'f', 'y']);
	assert.equal(a.exports.get('K2').hash, a.exports.get('K').hash);
	assert.deepEqual(a.exports.get('y'), { kind: 'reexport', hash: null, from: './y', imported: 'y' });
	assert.deepEqual(a.stars, ['./z']);
});

test('analyze: imports record names, type-only and dynamic specifiers', () => {
	const a = analyzeModule('x.tsx', "import d, { a as b, type T } from '~/platform/shop';\nimport * as ns from '~/platform/cart';\nimport type { U } from './u';\nconst m = () => import('~/platform/home');\n");
	const shop = a.imports.find((i) => i.spec === '~/platform/shop');
	assert.deepEqual(shop.names.map((n) => n.imported), ['default', 'a', 'T']);
	assert.deepEqual(a.imports.find((i) => i.spec === '~/platform/cart').names.map((n) => n.imported), ['*']);
	assert.equal(a.imports.find((i) => i.spec === './u').typeOnly, true);
	assert.equal(a.imports.find((i) => i.spec === '~/platform/home').kind, 'dynamic');
});

test('routeOf: Qwik City entry files only', () => {
	assert.deepEqual(routeOf('src/routes/shop/[slug]/index.tsx'), { pattern: '/shop/[slug]', kind: 'page', name: '/shop/[slug]' });
	assert.equal(routeOf('src/routes/index.tsx').name, '/');
	assert.equal(routeOf('src/routes/(auth)/sign-in/index.tsx').pattern, '/sign-in');
	assert.equal(routeOf('src/routes/account/layout-public.tsx').name, '/account#layout-public');
	assert.equal(routeOf('src/routes/checkout/checkout-styles.ts'), null);
	assert.equal(routeOf('src/routes/shop/index.test.ts'), null);
	assert.equal(routeOf('src/components/Card.tsx'), null);
});

test('similarity primitives', () => {
	assert.equal(dice(lineBag('a\nb\nc'), lineBag('a\nb\nc')), 1);
	assert.equal(dice(lineBag('a\nb'), lineBag('x\ny')), 0);
	assert.equal(dice(lineBag('{\n}'), lineBag('(\n)')), 0);
	assert.equal(jaccard(new Set(['a', 'b']), new Set(['b', 'c'])), 1 / 3);
	assert.deepEqual(strictTokenHits('streetLine1 streetLine1 facetValues'), { facetValues: 1, streetLine1: 2 });
});

test('union: statuses on the fixture trees, one row per renamed pair, runtime and env rows never read', () => {
	const w = world();
	try {
		const u = union(w);
		assert.equal(row(u, 'file', 'src/utils/same.ts').status, 'identical');
		assert.equal(row(u, 'file', 'src/utils/format.ts').status, 'diverged');
		const ren = row(u, 'file', 'src/utils/currency.ts');
		assert.equal(ren.status, 'renamed');
		assert.equal(ren.counterpart, 'src/utils/money.ts');
		assert.ok(Number(ren.similarity) >= 0.6 && Number(ren.exportOverlap) === 1);
		assert.equal(row(u, 'file', 'src/utils/money.ts'), undefined, 'the base side of a rename is not a second row');
		assert.equal(row(u, 'file', 'src/routes/layout.tsx').status, 'base-only');
		assert.equal(row(u, 'file', 'src/components/Card.tsx').status, 'base-only');
		assert.equal(row(u, 'file', 'package.json').status, 'diverged');
		assert.equal(row(u, 'file', 'public/logo.txt').status, 'identical');

		const catalog = row(u, 'file', 'src/sellright/catalog.tsx');
		assert.equal(catalog.status, 'brand-only');
		assert.ok(catalog.related.some((x) => x.startsWith('src/services/browse-catalog.ts')), catalog.related.join('|'));
		assert.ok(catalog.related.some((x) => x.startsWith('src/services/catalog-snapshot.ts')), catalog.related.join('|'));
		assert.ok(row(u, 'file', 'src/services/browse-catalog.ts').related.some((x) => x.startsWith('src/sellright/catalog.tsx')));

		assert.equal(row(u, 'route', 'src/routes/index.tsx', '/').status, 'identical');
		assert.equal(row(u, 'route', 'src/routes/shop/index.tsx', '/shop').status, 'diverged');
		assert.equal(row(u, 'route', 'src/routes/shop/[slug]/index.tsx', '/shop/[slug]').status, 'brand-only');
		assert.equal(row(u, 'route', 'src/routes/layout.tsx', '/#layout').status, 'base-only');

		const f = 'src/utils/format.ts';
		assert.equal(row(u, 'export', f, 'formatPrice').status, 'diverged');
		assert.equal(row(u, 'export', f, 'CURRENCY').status, 'identical');
		assert.equal(row(u, 'export', f, 'formatTax').status, 'brand-only');
		assert.equal(row(u, 'export', 'src/utils/currency.ts', 'zeroMoney').status, 'diverged');
		assert.equal(row(u, 'export', 'src/utils/currency.ts', 'addMoney').status, 'identical');
		assert.equal(row(u, 'export', 'src/services/browse-catalog.ts', 'loadBrowseCatalog'), undefined, 'base-only exports are JSON-only unless exportsAll');
		assert.ok(union(w, { exportsAll: true }).rows.some((r) => r.kind === 'export' && r.path === 'src/services/browse-catalog.ts'));

		assert.equal(row(u, 'file', 'src/services/legacy-address.ts').d7HitsText, 'emailAddress:2;streetLine1:2');

		const env = row(u, 'file', '.env');
		assert.equal(env.runtimeTop, true);
		assert.equal(row(u, 'file', 'tmp').runtimeTop, true);
		assert.equal(row(u, 'file', 'tmp/tsconfig.tsbuildinfo'), undefined, 'runtime directories are one row, not walked');
		assert.equal(row(u, 'file', 'node_modules/dep/index.js'), undefined);
		assert.equal(row(u, 'file', 'dist/index.html'), undefined);
		assert.equal(row(u, 'file', 'server/entry.express.js'), undefined);
		assert.ok(!JSON.stringify(u.rows).includes(SENTINEL), 'the .env contents are never read');
	} finally {
		w.cleanup();
	}
});

test('rename rules: similarity without export overlap is not a rename; identical bytes elsewhere are', () => {
	const root = mkdtempSync(path.join(tmpdir(), 'inventory-rename-'));
	try {
		const base = path.join(root, 'base');
		const brand = path.join(root, 'brand');
		const body = (n) => Array.from({ length: 12 }, (_, i) => `const line${i} = ${i};`).concat([`export const ${n} = 1;`]).join('\n');
		write(base, 'package.json', '{}');
		write(base, 'src/a/one.ts', body('alpha'));
		write(base, 'src/a/blob.ts', 'export const same = "identical bytes elsewhere";\n');
		write(brand, 'src/b/two.ts', body('beta'));
		write(brand, 'src/b/moved.ts', 'export const same = "identical bytes elsewhere";\n');
		const b = loadBaseTree({ baseDir: base });
		const u = buildUnion({ brand: walkBrand(brand), base: b.files });
		assert.equal(row(u, 'file', 'src/b/two.ts').status, 'brand-only', 'high similarity, no shared named export');
		assert.equal(row(u, 'file', 'src/a/one.ts').status, 'base-only');
		const moved = row(u, 'file', 'src/b/moved.ts');
		assert.equal(moved.status, 'renamed');
		assert.equal(moved.counterpart, 'src/a/blob.ts');
		assert.equal(moved.similarity, '1.00');
		b.cleanup();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('csv: round trip with commas, quotes and newlines; strict header', () => {
	const rec = Object.fromEntries(COLUMNS.map((c) => [c, '']));
	Object.assign(rec, { kind: 'file', path: 'a,b.ts', status: 'diverged', disposition: 'drop', reason: 'He said "no",\nthen left' });
	const text = renderCsv([rec]);
	assert.deepEqual(parseCsv(text), [rec]);
	assert.throws(() => parseCsv('kind,path\nfile,a\n'), /header/);
	assert.throws(() => parseCsv(`${COLUMNS.join(',')}\nfile,a\n`), /fields/);
});

test('skeleton and check: no unknown may remain; every rule fails and passes as stated', () => {
	const w = world();
	try {
		const u = union(w);
		const recs = skeletonRecords(u);
		const unknown = recs.filter((r) => r.disposition === UNKNOWN);
		assert.ok(unknown.length > 0);
		assert.equal(recs.find((r) => r.path === 'src/utils/same.ts' && r.kind === 'file').disposition, 'identical-to-base');
		assert.equal(recs.find((r) => r.path === '.env').disposition, 'runtime-preserved');
		assert.equal(recs.find((r) => r.path === 'src/components/Card.tsx').disposition, 'base-ahead');
		assert.equal(recs.find((r) => r.kind === 'export' && r.name === 'formatTax').disposition, 'same-as-file');
		assert.equal(recs.find((r) => r.path === 'src/services/legacy-address.ts').d7_class, UNKNOWN);

		let res = checkRecords({ union: u, records: recs });
		assert.ok(res.counts['unknown-disposition'] > 0);
		assert.ok(res.counts['d7-unclassified'] > 0);

		// decide every file row; exports and routes follow their file rows
		for (const r of recs) {
			if (r.kind === 'file' && r.disposition === UNKNOWN) Object.assign(r, { disposition: 'brand-specific', reason: 'brand owns it' });
			if (r.d7_class === UNKNOWN) r.d7_class = 'legacy-leftover';
		}
		res = checkRecords({ union: u, records: recs });
		assert.deepEqual(res.problems, []);

		// an upstream-fix needs evidence; drop on a base-only row is refused; a stale status is refused
		const fmt = recs.find((r) => r.kind === 'file' && r.path === 'src/utils/format.ts');
		Object.assign(fmt, { disposition: 'upstream-fix', reason: 'port the euro formatting' });
		assert.deepEqual(checkRecords({ union: u, records: recs }).problems.map((p) => p.code), ['evidence-required']);
		fmt.evidence = 'tests/format.test.ts';
		assert.deepEqual(checkRecords({ union: u, records: recs }).problems, []);
		const card = recs.find((r) => r.path === 'src/components/Card.tsx');
		card.disposition = 'drop';
		card.reason = 'nope';
		assert.deepEqual(checkRecords({ union: u, records: recs }).problems.map((p) => p.code), ['bad-disposition']);
		card.disposition = 'base-ahead';
		fmt.status = 'identical';
		assert.deepEqual(checkRecords({ union: u, records: recs }).problems.map((p) => p.code), ['status-changed']);
		fmt.status = 'diverged';

		// missing, stale and a reason that is only the auto marker
		const gone = recs.filter((r) => r.path !== 'src/utils/currency.ts' || r.kind !== 'file');
		assert.ok(checkRecords({ union: u, records: gone }).counts['missing-row']);
		const extra = [...recs, { ...recs[0], path: 'src/never.ts', name: '' }];
		assert.ok(checkRecords({ union: u, records: extra }).counts['stale-row']);
		const ren = recs.find((r) => r.kind === 'file' && r.path === 'src/utils/currency.ts');
		ren.reason = 'auto: nothing';
		assert.deepEqual(checkRecords({ union: u, records: recs }).problems.map((p) => p.code), ['reason-required']);
		ren.reason = 'renamed upstream';
		// identical-to-base on a non-identical row
		fmt.disposition = 'identical-to-base';
		assert.deepEqual(checkRecords({ union: u, records: recs }).problems.map((p) => p.code), ['bad-disposition']);
	} finally {
		w.cleanup();
	}
});

test('merge: decisions survive a regeneration; a changed status goes back to unknown', () => {
	const w = world();
	try {
		const u = union(w);
		const first = skeletonRecords(u);
		const fmt = first.find((r) => r.kind === 'file' && r.path === 'src/utils/format.ts');
		Object.assign(fmt, { disposition: 'brand-specific', reason: 'kept' });
		const again = skeletonRecords(u, first);
		const kept = again.find((r) => r.kind === 'file' && r.path === 'src/utils/format.ts');
		assert.equal(kept.disposition, 'brand-specific');
		assert.equal(kept.reason, 'kept');

		fmt.status = 'identical';
		const changed = skeletonRecords(u, first).find((r) => r.kind === 'file' && r.path === 'src/utils/format.ts');
		assert.equal(changed.disposition, UNKNOWN);
		assert.match(changed.reason, /status changed identical -> diverged/);
	} finally {
		w.cleanup();
	}
});

test('toDispositions: compose classes, base-only and runtime rows left out', () => {
	const mk = (kind, p, status, disposition, reason = 'because') => ({ ...Object.fromEntries(COLUMNS.map((c) => [c, ''])), kind, path: p, status, disposition, reason });
	const d = toDispositions([
		mk('file', 'a.ts', 'diverged', 'upstream-fix'),
		mk('file', 'b.ts', 'renamed', 'base-ahead'),
		mk('file', 'c.ts', 'brand-only', 'brand-specific'),
		mk('file', 'd.ts', 'brand-only', 'drop'),
		mk('file', 'e.ts', 'identical', 'identical-to-base'),
		mk('file', 'f.ts', 'base-only', 'base-ahead'),
		mk('file', '.env', 'brand-only', 'runtime-preserved'),
		mk('export', 'a.ts', 'diverged', 'same-as-file'),
	]);
	assert.deepEqual(Object.keys(d).sort(), ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);
	assert.equal(d['a.ts'].class, 'superseded');
	assert.equal(d['c.ts'].class, 'brand-l3');
	assert.equal(d['d.ts'].class, 'dropped');
});

test('cli: --out is validated before any directory is created: symlink into an input, and the pin source repo, are refused', async () => {
	const w = world();
	try {
		const sink = { out: () => {}, err: () => {} };
		const run = (...extra) => main(['--base', w.base, '--brand', w.brand, '--no-git', ...extra], sink);
		const link = path.join(w.root, 'outside-link');
		symlinkSync(w.brand, link);
		await assert.rejects(run('--out', path.join(link, 'new', 'r.csv')), /symlink|out-inside-input/);
		assert.ok(!existsSync(path.join(w.brand, 'new')), 'nothing was created inside the brand tree through the link');
		await assert.rejects(run('--out', path.join(w.root, 'ok.csv'), '--json-out', path.join(link, 'deep', 'er', 'i.json')), /symlink|out-inside-input/);
		assert.ok(!existsSync(path.join(w.brand, 'deep')));
		const baseLink = path.join(w.root, 'base-link');
		symlinkSync(w.base, baseLink);
		await assert.rejects(run('--out', path.join(baseLink, 'r.csv')), /symlink|out-inside-input/);
		writeFileSync(path.join(w.root, 'target.csv'), 'keep');
		symlinkSync(path.join(w.root, 'target.csv'), path.join(w.root, 'final-link.csv'));
		await assert.rejects(run('--out', path.join(w.root, 'final-link.csv')), /symlink/);
		assert.equal(readFileSync(path.join(w.root, 'target.csv'), 'utf8'), 'keep');

		// Pinned inventory: the source repository (explicit or default) is an input root.
		const repo = path.join(w.root, 'pin-repo');
		mkdirSync(repo, { recursive: true });
		writeFileSync(path.join(repo, 'existing.csv'), 'keep');
		const pinned = (...extra) => main(['--pin', 'a'.repeat(40), '--repo', repo, '--brand', w.brand, '--no-git', ...extra], sink);
		await assert.rejects(pinned('--out', path.join(repo, 'existing.csv')), /out-inside-input/);
		assert.equal(readFileSync(path.join(repo, 'existing.csv'), 'utf8'), 'keep');
		await assert.rejects(pinned('--out', path.join(repo, 'sub', 'new.csv')), /out-inside-input/);
		assert.ok(!existsSync(path.join(repo, 'sub')));
		await assert.rejects(pinned('--out', path.join(w.root, 'ok.csv'), '--json-out', path.join(repo, 'j.json')), /out-inside-input/);
	} finally {
		w.cleanup();
	}
});

test('cli: skeleton, check, dispositions; inputs untouched; --out inside an input refused', async () => {
	const w = world();
	try {
		const before = { brand: snapshot(w.brand), base: snapshot(w.base) };
		const csv = path.join(w.root, 'out', 'reconcile.csv');
		const sink = { out: () => {}, err: () => {} };
		assert.equal(await main(['--base', w.base, '--brand', w.brand, '--out', csv, '--json-out', path.join(w.root, 'out', 'inv.json'), '--no-git'], sink), 0);
		assert.ok(existsSync(csv));
		assert.equal(await main(['--base', w.base, '--brand', w.brand, '--reconcile', csv, '--check', '--no-git'], sink), 1);
		const lines = [];
		await main(['--base', w.base, '--brand', w.brand, '--reconcile', csv, '--check', '--no-git'], { out: (s) => lines.push(s), err: () => {} });
		assert.match(lines.join(''), /unknown-disposition/);

		const recs = parseCsv(readFileSync(csv, 'utf8'));
		for (const r of recs) {
			if (r.disposition === UNKNOWN) Object.assign(r, { disposition: 'brand-specific', reason: 'brand owns it' });
			if (r.d7_class === UNKNOWN) r.d7_class = 'wire-name';
		}
		writeFileSync(csv, renderCsv(recs));
		assert.equal(await main(['--base', w.base, '--brand', w.brand, '--reconcile', csv, '--check', '--no-git'], sink), 0);
		const dispOut = path.join(w.root, 'out', 'dispositions.json');
		assert.equal(await main(['--base', w.base, '--brand', w.brand, '--reconcile', csv, '--dispositions', '--out', dispOut, '--no-git'], sink), 0);
		const disp = JSON.parse(readFileSync(dispOut, 'utf8'));
		assert.equal(disp['src/sellright/catalog.tsx'].class, 'brand-l3');
		assert.equal(disp['src/utils/currency.ts'].class, 'brand-l3');
		assert.equal(disp['src/services/browse-catalog.ts'], undefined);

		await assert.rejects(main(['--base', w.base, '--brand', w.brand, '--out', path.join(w.brand, 'x.csv'), '--no-git'], sink), /out-inside-input/);
		await assert.rejects(main(['--base', w.base, '--brand', w.brand, '--check', '--no-git'], sink), /needs --reconcile/);
		await assert.rejects(main(['--base', w.base, '--brand', w.brand, '--bogus'], sink), /unknown argument/);
		const help = [];
		assert.equal(await main(['--help'], { out: (s) => help.push(s), err: () => {} }), 0);
		assert.match(help.join(''), /usage: inventory\.mjs/);

		assert.ok(equalSnapshots(before.brand, snapshot(w.brand)), 'the brand tree is unchanged');
		assert.ok(equalSnapshots(before.base, snapshot(w.base)), 'the base tree is unchanged');
	} finally {
		w.cleanup();
	}
});

test('git: tracked flags, untracked stray file, dirty list, --require-clean', async () => {
	const w = world({ git: true });
	try {
		const info = gitInfo(w.brand);
		assert.equal(info.inside, true);
		assert.ok(info.tracked.has('src/utils/format.ts'));
		assert.ok(!info.tracked.has('src/stray.ts'));
		assert.ok(info.dirty.some((l) => l.includes('src/stray.ts')));
		const u = union(w, { git: info });
		assert.equal(row(u, 'file', 'src/utils/format.ts').tracked, 'yes');
		assert.equal(row(u, 'file', 'src/stray.ts').tracked, 'no');
		assert.equal(row(u, 'file', 'src/stray.ts').status, 'brand-only');

		const recs = skeletonRecords(u);
		for (const r of recs) {
			if (r.disposition === UNKNOWN) Object.assign(r, { disposition: 'brand-specific', reason: 'decided' });
			if (r.d7_class === UNKNOWN) r.d7_class = 'wire-name';
		}
		assert.deepEqual(checkRecords({ union: u, records: recs, gitDirty: info.dirty }).problems, []);
		assert.deepEqual(checkRecords({ union: u, records: recs, gitDirty: info.dirty, requireClean: true }).problems.map((p) => p.code), ['dirty-tree']);
	} finally {
		w.cleanup();
	}
});
