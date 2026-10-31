import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { BROTLI_OPTIONS, precompressDir, precompressPlugin } from './precompress';

describe('precompress', () => {
	it('brotli uses quality 11 via params (a bare level is ignored by node)', () => {
		expect(BROTLI_OPTIONS.params[constants.BROTLI_PARAM_QUALITY]).toBe(11);
	});
	it('emits .br and .gz for js/css/json/svg > 1KB; skips small files and html', async () => {
		const d = mkdtempSync(join(tmpdir(), 'pc-'));
		try {
			mkdirSync(join(d, 'n'));
			const big = 'abcdefgh'.repeat(400);
			for (const f of ['a.js', 'n/b.css', 'c.json', 'd.svg', 'e.mjs', 'f.html', 'small.js']) writeFileSync(join(d, f), f === 'small.js' ? 'x' : big);
			const { files } = await precompressDir(d);
			expect(files).toBe(5);
			for (const f of ['a.js', 'n/b.css', 'c.json', 'd.svg', 'e.mjs']) {
				expect(existsSync(join(d, `${f}.br`)), f).toBe(true);
				expect(existsSync(join(d, `${f}.gz`)), f).toBe(true);
			}
			expect(existsSync(join(d, 'f.html.br'))).toBe(false);
			expect(existsSync(join(d, 'small.js.br'))).toBe(false);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
	it('plugin is a post-enforced build plugin', () => {
		const p = precompressPlugin();
		expect(p.apply).toBe('build');
		expect(p.enforce).toBe('post');
	});
});
