import { getCollection, getProduct, type VariantDetail } from './api';

export interface PricedProduct { slug: string; name: string; description: string | null; variants: VariantDetail[] }

/** A variant's license catalog: its collection, then each product's detail (variants, prices). */
export async function loadCatalog(collection: string): Promise<PricedProduct[]> {
	const feed = await getCollection(collection);
	return Promise.all(
		feed.products.map(async (p) => {
			const detail = await getProduct(p.slug);
			return { slug: detail.slug, name: detail.name, description: detail.description, variants: detail.variants };
		}),
	);
}
