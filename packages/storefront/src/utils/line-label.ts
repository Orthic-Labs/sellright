/**
 * Order-line naming (#346), mirroring packages/api/src/orders/line-label.ts: an order line has a variant snapshot
 * (`name`, e.g. "Medium - Midnight black") and a product snapshot (`productName`). Imported lines carry the product
 * inside the variant name and have no productName. Option separators " - " show as " · "; hyphens inside words stay.
 */
export type LineNames = { productName?: string | null; variantName: string };

const OPTION_SEPARATOR = /\s*-\s+/;

/** The variant part on its own (no product prefix), options joined by " · "; '' when it adds nothing. */
export function variantLabel(names: LineNames): string {
	const product = names.productName?.trim() ?? '';
	let variant = names.variantName.trim();
	if (product && variant.toLowerCase().startsWith(product.toLowerCase())) variant = variant.slice(product.length).replace(/^[\s\-–·/|,:]+/, '');
	return variant.split(OPTION_SEPARATOR).map((part) => part.trim()).filter(Boolean).join(' · ');
}

/** "Product · Variant", or the variant name as it is when no product snapshot exists. */
export function orderLineLabel(names: LineNames): string {
	const product = names.productName?.trim() ?? '';
	if (!product) return names.variantName;
	// The variant name already names the product (imported lines, "Widget One"): it reads as it is.
	if (names.variantName.trim().toLowerCase() !== product.toLowerCase() && names.variantName.trim().toLowerCase().startsWith(product.toLowerCase())) return names.variantName;
	const variant = variantLabel(names);
	return variant ? `${product} · ${variant}` : product;
}
