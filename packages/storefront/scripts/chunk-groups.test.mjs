import assert from "node:assert/strict";
import { test } from "node:test";
import { areaOf, chunkGroups } from "./chunk-groups.mjs";

test("chunk groups map sources to page areas; unknown code stays unmapped (#427)", () => {
	assert.equal(areaOf("routes/checkout/index.tsx"), "checkout");
	assert.equal(areaOf("components/cart/Cart.tsx"), "cart");
	assert.equal(areaOf("routes/products/[...slug]/ProductContent.tsx"), "product");
	assert.equal(areaOf("routes/shop/[slug]/index.tsx"), "product");
	assert.equal(areaOf("routes/shop/index.tsx"), "shop");
	assert.equal(areaOf("routes/index.tsx"), "home");
	assert.equal(areaOf("routes/layout.tsx"), "shell");
	assert.equal(areaOf("routes/account/index.tsx"), "account");
	assert.equal(areaOf("../node_modules/@qwik.dev/router/index.qwik.mjs"), null);
});

test("chunk groups emit hash -> sr-<area> for mapped symbols only", () => {
	const m = { symbols: { s_a: { hash: "a", origin: "components/cart/Cart.tsx" }, s_b: { hash: "b", origin: "utils/x.ts" } } };
	assert.deepEqual(chunkGroups(m), { a: "sr-cart" });
});
