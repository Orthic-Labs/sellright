// #427: group Qwik's per-symbol bundles into one bundle per page area, so a page start fetches a handful of files instead of
// ~100 tiny ones in serial waves (Damned's previous storefront: 55 on home; this build: 888 bundles, 775 under 3 KB).
// Qwik's `entryStrategy.manual` maps a symbol hash to a named entry; hashes come from a previous build's q-manifest.json and
// are stable for unchanged code (path + symbol name), so build-client.mjs builds, writes this map, and rebuilds when it moved.
// A symbol missing from the map (new code) keeps Qwik's own placement: the map only ever merges, never breaks a build.
import { readFileSync } from 'node:fs';

/** Area for a source origin (relative to src/), or null to leave the symbol where Qwik puts it. Order matters: first match wins. */
const AREAS = [
	['checkout', /^(routes\/checkout\/|components\/(checkout|payment|address-form|billing-address-form|verification)\/|components\/OrderProcessingModal|contexts\/Checkout)/],
	['cart', /^(components\/(cart|cart-contents|cart-totals|free-shipping-progress)\/|platform\/widgets\/|platform\/cart\.ts|platform\/gateway\/gate\.tsx)/],
	['product', /^(routes\/products\/|routes\/shop\/\[[^/]+\]\/|brand-slots\/(route\.product|pdp\.)|components\/reviews\/|platform\/(product|configurator|stock-read|content-review)|platform\/controllers\/(product|configurator|stock-read)|brand\/configurator\/)/],
	['home', /^(routes\/index\.tsx|brand-slots\/route\.home|components\/home\/|platform\/(home|home-spotlight)\b|platform\/controllers\/home)/],
	['shop', /^(routes\/(shop\/index|collections|search)|components\/(Filters|facet-filter-controls|filters-button|products)\b|platform\/shop\b|platform\/controllers\/shop)/],
	['blog', /^(routes\/blog|brand-slots\/route\.blog|platform\/blog\b)/],
	['account', /^(routes\/(account|sign-in|orders|forgot-password|password-reset|verify|affiliate)|components\/(auth|account|loyalty|order-tracking)\/)/],
	['shell', /^(root\.tsx|routes\/layout\.tsx|brand-slots\/(shell\.|legal\.)|components\/(header|footer|menu|head|icons|ui|buttons|modal)\/|contexts\/|hooks\/|brand\/|platform\/(stock-triggers|live-values|early-reads)\b|platform\/controllers\/shell)/],
];

export function areaOf(origin) {
	for (const [name, re] of AREAS) if (re.test(origin)) return name;
	return null;
}

/** symbol hash -> entry name, for every symbol whose origin has an area. */
export function chunkGroups(manifest) {
	const out = {};
	for (const s of Object.values(manifest.symbols)) {
		const a = areaOf(s.origin);
		if (a) out[s.hash] = `sr-${a}`;
	}
	return Object.fromEntries(Object.entries(out).sort(([x], [y]) => (x < y ? -1 : 1)));
}

// #427: plain source modules shared by several segments were split into ~190 files under 3 KB. `sharedGroup` names the one
// shared chunk they may join: a module joins only when every module it imports is outside src (Qwik, node_modules) or joins
// too, so the shared chunk never imports a chunk that imports it and no evaluation-order cycle can form (grouping every source
// module did: "k is not a function", 2026-11-01). Qwik segments stay with Qwik's map above. Route modules, brand slots and
// root.tsx stay out: the router loads them by dynamic import and grouping them left the home page's <main> empty on the client.
const SEGMENT = /\.[mc]?[jt]sx?_[^/]+\.js(\?|$)/;
// Virtual modules (NUL-prefixed ids, virtual:*) are NOT outside: brand slots and brand data import src, so they are walked like source.
const OUTSIDE = /node_modules|@qwik\.dev/;
const KEEP_OUT = /[\\/]src[\\/](routes|brand-slots)[\\/]|[\\/]src[\\/]root\.tsx/;

export function sharedGroup() {
	const memo = new Map();
	const closed = (id, ctx, stack) => {
		if (OUTSIDE.test(id)) return true;
		if (SEGMENT.test(id) || KEEP_OUT.test(id) || stack.has(id)) return false;
		const hit = memo.get(id);
		if (hit !== undefined) return hit;
		stack.add(id);
		const info = ctx.getModuleInfo(id);
		const ok = !!info && info.importedIds.every((d) => closed(d, ctx, stack));
		stack.delete(id);
		memo.set(id, ok);
		return ok;
	};
	return (id, ctx) => (!OUTSIDE.test(id) && /[\\/]src[\\/]/.test(id) && closed(id, ctx, new Set()) ? 'sr-shared' : null);
}

/** Area sets per module (#427): a shared chunk per set of page areas that reach a module, so a page loads only the shared
 *  code its areas use (one sr-shared chunk was 272 KB and loaded checkout code on the home page). Seeds: a Qwik segment's area
 *  from the symbol map or its source path, a route module's area, a non-segment entry is the shell. Areas flow down static
 *  imports to a fixpoint, so a module's set always contains its importers' sets: a chunk only imports chunks of supersets, and
 *  any set containing the shell (loaded on every page) or two or more areas is one class (supersets stay in it), so no chunk
 *  cycle can form. Measured on the Damned exp build against one shared chunk: home 218 -> 201 KB, product 251 -> 238 KB of
 *  script on the wire, +1-2 files; per-pair chunks added files for no byte gain. Returns id -> group name. */
export function areaSets(graph, symbolArea) {
	const ids = [...graph.ids];
	const areas = new Map(ids.map((id) => [id, new Set()]));
	for (const id of ids) {
		const info = graph.info(id);
		if (!info) continue;
		const seg = info.meta?.segment;
		const rel = (id.match(/[\\/]src[\\/](.*)$/) ?? [])[1]?.replace(/\\/g, '/');
		const a = seg ? (symbolArea[seg.hash]?.replace(/^sr-/, '') ?? (rel && areaOf(rel)) ?? 'x') : KEEP_OUT.test(id) ? ((rel && areaOf(rel)) ?? 'shell') : info.isEntry ? 'shell' : null;
		if (a) areas.get(id).add(a);
	}
	for (let changed = true; changed; ) {
		changed = false;
		for (const id of ids) {
			const from = areas.get(id);
			if (!from.size) continue;
			for (const d of graph.info(id)?.importedIds ?? []) {
				const to = areas.get(d);
				if (!to) continue;
				for (const a of from) if (!to.has(a)) { to.add(a); changed = true; }
			}
		}
	}
	const out = new Map();
	for (const [id, set] of areas) out.set(id, !set.size ? 'sr-x' : set.has('shell') || set.size >= 2 ? 'sr-shell' : 'sr-' + [...set].sort().join('-'));
	return out;
}

/** sharedGroup with area-set names: `sets` is filled by the build (areaSets over the module graph) before chunking. */
export function sharedAreaGroup(sets) {
	const closed = sharedGroup();
	return (id, ctx) => (closed(id, ctx) ? (sets.get(id) ?? 'sr-x') : null);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const m = JSON.parse(readFileSync(process.argv[2], 'utf8'));
	process.stdout.write(JSON.stringify(chunkGroups(m), null, 1) + '\n');
}
