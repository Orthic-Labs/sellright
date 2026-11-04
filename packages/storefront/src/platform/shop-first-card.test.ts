import { describe, expect, it } from "vitest";
import { firstCardImage } from "./shop-first-card";
import type { CatalogListItem } from "~/sellright/types/catalog";

const item = (slug: string, inStock: boolean, image: string): CatalogListItem => ({ slug, name: slug, status: "active", tags: [], image, inStock, minPrice: null, maxPrice: null, pricingVariant: null }) as CatalogListItem;

describe("#425 firstCardImage: the LCP image the shop head preloads is the grid first card", () => {
	it("cached shell (deferred): the first product in listing order, availability unknown", () => {
		expect(firstCardImage({ deferred: true, products: [item("a", false, "a.png"), item("b", false, "b.png")] })).toBe("a.png");
	});
	it("uncached render: in-stock products come first, as the grid sorts them", () => {
		expect(firstCardImage({ deferred: false, products: [item("a", false, "a.png"), item("b", true, "b.png")] })).toBe("b.png");
	});
	it("nothing to preload for an empty listing or a product without image", () => {
		expect(firstCardImage({ products: [] })).toBeNull();
		expect(firstCardImage(null)).toBeNull();
		expect(firstCardImage({ products: [{ ...item("a", true, ""), image: null } as CatalogListItem] })).toBeNull();
	});
});
