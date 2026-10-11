// @vitest-environment node
/**
 * Static guards for the LOCKED stock architecture (CLAUDE.md "Stock Architecture"): the rules that can be checked by
 * reading source, run on every `pnpm test`. They complement the behavioural suite (e2e/stock-parity.spec.ts), which
 * observes API-side requests. Observation only — nothing here changes how stock is fetched. Plan A9 scenarios 12, 14, 17.
 * Comments are stripped before matching, so prose that names a forbidden thing ("no cache, no TTL") never trips a guard.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (rel: string) => stripComments(readFileSync(join(SRC, rel), 'utf8'));

function sourceFiles(dir = SRC, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) sourceFiles(full, out);
		else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !full.includes(`${join('src', 'generated')}`)) out.push(full);
	}
	return out;
}
const all = sourceFiles().map((f) => ({ rel: relative(SRC, f), code: stripComments(readFileSync(f, 'utf8')) }));

describe('locked stock rules — static guards (scenario 14)', () => {
	it('ProductCacheService has no stock method or field', () => {
		expect(read('services/ProductCacheService.ts')).not.toMatch(/stock/i);
	});
	it('no STOCK_CACHE_DURATION and no lastStockRefresh anywhere in src', () => {
		const hits = all.filter((f) => /STOCK_CACHE_DURATION|lastStockRefresh/.test(f.code)).map((f) => f.rel);
		expect(hits).toEqual([]);
	});
});

describe('no focus / visibility stock refresh (scenario 12)', () => {
	it('no visibilitychange handler and no focus handler registered anywhere in src', () => {
		const hits = all
			.filter((f) => /visibilitychange|use(?:On)?(?:Document|Window)\(\s*['"](?:focus|visibilitychange)['"]|addEventListener\(\s*['"]focus['"]/.test(f.code))
			.map((f) => f.rel);
		expect(hits).toEqual([]);
	});
});

describe('catalog reader holds no cache (scenario 17 structural guard)', () => {
	// A cache keyed on the generation is still a stock cache (locked layer 5): the publisher mints a new generation per
	// publication, so a generation-keyed memo looks fresh after every publish — only the no-publication reload shows it.
	for (const file of ['services/catalog-snapshot.ts', 'services/browse-catalog.ts']) {
		describe(file, () => {
			const code = read(file);
			it('has no module-scope let/var', () => {
				expect(code.match(/^(let|var)\s/gm) ?? []).toEqual([]);
			});
			it('has no module-scope const other than a function, import-free of mutable containers', () => {
				const offenders = (code.match(/^(?:export\s+)?const\s+\w+[^=\n]*=\s*(?!async\b|function\b|\([^)]*\)\s*=>|\w+\s*=>).*$/gm) ?? []);
				expect(offenders).toEqual([]);
			});
			it('constructs no Map/WeakMap/Set/WeakSet and holds no Promise at module scope', () => {
				expect(code).not.toMatch(/\bnew\s+(Map|WeakMap|Set|WeakSet)\b/);
				expect(code.match(/^(?:export\s+)?(?:const|let|var)\s+\w+[^=\n]*=\s*(?:Promise\.|new Promise)/gm) ?? []).toEqual([]);
			});
			it('imports no cache/memo helper and names none', () => {
				expect(code).not.toMatch(/import[^;]*from\s+['"][^'"]*(cache|memo|lru)[^'"]*['"]/i);
				expect(code).not.toMatch(/\b(memoize|memo|lru|cache)\b/i);
			});
		});
	}
});

describe('pre-submit live stock read (locked layer 4)', () => {
	it('placeOrder awaits refreshStockBeforeSubmit before the order-creating call', () => {
		const code = read('hooks/useCheckout.ts');
		const read_ = code.indexOf('await refreshStockBeforeSubmit()');
		const post = code.indexOf('await srPlaceOrder(');
		expect(read_, 'refreshStockBeforeSubmit must be awaited in placeOrder').toBeGreaterThan(-1);
		expect(post).toBeGreaterThan(read_);
	});
});
