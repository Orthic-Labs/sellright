// The base product page's related row (routes.json productPage.related). Catalog metadata only: the listing's own snapshot (never its live
// fallback) with the listing's `inStock`, the same layer-2 source as the shop grid; the row never reads stock itself. Same category (the
// first tag), the current product excluded. An in-stock product shows up to four of its category, in-stock first then by price; a sold-out
// one shows up to four in-stock products (its category first) under "In stock now", or its category when nothing is in stock.
import { productPath } from '~/platform/product-path';
import type { CatalogListItem } from '~/sellright/types/catalog';

export interface RelatedCard {
	slug: string;
	name: string;
	href: string;
	image: string | null;
	priceCents: number;
	inStock: boolean;
}
export interface RelatedRow {
	heading: '' | 'You may also like' | 'In stock now';
	items: RelatedCard[];
}

const EMPTY: RelatedRow = { heading: '', items: [] };
const categoryOf = (p: CatalogListItem) => (p.tags ?? [])[0] ?? null;
const priceOf = (p: CatalogListItem) => p.minPrice ?? 0;
const toCard = (p: CatalogListItem): RelatedCard => ({ slug: p.slug, name: p.name, href: productPath(p.slug), image: p.image ?? null, priceCents: priceOf(p), inStock: p.inStock === true });

export function relatedRow(products: readonly CatalogListItem[], slug: string, limit = 4): RelatedRow {
	const current = products.find((p) => p.slug === slug);
	if (!current) return EMPTY;
	const category = categoryOf(current);
	const others = products.filter((p) => p.slug !== slug);
	const byPrice = (a: CatalogListItem, b: CatalogListItem) => priceOf(a) - priceOf(b);
	if (current.inStock !== true) {
		const inStock = others.filter((p) => p.inStock === true);
		const same = inStock.filter((p) => categoryOf(p) === category).sort(byPrice);
		const rest = inStock.filter((p) => categoryOf(p) !== category).sort(byPrice);
		const items = [...same, ...rest].slice(0, limit).map(toCard);
		if (items.length > 0) return { heading: 'In stock now', items };
		const fallback = others.filter((p) => categoryOf(p) === category).sort(byPrice).slice(0, limit).map(toCard);
		return { heading: fallback.length ? 'You may also like' : '', items: fallback };
	}
	const items = others
		.filter((p) => categoryOf(p) === category)
		.sort((a, b) => Number(b.inStock === true) - Number(a.inStock === true) || byPrice(a, b))
		.slice(0, limit)
		.map(toCard);
	return { heading: items.length ? 'You may also like' : '', items };
}

