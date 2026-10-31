// #425 step 3: Qwik's speculative preloader is off (entry.ssr.tsx `preloader: false`); this targeted warm graph replaces it.
// With the preloader on, every dd/rh page fetched 115-271 script bundles (650-980 KB); Damned's previous storefront measured the same
// switch (144 -> 55 script requests, no readiness loss, re-enabling it rejected: damned/docs/PERFORMANCE-2026-09-26/27.md). Like
// that storefront, after window load and an idle slot the browser modulepreloads (low priority, never executed) only the cart's render path
// and the current page's interactive closure; checkout code is warmed on intent (pointer/focus on a /checkout link). Event handlers
// still load on demand. Code only: no stock, price or session read is started here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface ManifestSymbol { origin: string; displayName: string; ctxName: string; ctxKind: string }
interface Manifest { symbols: Record<string, ManifestSymbol>; mapping: Record<string, string>; bundles: Record<string, { imports?: string[] }> }

export type WarmGroup = 'cart' | 'home' | 'product' | 'checkout';

// useVisibleTask$ counts as render code: the cart drawer's tasks (CartExpress, ExpressCheckout) run as it opens, and a cold
// task file put four serial ~0.75 s fetches on the add-to-cart click (#427, measured live 2026-11-01).
const RENDER_CTX = new Set(['component$', 'useTask$', 'useVisibleTask$', 'useComputed$', 'useStyles$', '$']);
const isRender = (s: ManifestSymbol) => s.ctxKind !== 'eventHandler' && RENDER_CTX.has(s.ctxName);
const PRODUCT = /^(routes\/products\/|routes\/shop\/\[slug\]\/|brand-slots\/route\.product|platform\/controllers\/(product|stock-read|configurator)|components\/reviews\/)/;

const GROUPS: Record<WarmGroup, (s: ManifestSymbol) => boolean> = {
	// Everything the drawer renders, not only components/cart: shared ui and icons (image, quantity, trash, check), the
	// express buttons, the cart service and the on-demand country read the add path awaits.
	cart: (s) =>
		(/^(components\/(cart|cart-contents|cart-totals|free-shipping-progress|ui|icons)\/|components\/checkout\/ExpressCheckout|contexts\/CartContext\.tsx|services\/CartService|utils\/addressStorage\.ts)/.test(
			s.origin,
		) &&
			isRender(s)) ||
		(s.displayName.endsWith('Link_component') && s.ctxName === 'component$'),
	home: (s) => /^(routes\/index\.tsx|components\/home\/|brand-slots\/route\.home|platform\/controllers\/configurator)/.test(s.origin) && isRender(s),
	// The product page's click handlers too (option pills, add to cart): the add-to-cart handler was itself a cold fetch.
	product: (s) => PRODUCT.test(s.origin) && (isRender(s) || s.ctxKind === 'eventHandler'),
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

/** The inline warm script. Home: `/`; product: /products/<slug>/ or /shop/<slug>/ (Rotten's PDP route). Save-Data warms nothing. */
export function warmScript(groups: Record<WarmGroup, string[]>): string {
	return `(()=>{var g=${JSON.stringify(groups)},d={};function w(k,low){if(d[k])return;d[k]=1;var a=g[k]||[];for(var i=0;i<a.length;i++){var l=document.createElement('link');l.rel='modulepreload';l.href=a[i];if(low)l.fetchPriority='low';document.head.appendChild(l)}}` +
		`function sd(){return!!(navigator.connection&&navigator.connection.saveData)}` +
		`function after(){var f=function(){if(sd())return;w('cart',1);var p=location.pathname;if(p==='/')w('home',1);else if(/^\\/(products|shop)\\/[^/]+\\/?$/.test(p))w('product',1)};'requestIdleCallback'in window?requestIdleCallback(f,{timeout:2000}):setTimeout(f,200)}` +
		`document.readyState==='complete'?after():addEventListener('load',after,{once:true});` +
		`function intent(e){if(sd())return;var t=e.target,a=t&&t.closest?t.closest('a[href]'):null;if(!a)return;try{var u=new URL(a.href,location.href);if(u.origin===location.origin&&u.pathname.indexOf('/checkout')===0)w('checkout')}catch(x){}}` +
		`['pointerover','focusin','pointerdown'].forEach(function(t){document.addEventListener(t,intent,{capture:true,passive:true})})})()`;
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
