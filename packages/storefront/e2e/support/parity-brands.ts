/**
 * Brand parameterisation of the stock parity suite (plan A9: "base first; Rotten and staged Damned per A8; later the
 * composed brands"). The runner picks one with STOCK_PARITY_BRAND (default `base`). Only `base` is defined: the other
 * brands' routes and triggers are characterised by A8 on a Rotten legacy scratch (A5b/A7) and staged Damned (owner
 * decision O4), neither of which this task could provision. Adding a brand = adding an entry here with the routes it
 * really has (Rotten: purchasing route is /shop/[slug], no /products/ route; its trigger is the mount-time resource).
 */
export interface ParityBrand {
	/** Product purchasing route for a slug. */
	pdpPath(slug: string): string;
	shopPath: string;
	checkoutPath: string;
	/** What starts the PDP live-stock request: base `qidle`; Damned `qinit` (approved amendment 2026-09-26); Rotten: mount. */
	pdpTrigger: 'qidle' | 'qinit' | 'mount';
}

const BRANDS: Record<string, ParityBrand> = {
	base: {
		pdpPath: (slug) => `/products/${slug}/`,
		shopPath: '/shop/',
		checkoutPath: '/checkout/',
		pdpTrigger: 'qidle',
	},
};

const name = process.env.STOCK_PARITY_BRAND ?? 'base';
if (!BRANDS[name]) throw new Error(`STOCK_PARITY_BRAND=${name}: no such brand configured (have: ${Object.keys(BRANDS).join(', ')}); Rotten and staged Damned are not defined yet (A7/A8, O4)`);
export const brand: ParityBrand = BRANDS[name]!;
