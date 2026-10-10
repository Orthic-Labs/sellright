export function browseCatalogKey(page: number): string {
	return `browse:${page}`;
}
export async function loadBrowseCatalog(page = 1): Promise<string[]> {
	return [browseCatalogKey(page)];
}
