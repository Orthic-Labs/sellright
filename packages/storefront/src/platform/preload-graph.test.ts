import { describe, expect, it } from 'vitest';
import { pruneBundleGraph, type BundleGraph } from './preload-graph';

// Decode the flat graph the same way the rc.3 preloader does (preloader.mjs `F`): name -> [{dep, probability}].
const decode = (g: BundleGraph) => {
	const out: Record<string, { dep: string; p: number }[]> = {};
	let i = 0;
	while (i < g.length) {
		const name = g[i++] as string;
		const deps: { dep: string; p: number }[] = [];
		let p = 1;
		while (typeof g[i] === 'number') { const n = g[i++] as number; if (n < 0) p = -n / 10; else deps.push({ dep: g[n] as string, p }); }
		out[name] = deps;
	}
	return out;
};

describe('pruneBundleGraph (P7/V30)', () => {
	// a.js: static b.js, dynamic c.js (0.8) and d.js (0.6); route "shop/" -> a.js, c.js (dynamic); symbol "s1" -> c.js.
	const graph: BundleGraph = ['a.js', 6, -8, 7, -6, 8, 'b.js', 'c.js', 'd.js', 'shop/', -9, 0, 7, 's1', -9, 7];
	it('drops dynamic edges out of JS bundles and keeps static imports', () => {
		const g = decode(pruneBundleGraph(graph));
		expect(g['a.js']).toEqual([{ dep: 'b.js', p: 1 }]);
		expect(g['b.js']).toEqual([]);
		expect(g['d.js']).toEqual([]);
	});
	it('keeps route and symbol edges intact, with indexes rewritten', () => {
		const pruned = pruneBundleGraph(graph);
		const g = decode(pruned);
		expect(g['shop/']).toEqual([{ dep: 'a.js', p: 0.9 }, { dep: 'c.js', p: 0.9 }]);
		expect(g['s1']).toEqual([{ dep: 'c.js', p: 0.9 }]);
		expect(pruned.length).toBe(graph.length - 4);
	});
	it('returns a malformed graph unchanged', () => {
		const bad = [1, 2, 3] as unknown as BundleGraph;
		expect(pruneBundleGraph(bad)).toBe(bad);
		const dangling: BundleGraph = ['a.js', 99];
		expect(pruneBundleGraph(dangling)).toBe(dangling);
		expect(pruneBundleGraph([])).toEqual([]);
	});
});
