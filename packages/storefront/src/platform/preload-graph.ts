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
// A lazy QRL that is not referenced by the page loads when it is first used. Measured with the rc.3 preloader logic on
// the live graph: rottenhand.com home ~112 bundles / ~195KiB brotli, PDP ~136, damneddesigns.com home ~96.
//
// L10: the exception is checkout. Its order summary, address forms and cart totals render on the client after the first
// pricing read, and QRLs created by client code (`qrl(() => import('./q-x.js'), 's_…')`) have no chunk name, so core
// never calls the preloader for them (core.mjs LazyRef: requestPreload only when `$chunk$` is set). Each component
// wrapper module then import()s its segment, the browser discovers that segment's static imports only after fetching
// it, and the renderer resolves components in tree order — so with the dynamic edges gone the page fetched ~55 bundles
// one after another (150ms RTT: 1.9s -> 5.6s, LCP 5.66s, CLS from the late summary). Checkout-only bundles therefore get
// one flat dynamic edge to every bundle of their checkout closure (`checkoutClosure`): the walk follows static and
// dynamic edges but expands only bundles whose sources are all checkout-path code, so shared bundles (cart drawer,
// header) keep their pruned edges and home/shop/PDP preload the same set as before.
//
// Node only; loaded from vite.config.ts, never bundled into the app.
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/** The optimizer's flat graph: a name, then its dependency indexes; a negative number is "the following dependencies are
 *  dynamic with probability -n/10" (static imports come first, before any marker). */
export type BundleGraph = Array<string | number>;

const JS_BUNDLE = /\.[mc]?js$/;

/** A bundle-local closure that keeps its dynamic edges, flattened onto the bundles that open it. */
export interface KeptClosure {
	/** Source modules (paths relative to the package root) of a bundle, or undefined when unknown. */
	origins: (bundle: string) => readonly string[] | undefined;
	/** A bundle all of whose sources match opens the closure: it gets a dynamic edge to every bundle the walk reaches. */
	anchor: RegExp;
	/** The walk expands a reached bundle (follows its edges) only when all of its sources match this or `anchor`. */
	region: RegExp;
	/** Import probability (0.1–1) of the added edges. */
	probability: number;
}

// Checkout routes (both commerce flows) and checkout-only components open the closure; the components and hooks the
// checkout renders on the client after its pricing read (address/billing forms, cart contents/totals, loyalty hint,
// stock warning, lazy image, checkout/cart contexts, useCheckout) are expanded. Measured on the fa0a2c4f demo build:
// checkout 124 -> 246 preloaded bundles (53 of the 54 waterfall bundles), home/shop/PDP unchanged (91/93/108).
export const CHECKOUT_ANCHOR = /^src\/(?:routes\/checkout\/|platform\/license\/routes\/checkout\/|components\/checkout\/)/;
export const CHECKOUT_REGION = new RegExp(
	`^src/(?:components/(?:address-form|billing-address-form|cart-contents|cart-totals|cart|loyalty)/|components/ui/LazyImage\\.tsx|hooks/(?:useCheckout|zero-due)\\.ts|platform/controllers/cart-props\\.ts|contexts/)`,
);

const allMatch = (origins: readonly string[] | undefined, ...res: RegExp[]) =>
	!!origins && origins.length > 0 && origins.every((o) => res.some((re) => re.test(o)));

/** Drop dynamic-import edges out of JS bundles; keep static imports and every edge of route / symbol keys. With
 *  `closure`, anchor bundles also get one dynamic edge (marker -probability*10) to each bundle of their closure, in walk
 *  order. Indexes are rewritten for the new array. Pure; an input that is not a well-formed graph is returned unchanged. */
export function pruneBundleGraph(graph: BundleGraph, closure?: KeptClosure): BundleGraph {
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
	const byAt = new Map<number, number>();
	entries.forEach((e, k) => byAt.set(e.at, k));
	for (const e of entries) for (const d of e.deps) if (d >= 0 && !byAt.has(d)) return graph;
	const kept = entries.map(({ name, deps }) => {
		if (!JS_BUNDLE.test(name)) return deps;
		const end = deps.findIndex((d) => d < 0);
		return end === -1 ? deps : deps.slice(0, end);
	});
	if (closure) {
		const marker = -Math.min(10, Math.max(1, Math.round(closure.probability * 10)));
		const expands = (k: number) => allMatch(closure.origins(entries[k].name), closure.anchor, closure.region);
		entries.forEach((e, k) => {
			if (!JS_BUNDLE.test(e.name) || !allMatch(closure.origins(e.name), closure.anchor)) return;
			const reached = new Set<number>([k]);
			const queue = [k];
			const added: number[] = [];
			while (queue.length) {
				const x = queue.shift() as number;
				if (x !== k && !expands(x)) continue;
				for (const d of entries[x].deps) {
					if (d < 0) continue;
					const y = byAt.get(d) as number;
					if (reached.has(y) || !JS_BUNDLE.test(entries[y].name)) continue;
					reached.add(y);
					queue.push(y);
					added.push(d);
				}
			}
			const own = new Set(kept[k]);
			const extra = added.filter((d) => !own.has(d));
			if (extra.length) kept[k] = [...kept[k], marker, ...extra];
		});
	}
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
 *  makes the .gz/.br from disk). The file name — referenced by q-manifest.json and the SSR preloader script — is kept.
 *  Bundle sources come from the chunks' module ids, relative to the Vite root (`src/...`, as in q-manifest origins). */
export function preloadGraphPlugin(): Plugin {
	let root = process.cwd();
	return {
		name: 'sellright-preload-graph',
		apply: 'build',
		enforce: 'post',
		configResolved(config) {
			root = config.root;
		},
		writeBundle(options, bundle) {
			const dir = options.dir;
			if (!dir) return;
			const origins = new Map<string, string[]>();
			for (const out of Object.values(bundle)) {
				if (out.type !== 'chunk') continue;
				const ids = out.moduleIds.map((id) => path.relative(root, id.replace(/^\0/, '').split('?')[0]).split(path.sep).join('/'));
				origins.set(path.posix.basename(out.fileName), ids);
			}
			for (const [fileName, out] of Object.entries(bundle)) {
				if (out.type !== 'asset' || !/(^|\/)bundle-graph-[^/]*\.json$/.test(fileName)) continue;
				const file = path.join(dir, fileName);
				const graph = JSON.parse(fs.readFileSync(file, 'utf8')) as BundleGraph;
				const pruned = pruneBundleGraph(graph, {
					origins: (name) => origins.get(name),
					anchor: CHECKOUT_ANCHOR,
					region: CHECKOUT_REGION,
					probability: 0.8,
				});
				fs.writeFileSync(file, JSON.stringify(pruned));
				this.info?.(`preload graph ${fileName}: ${graph.length} -> ${pruned.length} entries (dynamic edges of JS bundles dropped; checkout closure flattened)`);
			}
		},
	};
}
