import type { CatalogListResponse } from '~/sellright/types/catalog';
import { filterCategoryProducts, type ShopCategory } from '~/utils/shop-categories';

type SearchProducts = (params: { term?: string; take: number }) => Promise<CatalogListResponse>;

export async function searchByCategories(
  term: string,
  selectedIds: readonly string[],
  categories: readonly ShopCategory[],
  searchProducts: SearchProducts,
): Promise<CatalogListResponse> {
  if (selectedIds.length && !categories.some(({ id }) => selectedIds.includes(id))) {
    return { items: [], total: 0 };
  }
  const result = await searchProducts({ term: term || undefined, take: selectedIds.length ? 10000 : 60 });
  if (!selectedIds.length) return result;

  // Filter before limiting visible results: a matching category may occur
  // after the first search page. The provider pages up to 10,000 items.
  if (result.items.length < result.total) throw new Error('Catalog exceeds category search limit');
  const items = filterCategoryProducts(result.items, categories, selectedIds);
  return { ...result, items: items.slice(0, 60), total: items.length };
}
