import type { FacetWithValues } from '~/types';

export interface ShopCategory {
  id: string;
  name: string;
}

/** Labels keep merchandising order; optional stable IDs preserve existing category URLs. */
export function projectShopCategories(names: readonly string[], rawIds?: string): ShopCategory[] {
  const ids = rawIds === undefined
    ? names.map((_name, index) => String(index + 1))
    : rawIds.split(',').map((id) => id.trim());
  if (ids.length !== names.length || ids.some((id) => !/^[0-9]+$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error('Invalid VITE_SHOP_CATEGORY_IDS: use one unique numeric ID per shop category');
  }
  return names.map((name, index) => ({ id: ids[index], name }));
}

export function categoryFacets(categories: readonly ShopCategory[], selectedIds: readonly string[] = []): FacetWithValues[] {
  return [{
    id: 'category',
    name: 'Category',
    open: true,
    values: categories.map(({ id, name }) => ({ id, name, selected: selectedIds.includes(id) })),
  }];
}

/** Match any selected category tag; unknown IDs never broaden the listing. */
export function filterCategoryProducts<T extends { tags?: readonly string[] | null }>(
  items: T[],
  categories: readonly ShopCategory[],
  selectedIds: readonly string[],
): T[] {
  if (!selectedIds.length) return items;
  const names = categories.filter(({ id }) => selectedIds.includes(id)).map(({ name }) => name);
  return items.filter((item) => names.some((name) => (item.tags ?? []).includes(name)));
}
