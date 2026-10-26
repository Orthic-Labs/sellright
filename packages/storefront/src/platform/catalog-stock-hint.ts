// #382: the product-level in-stock hint for a PDP's first paint. The publisher stamps `inStock` on products/<slug>.json from
// release 9eba89c2 onward; generations written before that carry it only in products-v2/<slug>.json. Every manifest path reads both
// files from the SAME generation and takes v1's flag, else v2's. A hint only: the live stock read stays authoritative.
export const v1DetailFile = (slug: string): string => `products/${slug}.json`;
export const v2DetailFile = (slug: string): string => `products-v2/${slug}.json`;

const flag = (file: unknown): boolean | null => {
	const v = file && typeof file === 'object' ? (file as { inStock?: unknown }).inStock : undefined;
	return typeof v === 'boolean' ? v : null;
};

/** v1's `inStock`, else v2's, else null (unknown: first paint waits for the live read). */
export const catalogInStockOf = (v1: unknown, v2: unknown): boolean | null => flag(v1) ?? flag(v2);
