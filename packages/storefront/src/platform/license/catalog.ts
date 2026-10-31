import { getCollection, getProduct, type VariantDetail } from './api';

export interface PricedProduct { slug: string; name: string; description: string | null; variants: VariantDetail[] }

/**
 * A variant's license catalog: its collection, then each product's detail (variants, prices). Physical variants are left out:
 * this flow has no stock or shipping, so it never offers one (checkout refuses them too); a product left without variants is dropped.
 */
export async function loadCatalog(collection: string): Promise<PricedProduct[]> {
	const feed = await getCollection(collection);
	const products = await Promise.all(
		feed.products.map(async (p) => {
			const detail = await getProduct(p.slug);
			return { slug: detail.slug, name: detail.name, description: detail.description, variants: sellableVariants(detail.variants) };
		}),
	);
	return products.filter((p) => p.variants.length > 0);
}

export const sellableVariants = (variants: readonly VariantDetail[]): VariantDetail[] => variants.filter((v) => v.fulfillmentType !== 'physical');

/** ADR-0001 §3: the catalog for a cacheable shell: names and SKUs kept, every price removed (the browser reads them, no-store). */
export const redactCatalogPrices = (catalog: readonly PricedProduct[]): PricedProduct[] =>
	catalog.map((p) => ({ ...p, variants: p.variants.map((v) => ({ ...v, price: 0, salePrice: null, compareAtPrice: null })) }));
