// The product page's <meta name="description">, ported from the previous the previous platform store (routes/products/[...slug]/index.tsx head): the
// description as plain text with the raw SPECS dump dropped, cut at a word near 160 characters; a thin or empty description gets a plain,
// factual lead-in from the product name, its category tag and the store name (no adjectives or marketing claims).
import { stripTags } from '~/utils/product-specs';

/** Category tag (lowercased) -> the noun phrase used in the thin-description fallback. */
const CATEGORY_PHRASE: Record<string, string> = {
	'folding knives': 'EDC folding knife',
	'fixed blades': 'EDC fixed blade',
	edc: 'EDC bead',
	apparel: 'apparel',
	fidget: 'EDC fidget',
};

const ENTITIES: Record<string, string> = { '&nbsp;': ' ', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&amp;': '&' };

/** Catalog HTML as one line of plain text with the SPECS block removed and typographic quotes made plain. */
export function plainMetaText(html: string | null | undefined): string {
	return stripTags((html ?? '').replace(/<\s*br\s*\/?\s*>/gi, ' ').replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, ' ').replace(/<[^<>]*>/g, ' '))
		.replace(/&(nbsp|quot|#39|apos|amp);/g, (m) => ENTITIES[m] ?? m)
		.replace(/\bSPECS?\b[\s\S]*$/i, '')
		.replace(/[“”]/g, '"')
		.replace(/[‘’]/g, "'")
		.replace(/\s+/g, ' ')
		.trim();
}

export function productMetaDescription(product: { name?: string | null; description?: string | null; tags?: readonly string[] | null } | null | undefined, storeName: string): string {
	const raw = plainMetaText(product?.description);
	const name = product?.name || 'Product';
	if (raw.length >= 70) {
		if (raw.length <= 160) return raw;
		const truncated = raw.substring(0, 160);
		const lastSpace = truncated.lastIndexOf(' ');
		return (lastSpace > 80 ? truncated.substring(0, lastSpace) : truncated).replace(/[.,;:!?\s]+$/, '') + '…';
	}
	const tags = (product?.tags ?? []).map((t) => t.toLowerCase());
	const category = tags.find((t) => CATEGORY_PHRASE[t]);
	const kind = (category && CATEGORY_PHRASE[category]) || tags[0] || null;
	const lead = raw ? `${raw.replace(/[.\s]+$/, '')}. ` : '';
	return `${name} — ${lead}${kind ? `${kind} from` : 'Available from'} ${storeName}.`.slice(0, 160);
}
