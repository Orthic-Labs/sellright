// #425 step 3: Qwik's speculative preloader is off (entry.ssr.tsx `preloader: false`); this targeted warm graph replaces it.
// With the preloader on, every dd/rh page fetched 115-271 script bundles (650-980 KB); Damned's previous storefront measured the same
// switch (144 -> 55 script requests, no readiness loss, re-enabling it rejected: damned/docs/PERFORMANCE-2026-09-26/27.md). Like
// that storefront, after window load and an idle slot the browser modulepreloads (low priority, never executed) only the page's own
// closure (home, product). The cart's render path (~45 files; #427: warmed on every page it was most of home's 70 script files and
// put a product page at 92 against the previous storefront's 79) warms on intent: hover, focus or touch on a button labelled cart
// or bag (header cart, add to cart), or a product page's first touch or press (an option pick or a scroll comes before the add).
// Checkout's code warms on intent: a link to /checkout or an element marked
// data-warm="checkout" (the cart's Checkout button; #427: warming it on every page load cost ~100 script files). A product link
// warms the product page's code the same way (shop -> product ran ~6 serial ~0.3 s fetch waves live). Event handlers
// still load on demand. Code only: no stock, price or session read is started here. Save-Data skips the after-load warm only:
// intent is the shopper asking for that code now, so it warms either way. The checkout page warms its own closure after load.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface ManifestSymbol { origin: string; displayName: string; ctxName: string; ctxKind: string }
interface Manifest { symbols: Record<string, ManifestSymbol>; mapping: Record<string, string>; bundles: Record<string, { imports?: string[] }> }

export type WarmGroup = 'cart' | 'home' | 'product' | 'checkout';

// useVisibleTask$ counts as render code: the cart drawer's tasks (CartExpress, ExpressCheckout) run as it opens, and a cold
// task file put four serial ~0.75 s fetches on the add-to-cart click (#427, measured live 2026-11-01).
const RENDER_CTX = new Set(['component$', 'useTask$', 'useVisibleTask$', 'useComputed$', 'useStyles$', '$']);
const isRender = (s: ManifestSymbol) => s.ctxKind !== 'eventHandler' && RENDER_CTX.has(s.ctxName);
// brand/configurator: a brand's own configurator view (Rotten's overlay), whose add-to-cart click was a cold ~0.7 s fetch.
const PRODUCT = /^(routes\/products\/|routes\/shop\/\[slug\]\/|brand-slots\/route\.product|platform\/controllers\/(product|stock-read|configurator)|components\/reviews\/|brand\/configurator\/)/;

const GROUPS: Record<WarmGroup, (s: ManifestSymbol, brandHome: boolean) => boolean> = {
	// The cart toggle's own functions (platform/cart.ts useCartToggle, gateway bindAction) were two serial ~0.3 s fetches
	// after the drawer code had warmed on the header cart hover (#427, live 2026-11-01).
	// Everything the drawer renders, not only components/cart: shared ui and icons (image, quantity, trash, check), the
	// express buttons, the cart service and the on-demand country read the add path awaits.
	cart: (s) =>
		(/^(components\/(cart|cart-contents|cart-totals|free-shipping-progress|ui|icons)\/|components\/checkout\/ExpressCheckout|contexts\/CartContext\.tsx|services\/CartService|utils\/addressStorage\.ts|platform\/cart\.ts|platform\/gateway\/gate\.tsx)/.test(
			s.origin,
		) &&
			isRender(s)) ||
		(s.displayName.endsWith('Link_component') && s.ctxName === 'component$'),
	// A brand home view's live parts are *Island components (#427): only they re-render after load, so only they and their click handlers
	// warm. The core home page (routes/index, components/home) warms only in a build without a brand home view: with one it never renders.
	home: (s, brandHome) =>
		(!brandHome && /^(routes\/index\.tsx|components\/home\/)/.test(s.origin) && isRender(s)) ||
		(/^platform\/controllers\/configurator/.test(s.origin) && isRender(s)) ||
		(/^brand-slots\/route\.home/.test(s.origin) && /(^|_)[A-Z][A-Za-z0-9]*Island_/.test(s.displayName) && (isRender(s) || s.ctxKind === 'eventHandler')),
	// The product page's click handlers too (option pills, add to cart): the add-to-cart handler was itself a cold fetch.
	product: (s) => PRODUCT.test(s.origin) && (isRender(s) || s.ctxKind === 'eventHandler'),
	checkout: (s) =>
		/^(routes\/checkout\/index\.tsx|components\/(checkout|payment|address-form|billing-address-form|cart-totals|cart-contents)\/|contexts\/Checkout)/.test(s.origin) &&
		isRender(s),
};

/** Per group, the hashed /build/ files of the matching symbols plus their static imports. */
export function warmGroups(m: Manifest, base = '/build/'): Record<WarmGroup, string[]> {
	const out = {} as Record<WarmGroup, string[]>;
	const brandHome = Object.values(m.symbols).some((s) => s.origin.startsWith('brand-slots/route.home'));
	for (const g of Object.keys(GROUPS) as WarmGroup[]) {
		const seen = new Set<string>();
		const add = (name: string | undefined) => {
			if (!name || seen.has(name)) return;
			seen.add(name);
			for (const dep of m.bundles[name]?.imports ?? []) add(dep);
		};
		for (const [hash, sym] of Object.entries(m.symbols)) if (GROUPS[g](sym, brandHome)) add(m.mapping[hash]);
		out[g] = [...seen].sort().map((n) => base + n);
	}
	return out;
}

/** The inline warm script. Home: `/`; product: /products/<slug>/ or /shop/<slug>/ (Rotten's PDP route). Save-Data warms nothing. */
export function warmScript(groups: Record<WarmGroup, string[]>): string {
	return `(()=>{var g=${JSON.stringify(groups)},d={};function w(k,low){if(d[k])return;d[k]=1;var a=g[k]||[];for(var i=0;i<a.length;i++){var l=document.createElement('link');l.rel='modulepreload';l.href=a[i];if(low)l.fetchPriority='low';document.head.appendChild(l)}}` +
		`function sd(){return!!(navigator.connection&&navigator.connection.saveData)}` +
		`function after(){var f=function(){if(sd())return;var p=location.pathname;if(p==='/')w('home',1);else if(p.indexOf('/checkout')===0)w('checkout',1);else if(/^\\/(products|shop)\\/[^/]+\\/?$/.test(p))w('product',1)};'requestIdleCallback'in window?requestIdleCallback(f,{timeout:2000}):setTimeout(f,200)}` +
		`document.readyState==='complete'?after():addEventListener('load',after,{once:true});` +
		`function intent(e){if((e.type==='pointerdown'||e.type==='touchstart')&&/^\\/(products|shop)\\/[^/]+\\/?$/.test(location.pathname))w('cart');var t=e.target,b=t&&t.closest?t.closest('button'):null;if(b&&/cart|bag/i.test((b.getAttribute('aria-label')||'')+' '+b.textContent))w('cart');var a=t&&t.closest?t.closest('a[href],[data-warm]'):null;if(!a)return;var k=a.getAttribute('data-warm');if(k){w(k);return}try{var u=new URL(a.href,location.href);if(u.origin!==location.origin)return;if(u.pathname.indexOf('/checkout')===0)w('checkout');else if(/^\\/(products|shop)\\/[^/]+\\/?$/.test(u.pathname))w('product')}catch(x){}}` +
		`['pointerover','focusin','pointerdown','touchstart'].forEach(function(t){document.addEventListener(t,intent,{capture:true,passive:true})})})()`;
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
