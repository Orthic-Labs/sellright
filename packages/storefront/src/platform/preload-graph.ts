// P7/V30: trims the Qwik preloader's bundle graph so a page preloads what it renders, not the whole app.
//
// Qwik 2.0.0-rc.3's preloader (node_modules/@qwik.dev/core/dist/preloader.mjs) walks bundle-graph.json from every bundle
// the page references (its SSR event handlers, visible <Link> routes, every QRL resumed) and queues each bundle it
// reaches with a probability >= 1%. There is no probability cut-off option in rc.3: `preloader` (server.d.ts
// PreloaderOptions) only has `ssrPreloads` (SSR <link> count, default 0) and `maxIdlePreloads` (how many preloads run
// AT ONCE, default 25 — not how many in total). The optimizer (optimizer.mjs, bundle-graph conversion) gives every
// lazy QRL import ("dynamic import") a 0.5–0.99 probability, so chains of them reach most of the app: measured on
// rottenhand.com home 2026-10-30, ~410 bundles / ~355KiB brotli after window load.
//
// This drops the dynamic-import edges OUT OF JS BUNDLES. What stays:
// - static imports of a bundle (probability 1: the code needed to run it),
// - the edges of non-JS keys: route names (a visible <Link> preloads that route's own bundles + their static imports)
//   and symbol names (a QRL that just ran preloads its bundle).
// A lazy QRL that is not referenced by the page loads when it is first used (the router/core still request a 0.8
// preload for every QRL as it is created on the client). Measured with the rc.3 preloader logic on the live graph:
// rottenhand.com home ~112 bundles / ~195KiB brotli, PDP ~136, damneddesigns.com home ~96.
//
// Node only; loaded from vite.config.ts, never bundled into the app.
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/** The optimizer's flat graph: a name, then its dependency indexes; a negative number is "the following dependencies are
 *  dynamic with probability -n/10" (static imports come first, before any marker). */
export type BundleGraph = Array<string | number>;

const JS_BUNDLE = /\.[mc]?js$/;

/** Drop dynamic-import edges out of JS bundles; keep static imports and every edge of route / symbol keys. Indexes are
 *  rewritten for the shorter array. Pure; an input that is not a well-formed graph is returned unchanged. */
export function pruneBundleGraph(graph: BundleGraph): BundleGraph {
	if (!Array.isArray(graph) || graph.length === 0 || typeof graph[0] !== 'string') return graph;
	const entries: { name: string; deps: number[]; at: number }[] = [];
	for (let i = 0; i < graph.length; ) {
		const name = graph[i];
		if (typeof name !== 'string') return graph;
		const at = i++;
		const deps: number[] = [];
		while (i < graph.length && typeof graph[i] === 'number') deps.push(graph[i++] as number);
		entries.push({ name, deps, at });
	}
	const kept = entries.map(({ name, deps }) => {
		if (!JS_BUNDLE.test(name)) return deps;
		const end = deps.findIndex((d) => d < 0);
		return end === -1 ? deps : deps.slice(0, end);
	});
	const moved = new Map<number, number>();
	let pos = 0;
	entries.forEach((e, k) => {
		moved.set(e.at, pos);
		pos += 1 + kept[k].length;
	});
	const out: BundleGraph = [];
	for (let k = 0; k < entries.length; k++) {
		out.push(entries[k].name);
		for (const d of kept[k]) {
			if (d < 0) { out.push(d); continue; }
			const to = moved.get(d);
			if (to === undefined) return graph;
			out.push(to);
		}
	}
	return out;
}

/** Rewrites the client build's bundle-graph-*.json after it is written (before vite-plugin-compression's closeBundle
 *  makes the .gz/.br from disk). The file name — referenced by q-manifest.json and the SSR preloader script — is kept. */
export function preloadGraphPlugin(): Plugin {
	return {
		name: 'sellright-preload-graph',
		apply: 'build',
		enforce: 'post',
		writeBundle(options, bundle) {
			const dir = options.dir;
			if (!dir) return;
			for (const [fileName, out] of Object.entries(bundle)) {
				if (out.type !== 'asset' || !/(^|\/)bundle-graph-[^/]*\.json$/.test(fileName)) continue;
				const file = path.join(dir, fileName);
				const graph = JSON.parse(fs.readFileSync(file, 'utf8')) as BundleGraph;
				const pruned = pruneBundleGraph(graph);
				fs.writeFileSync(file, JSON.stringify(pruned));
				this.info?.(`preload graph ${fileName}: ${graph.length} -> ${pruned.length} entries (dynamic edges of JS bundles dropped)`);
			}
		},
	};
}
