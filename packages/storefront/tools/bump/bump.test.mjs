// node --test tools/bump/bump.test.mjs   (cwd: packages/storefront)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { BASE_FIXTURE, BRAND_FIXTURE, equalSnapshots, miniLoadEnv, snapshot } from '../compose/fixtures/support.mjs';
import { SECTION_IDS, assertFullSha, buildReport, main, renderMarkdown, reportJson } from './bump-report.mjs';
import { diffMaps, lockMismatches, lockSpecifiers, resolveSpec } from './platform-api.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SF = 'packages/storefront';

const write = (root, rel, text) => {
	const abs = path.join(root, rel);
	mkdirSync(path.dirname(abs), { recursive: true });
	writeFileSync(abs, text);
};
function git(cwd, ...args) {
	const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
	return r.stdout.trim();
}

const LOCK_OK = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      '@sellright/storefront-client':
        specifier: workspace:*
        version: link:vendor/storefront-client
`;

/** <root>/repo: a git repo from the compose base fixture, two commits; <root>/brand/storefront: a layer pinned at the first. */
function world() {
	const root = mkdtempSync(path.join(tmpdir(), 'bump-test-'));
	const repo = path.join(root, 'repo');
	const layer = path.join(root, 'brand', 'storefront');
	cpSync(BASE_FIXTURE, repo, { recursive: true });
	// the brand file below imports these platform modules, so the fixture base lists them as public platform API (r4)
	const layersFile = path.join(repo, SF, 'layers.json');
	const layersJson = JSON.parse(readFileSync(layersFile, 'utf8'));
	for (const m of ['loader', 'reexp', 'gone', 'cart']) layersJson.platformApi.public[`~/platform/${m}`] = '*';
	writeFileSync(layersFile, `${JSON.stringify(layersJson, null, '\t')}\n`);
	write(repo, `${SF}/src/platform/gone.ts`, 'export const goneThing = 1;\n');
	write(repo, `${SF}/src/platform/reexp.ts`, "export { helper } from '~/services/util';\n");
	write(repo, `${SF}/src/services/util.ts`, 'export const helper = () => 1;\n');
	write(repo, `${SF}/src/components/slots/registry.ts`, "export interface SlotPropsMap {\n\t'pdp.payment-widget': { priceCents: number };\n\t'pdp.waitlist': { productId: string };\n}\n");
	git(repo, 'init', '-q');
	git(repo, 'add', '.');
	git(repo, 'commit', '-q', '-m', 'old pin');
	const OLD = git(repo, 'rev-parse', 'HEAD');

	write(repo, `${SF}/src/platform/loader.ts`, 'export const loader = (x: number) => x;\n');
	git(repo, 'rm', '-q', `${SF}/src/platform/gone.ts`);
	write(repo, `${SF}/src/services/util.ts`, 'export const helper = () => 2;\n');
	write(repo, `${SF}/src/platform/cart.ts`, 'export const cart = 1;\n');
	write(repo, `${SF}/src/components/slots/registry.ts`, "export interface SlotPropsMap {\n\t'pdp.payment-widget': { priceCents: number; currency: string };\n}\n");
	write(repo, `${SF}/src/components/Button.tsx`, 'export const Button = () => <button class="base-button v2">Buy</button>;\n');
	const schema = JSON.parse(readFileSync(path.join(repo, SF, 'brand-env.schema.json'), 'utf8'));
	delete schema.settings['pdp.bfcacheRefresh'];
	write(repo, `${SF}/brand-env.schema.json`, `${JSON.stringify(schema, null, 2)}\n`);
	const pkg = JSON.parse(readFileSync(path.join(repo, SF, 'package.json'), 'utf8'));
	pkg.dependencies['left-pad'] = '1.0.0';
	write(repo, `${SF}/package.json`, `${JSON.stringify(pkg, null, '\t')}\n`);
	git(repo, 'add', '-A');
	git(repo, 'commit', '-q', '-m', 'new pin');
	const NEW = git(repo, 'rev-parse', 'HEAD');

	cpSync(BRAND_FIXTURE, layer, { recursive: true });
	const brand = JSON.parse(readFileSync(path.join(layer, 'brand.json'), 'utf8'));
	brand.pin = OLD;
	write(layer, 'brand.json', `${JSON.stringify(brand, null, 2)}\n`);
	write(layer, 'pnpm-lock.yaml', LOCK_OK);
	write(layer, 'overlay/src/brand/uses.ts', "import { loader } from '~/platform/loader';\nimport { helper } from '~/platform/reexp';\nexport const uses = [loader, helper];\n");
	return { root, repo, layer, OLD, NEW, cleanup: () => rmSync(root, { recursive: true, force: true }), brandJson: () => JSON.parse(readFileSync(path.join(layer, 'brand.json'), 'utf8')) };
}

const section = (r, id) => r.sections.find((s) => s.id === id);

test('platform-api primitives: lock specifiers, mismatches, resolveSpec, diffMaps', () => {
	const lock = readFileSync(path.join(HERE, 'fixtures', 'pnpm-lock.sample.yaml'), 'utf8');
	const spec = lockSpecifiers(lock);
	assert.deepEqual([...spec], [['@sellright/storefront-client', 'workspace:*'], ['@stripe/stripe-js', '^9.17.0'], ['typescript', '6.0.3']]);
	assert.deepEqual([...lockSpecifiers(lock, 'vendor/storefront-client')], [['zod', '^4.0.0']]);
	const pkg = JSON.stringify({ dependencies: { '@sellright/storefront-client': 'workspace:*', '@stripe/stripe-js': '^10.0.0', extra: '1.0.0' }, devDependencies: { typescript: '6.0.3' } });
	const m = lockMismatches({ lockText: lock, pkgText: pkg });
	assert.equal(m.checked, 4);
	assert.deepEqual(m.problems.map((p) => p.name).sort(), ['@stripe/stripe-js', 'extra']);

	const tree = { has: (r) => ['src/platform/a.ts', 'src/platform/b/index.tsx', 'src/services/s.ts'].includes(r), read: () => null, paths: () => [] };
	assert.equal(resolveSpec(tree, 'src/platform/x.ts', '~/platform/a'), 'src/platform/a.ts');
	assert.equal(resolveSpec(tree, 'src/platform/x.ts', './b'), 'src/platform/b/index.tsx');
	assert.equal(resolveSpec(tree, 'src/platform/x.ts', '../services/s.js'), 'src/services/s.ts');
	assert.equal(resolveSpec(tree, 'src/platform/x.ts', 'react'), null);
	assert.deepEqual(diffMaps(new Map([['a', 1], ['b', 1]]), new Map([['b', 2], ['c', 1]])), { added: ['c'], removed: ['a'], changed: ['b'] });
});

test('pin validation: only a full 40-character lowercase SHA is accepted', async () => {
	assert.equal(assertFullSha('a'.repeat(40), '--to'), 'a'.repeat(40));
	for (const bad of ['abc', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), `${'a'.repeat(39)}g`, undefined, 'main']) assert.throws(() => assertFullSha(bad, '--to'), /bad-pin/);
	const sink = { out: () => {}, err: () => {} };
	await assert.rejects(main(['--brand', '/nonexistent', '--to', 'abc123'], sink), /bad-pin/);
	await assert.rejects(main(['--brand', '/nonexistent', '--to', 'a'.repeat(40), '--from', 'xyz'], sink), /bad-pin/);
	assert.equal(await main([], sink), 2);
});

test('full report on a changed pin: every section, each finding with its consumers', async () => {
	const w = world();
	try {
		write(w.layer, 'overlay/src/brand/uses-gone.ts', "import { goneThing } from '~/platform/gone';\nexport const g = goneThing;\n");
		write(w.layer, 'overlay/src/brand-slots/pdp.waitlist.tsx', 'export const W = () => <p>waitlist</p>;\n');
		const b = w.brandJson();
		b.settings['pdp.bfcacheRefresh'] = true;
		write(w.layer, 'brand.json', `${JSON.stringify(b, null, 2)}\n`);

		const before = snapshot(w.layer);
		const r = await buildReport({ layerDir: w.layer, to: w.NEW, repo: w.repo, loadEnv: miniLoadEnv });
		assert.deepEqual(r.sections.map((s) => s.id), SECTION_IDS);
		assert.equal(r.complete, true, JSON.stringify(r.sections.filter((s) => s.status === 'error')));
		assert.equal(r.verdict, 'review-required');

		const log = section(r, 'changelog');
		assert.equal(log.data.ancestry, 'forward');
		assert.equal(log.data.commits.length, 1);
		assert.equal(log.data.commits[0].subject, 'new pin');
		assert.ok(log.data.perPath['packages/storefront'].files > 0);

		const api = section(r, 'platform-api');
		assert.equal(api.status, 'findings');
		assert.ok(api.data.removed.includes('src/platform/gone.ts#goneThing'));
		assert.ok(api.data.changed.includes('src/platform/loader.ts#loader'));
		assert.ok(api.data.changed.includes('src/platform/reexp.ts#helper'), 're-exports are followed to their declaration');
		assert.ok(api.data.added.includes('src/platform/cart.ts#cart'));
		const loaderHit = api.data.touched.find((t) => t.key === 'src/platform/loader.ts#loader');
		assert.deepEqual(loaderHit.consumers.map((c) => c.file), ['src/brand/uses.ts']);
		const goneHit = api.data.touched.find((t) => t.key === 'src/platform/gone.ts#goneThing');
		assert.deepEqual(goneHit.consumers.map((c) => c.file), ['src/brand/uses-gone.ts']);
		assert.ok(api.data.broken.some((x) => x.file === 'src/brand/uses-gone.ts' && /no longer exists/.test(x.reason)));

		const sl = section(r, 'slots');
		assert.equal(sl.status, 'findings');
		assert.deepEqual(sl.data.changed, ['pdp.payment-widget']);
		assert.deepEqual(sl.data.removed, ['pdp.waitlist']);
		assert.deepEqual(sl.data.touched.map((t) => [t.slot, t.files]), [['pdp.waitlist', ['src/brand-slots/pdp.waitlist.tsx']]]);

		const env = section(r, 'env-schema');
		assert.deepEqual(env.data.removed, ['settings:pdp.bfcacheRefresh']);
		assert.deepEqual(env.data.impact.map((i) => i.key), ['settings:pdp.bfcacheRefresh']);

		const deps = section(r, 'dependencies');
		assert.ok(deps.data.added.includes('dependencies:left-pad'));
		assert.ok(deps.data.lockProblems.some((p) => p.name === 'left-pad'));

		const dr = section(r, 'drift');
		assert.equal(dr.status, 'findings');
		assert.ok(dr.data.problems.some((p) => p.code === 'drift-unresolved'));
		assert.match(dr.lines.join('\n'), /```diff[\s\S]*base-button v2/);

		const dry = section(r, 'dry-run');
		assert.equal(dry.status, 'findings');
		assert.equal(dry.data.ok, false);
		assert.ok(dry.data.problems.some((p) => p.includes('drift-unresolved')));

		assert.equal(section(r, 'pins-hashes').data.hashes.pin, w.NEW);
		assert.equal(section(r, 'external-gates').status, 'not-run');
		assert.ok(equalSnapshots(before, snapshot(w.layer)), 'the brand layer is unchanged');
		assert.ok(!existsSync(path.join(w.root, 'brand', 'store')), 'no build directory was created');

		const md = renderMarkdown(r);
		for (const s of r.sections) assert.ok(md.includes(s.title), s.title);
		assert.match(md, /Verdict: \*\*review-required\*\*/);
		const json = JSON.parse(reportJson(r));
		assert.equal(json.sections.length, SECTION_IDS.length);
		assert.ok(json.sections.every((s) => !('lines' in s)));
	} finally {
		w.cleanup();
	}
});

