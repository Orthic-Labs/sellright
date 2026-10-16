import { component$ } from '@qwik.dev/core';
export const SNAPSHOT_MAX_AGE_MS = 60000;
export async function readCatalogSnapshot(slug: string) {
	const res = await fetch(`/catalog/${slug}.json`);
	return res.json();
}
export async function loadBrowseCatalog() {
	const res = await fetch('/catalog/all.json');
	return res.json();
}
export const browseCatalogKey = 'brand-browse';
export const CatalogShell = component$(() => <section class="catalog-shell">catalog</section>);
