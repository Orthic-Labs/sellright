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

if (import.meta.url === `file://${process.argv[1]}`) {
	const m = JSON.parse(readFileSync(process.argv[2], 'utf8'));
	process.stdout.write(JSON.stringify(chunkGroups(m), null, 1) + '\n');
}
