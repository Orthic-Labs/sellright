import assert from "node:assert/strict";
import { test } from "node:test";
import { areaOf, chunkGroups, sharedGroup } from "./chunk-groups.mjs";

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

test("shared group takes only modules whose imports are all outside src or shared", () => {
	const mods = {
		"/a/src/utils/x.ts": ["/a/node_modules/v/i.js"],
		"/a/src/utils/y.ts": ["/a/src/utils/x.ts"],
		"/a/src/routes/index.tsx": [],
		"/a/src/c/z.ts": ["/a/src/routes/index.tsx"],
		"/a/src/c/Seg.tsx_Seg_component_abc.js": [],
		"/a/src/p/q.ts": ["/a/src/p/r.ts"],
		"/a/src/p/r.ts": ["/a/src/p/q.ts"],
		"/a/node_modules/v/i.js": [],
	};
	const ctx = { getModuleInfo: (id) => ({ importedIds: mods[id] ?? [] }) };
	const g = sharedGroup();
	const got = Object.fromEntries(Object.keys(mods).map((id) => [id, g(id, ctx)]));
	assert.deepEqual(got, {
		"/a/src/utils/x.ts": "sr-shared",
		"/a/src/utils/y.ts": "sr-shared",
		"/a/src/routes/index.tsx": null,
		"/a/src/c/z.ts": null,
		"/a/src/c/Seg.tsx_Seg_component_abc.js": null,
		"/a/src/p/q.ts": null,
		"/a/src/p/r.ts": null,
		"/a/node_modules/v/i.js": null,
	});
});
