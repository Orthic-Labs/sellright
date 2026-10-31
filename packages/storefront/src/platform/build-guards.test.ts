import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGuardsPlugin, checkGlobalCss } from './build-guards';

const dirs: string[] = [];
function tree(files: Record<string, string>): string {
	const d = mkdtempSync(join(tmpdir(), 'sr-guards-'));
	dirs.push(d);
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(join(d, rel, '..'), { recursive: true });
		writeFileSync(join(d, rel), text);
	}
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T = ['--brand', 'font', 'display'].join('-'); // not a literal: the token inventory scans src/
const GOOD = `:root{${T}:"Cormorant Garamond",serif}@font-face{font-family:"Cormorant Garamond";src:url(/f.woff2)}`;

describe('css gate (checkGlobalCss)', () => {
	it('passes when the global stylesheet defines --brand-font-display and carries the brand faces', async () => {
		const d = tree({ 'dist/build/style-Ab1_x.css': GOOD, 'src/brand/fonts.css': '@font-face{}' });
		expect(await checkGlobalCss(join(d, 'dist'), d)).toEqual([]);
	});

	it('fails when the brand tokens were dropped (bedbed29: @source before the tokens @import)', async () => {
		const d = tree({ 'dist/build/style-Ab1.css': '.a{color:red}' });
		const errors = await checkGlobalCss(join(d, 'dist'), d);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/brand-font-display/);
	});

	it('fails when src/brand/fonts.css exists and the stylesheet has no @font-face', async () => {
		const d = tree({ 'dist/build/style-Ab1.css': `:root{${T}:x}`, 'src/brand/fonts.css': '@font-face{}' });
		const errors = await checkGlobalCss(join(d, 'dist'), d);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/@font-face/);
	});

	it('needs no @font-face without src/brand/fonts.css', async () => {
		const d = tree({ 'dist-demo/build/style-Ab1.css': `:root{${T}:x}` });
		expect(await checkGlobalCss(join(d, 'dist-demo'), d)).toEqual([]);
	});

	it('fails when no style-*.css was emitted; other build css does not count', async () => {
		const d = tree({ 'dist/build/license-Ab1.css': GOOD });
		expect((await checkGlobalCss(join(d, 'dist'), d))[0]).toMatch(/no global stylesheet/);
	});
});

type Hook = (this: unknown) => unknown;
function plugin(flow: string, root: string, outDir: string, ssr = false, written: string[] | null = ['build/style-Ab1.css', 'q-manifest.json']) {
	const p = buildGuardsPlugin({ commerceFlow: flow });
	(p.configResolved as unknown as (c: unknown) => void)({ root, build: { outDir, ssr } });
	if (written) (p.writeBundle as unknown as (o: unknown, b: Record<string, unknown>) => void)({}, Object.fromEntries(written.map((f) => [f, {}])));
	return p;
}

describe('buildGuardsPlugin', () => {
	it('closeBundle throws on a broken global stylesheet, with an absolute (Qwik) outDir', async () => {
		const d = tree({ 'dist/build/style-Ab1.css': '.a{}' });
		const p = plugin('cart', d, join(d, 'dist'));
		await expect((p.closeBundle as Hook).call({})).rejects.toThrow(/css-gate.*brand-font-display/);
	});

	it('resolves a relative outDir against the root', async () => {
		const d = tree({ 'dist/build/style-Ab1.css': GOOD });
		const p = plugin('cart', d, 'dist');
		await expect((p.closeBundle as Hook).call({})).resolves.toBeUndefined();
	});

	it('checks only the stylesheet this bundle wrote (a stale dist/ file neither passes nor fails it)', async () => {
		const d = tree({ 'dist/build/style-Ab1.css': '.a{}', 'dist/build/style-Old.css': GOOD });
		await expect((plugin('cart', d, 'dist').closeBundle as Hook).call({})).rejects.toThrow(/style-Ab1\.css does not define/);
		const d2 = tree({ 'dist/build/style-Ab1.css': GOOD, 'dist/build/style-Old.css': '.a{}' });
		await expect((plugin('cart', d2, 'dist').closeBundle as Hook).call({})).resolves.toBeUndefined();
	});

	it('does not run after a failed build (nothing written): the real error is not masked', async () => {
		const d = tree({});
		await expect((plugin('cart', d, 'dist', false, null).closeBundle as Hook).call({})).resolves.toBeUndefined();
	});

	it('exempts the license flow and the server build', async () => {
		const d = tree({});
		await expect((plugin('license', d, 'dist').closeBundle as Hook).call({})).resolves.toBeUndefined();
		await expect((plugin('cart', d, 'server', true).closeBundle as Hook).call({})).resolves.toBeUndefined();
	});

	it('buildStart runs scripts/check-brand-perf.mjs and errors with its findings when it fails', () => {
		const d = tree({ 'scripts/check-brand-perf.mjs': "console.error('src/x.tsx:1:1 img-hero-lazy boom'); process.exit(1)\n" });
		const p = plugin('cart', d, 'dist');
		const ctx = { error: (m: string) => { throw new Error(m); }, warn: () => undefined };
		expect(() => (p.buildStart as Hook).call(ctx)).toThrow(/brand perf checks failed[\s\S]*img-hero-lazy boom/);
		writeFileSync(join(d, 'scripts/check-brand-perf.mjs'), 'process.exit(0)\n');
		expect(() => (p.buildStart as Hook).call(ctx)).not.toThrow();
	});
});