test('a bump to the same pin is a clean report with composition succeeding', async () => {
	const w = world();
	try {
		const r = await buildReport({ layerDir: w.layer, to: w.OLD, repo: w.repo, loadEnv: miniLoadEnv });
		assert.equal(r.complete, true, JSON.stringify(r.sections.filter((s) => s.status === 'error')));
		assert.equal(section(r, 'changelog').data.ancestry, 'same');
		for (const id of ['platform-api', 'slots', 'env-schema', 'dependencies', 'drift']) assert.equal(section(r, id).status, 'ok', `${id}: ${section(r, id).summary}`);
		assert.equal(section(r, 'dry-run').data.ok, true, section(r, 'dry-run').summary);
		assert.match(section(r, 'dry-run').lines.join('\n'), /publicConfig/);
	} finally {
		w.cleanup();
	}
});

test('a pin that does not exist in the repo is refused before any section runs', async () => {
	const w = world();
	try {
		await assert.rejects(buildReport({ layerDir: w.layer, to: 'b'.repeat(40), repo: w.repo }), /bad-pin/);
	} finally {
		w.cleanup();
	}
});

test('cli: --out and --json-out written, --check summary and exit code, inputs untouched, --out inside an input refused', async () => {
	const w = world();
	try {
		const before = { layer: snapshot(w.layer), repo: snapshot(path.join(w.repo, SF)) };
		const outMd = path.join(w.root, 'out', 'report.md');
		const outJson = path.join(w.root, 'out', 'report.json');
		const lines = [];
		const sink = { out: (s) => lines.push(s), err: () => {}, loadEnv: miniLoadEnv };
		const code = await main(['--brand', w.layer, '--to', w.NEW, '--repo', w.repo, '--out', outMd, '--json-out', outJson, '--check'], sink);
		assert.equal(code, 0);
		assert.match(lines.join(''), /verdict review-required, complete/);
		assert.match(readFileSync(outMd, 'utf8'), /^# Pin bump review: fixture/);
		assert.equal(JSON.parse(readFileSync(outJson, 'utf8')).to, w.NEW);

		await assert.rejects(main(['--brand', w.layer, '--to', w.NEW, '--repo', w.repo, '--out', path.join(w.layer, 'report.md')], sink), /out-inside-input/);
		await assert.rejects(main(['--brand', w.layer, '--to', w.NEW, '--repo', w.repo, '--json-out', path.join(w.repo, 'r.json')], sink), /out-inside-input/);
		assert.ok(equalSnapshots(before.layer, snapshot(w.layer)));
		assert.ok(equalSnapshots(before.repo, snapshot(path.join(w.repo, SF))));
	} finally {
		w.cleanup();
	}
});

test('cli: --out is validated before any directory is created: symlink into an input, and the effective build dir, are refused', async () => {
	const w = world();
	try {
		const sink = { out: () => {}, err: () => {}, loadEnv: miniLoadEnv };
		const run = (...extra) => main(['--brand', w.layer, '--to', w.NEW, '--repo', w.repo, ...extra], sink);
		// A symlink outside the inputs that points into the layer: the absent child must not be created inside it.
		const link = path.join(w.root, 'outside-link');
		symlinkSync(w.layer, link);
		await assert.rejects(run('--out', path.join(link, 'new', 'report.md')), /symlink|out-inside-input/);
		assert.ok(!existsSync(path.join(w.layer, 'new')), 'nothing was created inside the layer through the link');
		await assert.rejects(run('--json-out', path.join(link, 'deep', 'er', 'r.json')), /symlink|out-inside-input/);
		assert.ok(!existsSync(path.join(w.layer, 'deep')));
		// A link to an input repo, an existing link target and a link as the final component are refused as well.
		const repoLink = path.join(w.root, 'repo-link');
		symlinkSync(w.repo, repoLink);
		await assert.rejects(run('--out', path.join(repoLink, 'r.md')), /symlink|out-inside-input/);
		writeFileSync(path.join(w.root, 'target.md'), 'keep');
		symlinkSync(path.join(w.root, 'target.md'), path.join(w.root, 'final-link.md'));
		await assert.rejects(run('--out', path.join(w.root, 'final-link.md')), /symlink/);
		assert.equal(readFileSync(path.join(w.root, 'target.md'), 'utf8'), 'keep');

		// Default build dir (sibling of the layer, per brand.json buildDir), existing file and not-yet-created path.
		const defaultBuild = path.join(path.dirname(w.layer), 'store');
		write(defaultBuild, 'package.json', '{}');
		await assert.rejects(run('--out', path.join(defaultBuild, 'package.json')), /out-inside-input/);
		assert.equal(readFileSync(path.join(defaultBuild, 'package.json'), 'utf8'), '{}');
		await assert.rejects(run('--out', path.join(defaultBuild, 'sub', 'report.md')), /out-inside-input/);
		assert.ok(!existsSync(path.join(defaultBuild, 'sub')));
		// Explicit --build-dir replaces the default as the guarded input.
		const explicit = path.join(w.root, 'explicit-build');
		write(explicit, 'x.txt', 'x');
		await assert.rejects(run('--build-dir', explicit, '--out', path.join(explicit, 'x.txt')), /out-inside-input/);
		assert.equal(readFileSync(path.join(explicit, 'x.txt'), 'utf8'), 'x');
		await assert.rejects(run('--build-dir', explicit, '--out', path.join(link, 'a', 'b.md')), /symlink|out-inside-input/);
	} finally {
		w.cleanup();
	}
});

test('prod-smoke spec is GET only: no write method, no browser, no form or click', () => {
	const src = readFileSync(path.join(HERE, '..', '..', 'e2e', 'prod-smoke.spec.ts'), 'utf8');
	assert.ok(/\.get\(/.test(src), 'it must make GET requests');
	for (const bad of [/\.post\(/, /\.put\(/, /\.patch\(/, /\.delete\(/, /\.fetch\(/, /\.head\(/, /method\s*:/, /\bpage\./, /\{[^}]*\bpage\b[^}]*\}\s*\)?\s*=>/, /\.goto\(/, /\.click\(/, /\.fill\(/, /\.submit\(/, /newPage\(/, /\{[^}]*\bbrowser\b[^}]*\}/, /chromium/]) {
		assert.ok(!bad.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), `forbidden construct ${bad}`);
	}
	assert.match(src, /SMOKE_TARGET_URL/);
});
