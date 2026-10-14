// The base product page's related row (routes.json productPage.related). Catalog metadata only, from the listing's own snapshot (never its
// live fallback): same category (the first tag), the current product excluded, by price, up to four. The row carries NO availability: a
// snapshot's inStock is not live stock, so a related card never says in stock or sold out (each product page reads its own live stock).
import { productPath } from '~/platform/product-path';
import type { CatalogListItem } from '~/sellright/types/catalog';

export interface RelatedCard {
	slug: string;
	name: string;
	href: string;
	image: string | null;
	priceCents: number;
}
export interface RelatedRow {
	heading: '' | 'You may also like';
	items: RelatedCard[];
}

const EMPTY: RelatedRow = { heading: '', items: [] };
const categoryOf = (p: CatalogListItem) => (p.tags ?? [])[0] ?? null;
const priceOf = (p: CatalogListItem) => p.minPrice ?? 0;
const toCard = (p: CatalogListItem): RelatedCard => ({ slug: p.slug, name: p.name, href: productPath(p.slug), image: p.image ?? null, priceCents: priceOf(p) });

export function relatedRow(products: readonly CatalogListItem[], slug: string, limit = 4): RelatedRow {
	const current = products.find((p) => p.slug === slug);
	if (!current) return EMPTY;
	const category = categoryOf(current);
	const items = products
		.filter((p) => p.slug !== slug && categoryOf(p) === category)
		.sort((a, b) => priceOf(a) - priceOf(b) || a.slug.localeCompare(b.slug))
		.slice(0, limit)
		.map(toCard);
	return { heading: items.length ? 'You may also like' : '', items };
}
