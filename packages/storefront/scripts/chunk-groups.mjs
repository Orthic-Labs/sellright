// #427: group Qwik's per-symbol bundles into one bundle per page area, so a page start fetches a handful of files instead of
// ~100 tiny ones in serial waves (Damned's previous storefront: 55 on home; this build: 888 bundles, 775 under 3 KB).
// Qwik's `entryStrategy.manual` maps a symbol hash to a named entry; hashes come from a previous build's q-manifest.json and
// are stable for unchanged code (path + symbol name), so build-client.mjs builds, writes this map, and rebuilds when it moved.
// A symbol missing from the map (new code) keeps Qwik's own placement: the map only ever merges, never breaks a build.
import { readFileSync } from 'node:fs';

/** Area for a source origin (relative to src/), or null to leave the symbol where Qwik puts it. Order matters: first match wins. */
const AREAS = [
	['checkout', /^(routes\/checkout\/|components\/(checkout|payment|address-form|billing-address-form|verification)\/|components\/OrderProcessingModal|contexts\/Checkout)/],
	['cart', /^(components\/(cart|cart-contents|cart-totals|free-shipping-progress)\/|platform\/widgets\/)/],
	['product', /^(routes\/products\/|routes\/shop\/\[[^/]+\]\/|brand-slots\/(route\.product|pdp\.)|components\/reviews\/|platform\/(product|configurator|stock-read|content-review)|platform\/controllers\/(product|configurator|stock-read))/],
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
const OUTSIDE = /node_modules|@qwik\.dev|^\0/;
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

if (import.meta.url === `file://${process.argv[1]}`) {
	const m = JSON.parse(readFileSync(process.argv[2], 'utf8'));
	process.stdout.write(JSON.stringify(chunkGroups(m), null, 1) + '\n');
}
