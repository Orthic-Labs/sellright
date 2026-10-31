// #425 step 3: Qwik's speculative preloader is off (entry.ssr.tsx `preloader: false`); this targeted warm graph replaces it.
// With the preloader on, every dd/rh page fetched 115-271 script bundles (650-980 KB); Damned's previous storefront measured the same
// switch (144 -> 55 script requests, no readiness loss, re-enabling it rejected: damned/docs/PERFORMANCE-2026-09-26/27.md). Like
// that storefront, after window load and an idle slot the browser modulepreloads (low priority, never executed) only the cart's render path
// and the current page's interactive closure; checkout code is warmed on intent (pointer/focus on a /checkout link). Event handlers
// still load on demand. Code only: no stock, price or session read is started here. #425 follow-up: no load/idle warming at all
// (see warmScript).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface ManifestSymbol { origin: string; displayName: string; ctxName: string; ctxKind: string }
interface Manifest { symbols: Record<string, ManifestSymbol>; mapping: Record<string, string>; bundles: Record<string, { imports?: string[] }> }

export type WarmGroup = 'cart' | 'home' | 'product' | 'checkout';

const RENDER_CTX = new Set(['component$', 'useTask$', 'useComputed$', 'useStyles$', '$']);
const isRender = (s: ManifestSymbol) => s.ctxKind !== 'eventHandler' && RENDER_CTX.has(s.ctxName);

const GROUPS: Record<WarmGroup, (s: ManifestSymbol) => boolean> = {
	cart: (s) =>
		(/^(components\/(cart|cart-contents|cart-totals|free-shipping-progress)\/|contexts\/CartContext\.tsx)/.test(s.origin) && isRender(s)) ||
		(s.displayName.endsWith('Link_component') && s.ctxName === 'component$'),
	home: (s) => /^(routes\/index\.tsx|components\/home\/|brand-slots\/route\.home|platform\/controllers\/configurator)/.test(s.origin) && isRender(s),
	product: (s) =>
		/^(routes\/products\/|routes\/shop\/\[slug\]\/|brand-slots\/route\.product|platform\/controllers\/(product|stock-read|configurator)|components\/reviews\/)/.test(s.origin) &&
		isRender(s),
	checkout: (s) =>
		/^(routes\/checkout\/index\.tsx|components\/(checkout|payment|address-form|billing-address-form|cart-totals|cart-contents)\/|contexts\/Checkout)/.test(s.origin) &&
		isRender(s),
};

/** Per group, the hashed /build/ files of the matching symbols plus their static imports. */
export function warmGroups(m: Manifest, base = '/build/'): Record<WarmGroup, string[]> {
	const out = {} as Record<WarmGroup, string[]>;
	for (const g of Object.keys(GROUPS) as WarmGroup[]) {
		const seen = new Set<string>();
		const add = (name: string | undefined) => {
			if (!name || seen.has(name)) return;
			seen.add(name);
			for (const dep of m.bundles[name]?.imports ?? []) add(dep);
		};
		for (const [hash, sym] of Object.entries(m.symbols)) if (GROUPS[g](sym)) add(m.mapping[hash]);
		out[g] = [...seen].sort().map((n) => base + n);
	}
	return out;
}

/** The inline warm script. #425: nothing is fetched at load or idle (warming the cart + page closures added ~150 requests per page,
 *  dd home 155 scripts vs 55 on the previous storefront). Code is fetched only on intent: the cart's render path on pointer/focus/touch
 *  on a cart control, the checkout closure on intent toward a /checkout link. Event handlers load on demand as always. Save-Data
 *  warms nothing. */
export function warmScript(groups: Record<WarmGroup, string[]>): string {
	return `(()=>{var g=${JSON.stringify({ cart: groups.cart, checkout: groups.checkout })},d={};function w(k){if(d[k])return;d[k]=1;var a=g[k]||[];for(var i=0;i<a.length;i++){var l=document.createElement('link');l.rel='modulepreload';l.href=a[i];document.head.appendChild(l)}}` +
		`function intent(e){if(navigator.connection&&navigator.connection.saveData)return;var t=e.target,c=t&&t.closest?t.closest('a[href],button'):null;if(!c)return;` +
		`var lab=((c.getAttribute('aria-label')||'')+' '+(c.getAttribute('title')||'')).toLowerCase();if(lab.indexOf('cart')>=0||lab.indexOf('bag')>=0)w('cart');` +
		`if(c.tagName==='A'){try{var u=new URL(c.href,location.href);if(u.origin===location.origin&&u.pathname.indexOf('/checkout')===0)w('checkout')}catch(x){}}}` +
		`['pointerover','focusin','touchstart'].forEach(function(t){document.addEventListener(t,intent,{capture:true,passive:true})})})()`;
}

/** The script for this build, from <distDir>/q-manifest.json (the runtime manifest strips symbol origins), or null. */
export function loadWarmScript(distDir: string | null): string | null {
	if (!distDir) return null;
	try {
		return warmScript(warmGroups(JSON.parse(readFileSync(join(distDir, 'q-manifest.json'), 'utf8')) as Manifest));
	} catch {
		return null;
	}
}
