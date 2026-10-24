/**
 * Customer- and staff-facing name of an order line (#346): "Product · Variant", e.g.
 * "Short Sleeve Button-Up Shirt · Medium · Midnight black". Pure.
 *
 * order_line.variant_name is the variant snapshot ("Medium - Midnight black"); order_line.product_name is the product
 * snapshot set by the 0111 trigger. Imported lines (order import) carry no product_name and already name the product inside
 * variant_name ("Necro bead - Ultem"), so they are shown as they are. A variant named like its product (single-variant
 * products) shows the product name once. Option separators " - " become " · ", the separator the storefront uses;
 * hyphens inside words ("Button-Up") are untouched.
 */
export type LineNames = { productName?: string | null; variantName: string };

const OPTION_SEPARATOR = /\s*-\s+/;

/** The variant part on its own (no product prefix), with options joined by " · "; '' when it adds nothing. */
export function variantLabel(names: LineNames): string {
  const product = names.productName?.trim() ?? '';
  let variant = names.variantName.trim();
  if (product && variant.toLowerCase().startsWith(product.toLowerCase())) variant = variant.slice(product.length).replace(/^[\s\-–·/|,:]+/, '');
  return variant.split(OPTION_SEPARATOR).map((part) => part.trim()).filter(Boolean).join(' · ');
}

export function orderLineLabel(names: LineNames): string {
  const product = names.productName?.trim() ?? '';
  if (!product) return names.variantName;
  // The variant name already names the product (imported lines, "Widget One"): it reads as it is.
  if (names.variantName.trim().toLowerCase() !== product.toLowerCase() && names.variantName.trim().toLowerCase().startsWith(product.toLowerCase())) return names.variantName;
  const variant = variantLabel(names);
  return variant ? `${product} · ${variant}` : product;
}
