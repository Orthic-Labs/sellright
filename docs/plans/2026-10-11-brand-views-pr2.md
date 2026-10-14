> Historical (2026-10-11). Current state: packages/storefront/src/platform/views.ts.

# Brand views PR2: shop and product views on the presentation gateway
Replaces §3.1–3.4 and §3.6–3.7 of `2026-10-11-brand-views.md` (v3.1). §3.5 (cart seed, analytics call sites, event sink) is kept unchanged and referenced, not repeated. Builds on the gateway (`2026-10-11-brand-views-gateway.md`, code `src/platform/gateway/**`) at `39e15cf` on `feat/brand-views-2`. Closes `brand-views-plan.astra3.json` items 3–6. Rotten legacy is `rt` = `seats/rt-fix/store/src`. Paths are under `packages/storefront/src/` unless they start with `api/`. This is a plan: no code, builds, tests or `.env` reads were run to write it.

## 0. Code this stands on
| Fact | Where |
|---|---|
| Gateway: `slotGate(slot, def, Fallback?)`, `action`/`optionalAction`, `enter` rejects unknown props and children | `platform/gateway/gate.tsx:20-22,61-87,106-114` |
| Action list is fixed; `invokeAction` detaches args and result; a throw becomes `ActionFailure` | `platform/gateway/actions.ts:20-33,80-107` |
| Schema combinators have no record/map type: every key must be declared | `platform/gateway/schema.ts:27-39,133-150` |
| `dispatch(ctl, guard, results, method)`: synchronous `busy` admission, `serial` order, result rebuilt from `results.schema` | `platform/controllers/callbacks.ts:20-31,47-80` |
| PDP loader: one `readCatalogSnapshot('products/<slug>.json')`, live fallback `getProductDetail` + reviews, `fail(404)` on miss | `platform/product.ts:38-79` |
| PDP head: title = product name, canonical and breadcrumb hard-code `/products/` | `platform/product.ts:97-148` (`:126`, `:137`) |
| PDP live JSON-LD (offers computed live by the API) | `platform/product.ts:88-92`; `api/src/seo/jsonld.ts:43` |
| PDP stock today: one `getProductStock(slug)` on `qidle`, `mergeProductStock`, partial selection kept | `routes/products/[...slug]/ProductContent.tsx:146-171` |
| `mergeProductStock`: a SKU missing from the response is fail-closed | `sellright/types/catalog.ts:267-282` |
| `getProductStock` = `fetchProductStock(slug)`: GET `/v1/shop/catalog/products/{slug}/stock`, null on 404, no abort signal | `providers/shop/products/products.ts:25`; `sellright/catalog.ts:84-95` |
| PDP add: `addToCart(cart, sku, 1, enrichment)`, then `showCart`, `loadCountryOnDemand`, live-region text | `ProductContent.tsx:25-34,270-295` |
| `addToCart` swallows into `lastError`; `applyResult`/`reportError` are module-private | `contexts/CartContext.tsx:90-109,146-158` |
| `CartService.addLine`: under the Web Lock, `syncToCookie` resets a replaced mirror, blind PATCH append, `install(...) ?? []` loses "not applied" | `services/CartService.ts:177-188,223-225,256-270,448-464` |
| Server append increments unconditionally (no clamp); each response line carries live `available`/`availableQuantity` | `api/src/routes/cart.ts:332-358,454-481,83-93` |
| Shop listing: manifest via `loadBrowseCatalog` (its own `readCatalogSnapshot`); `onInStockChange` is the only live listing read | `platform/shop.ts:16-23`; `services/browse-catalog.ts:14-27`; `routes/shop/index.tsx:44,141-155` |
| Catalog generation pinning (one file per call) | `services/catalog-snapshot.ts:1-22` |
| Head precedence (brand per-path declaration first), `pageSchemas`, static schema root allowlist | `platform/head-resolve.ts:150,234`; `platform/brand-data/static-schema.ts:4` |
| API product URL: `productPath(config, slug)` from `seo.productUrlPattern`, default `/products/{slug}/` | `api/src/seo/config.ts:38-48` |
| Rotten `/shop/`: `ShopComponent` with `initialStyle` from `?style`/`?sleeve`, `onClose$`, `onOpenGuarantee$`, `catalogData`; `GuidesLinks`; `GuaranteeModal` | `rt routes/shop/index.tsx:12-55` |
| Rotten `/shop/<slug>/`: slugs `shortsleeveshirt`/`longsleeveshirt`, `SAFE_SLUG` + 404 page, `lockedStyle`, `productId`, `rating`, `ProductReviews`, `view_item` (qidle + browser task), per-style title/description/H1, FAQPage | `rt routes/shop/[slug]/index.tsx:16-98,140-258` |
| Rotten configurator reads: SSR product-level stock (`useResource$`), then one read per style select and per size select; add trusts the loaded map; deep link `?size=&color=` on qidle; `localStorage` image cache | `rt components/shop/ShopComponent.tsx:171-192,384-450,567-646,674-723`; `rt services/shop-cache.ts:37` |

## 1. Decisions
- **Two slots.** `route.shop` and `route.product`, each rendered only through gateway handles in `gateway/index.tsx`. The fallback is today's page, byte for byte. No layer change. The default product markup (`ProductPageView` and its siblings) stays L1.
- **Detail is metadata only.** Loaders never read stock. Every variant starts `unchecked`, and fail-closed counts as not purchasable.
- **One automatic live read per page view** (§4). Option selection, product selection and add never start a stock read. The add's own server response is the live check for that SKU (`cart.ts:90-93`). Cart open, checkout entry and pre-submit refreshes are unchanged. This narrows v3.1 ("live on load and selection"); see §11.1.
- **Maps become arrays.** The gateway has no record schema, so `optionCodes`, `selection.options` and query preselection are arrays of `{ group, value }`.
- **The URL builder is one function per side.** Storefront: `productPath`/`productUrl` (`platform/product-path.ts`). API: `productPath(config, slug)`.

## 2. Gateway schemas (`gateway/index.tsx`; TS types in `platform/views.ts`, kept equal by `gateway/types.test.ts`)
```ts
const AVAILABILITY = lit('unchecked', 'loading', 'in-stock', 'out-of-stock', 'error');
const VIEW_IMAGE = obj({ url: str, alt: nul(str) });
const OPTION_VALUE = obj({ code: str, name: str, availability: AVAILABILITY });   // availability over the current partial selection
const OPTION_GROUP = obj({ code: str, name: str, values: arr(OPTION_VALUE) });
const PAIR = obj({ group: str, value: str });
const VIEW_VARIANT = obj({ sku: str, name: str, options: arr(PAIR), priceCents: num, salePriceCents: nul(num), preOrderPriceCents: nul(num),
  isPreOrder: bool, shipDate: nul(str), images: arr(VIEW_IMAGE), availability: AVAILABILITY });   // 'in-stock' only from a current-generation response
const VIEW_PRODUCT = obj({ key: str, slug: str, name: str, href: str, description: html, images: arr(VIEW_IMAGE), optionGroups: arr(OPTION_GROUP),
  variants: arr(VIEW_VARIANT), priceRange: obj({ minCents: num, maxCents: num }), currencyCode: str, availability: AVAILABILITY,
  rating: nul(obj({ average: num, count: num })), productId: nul(str) });
const PRODUCT_SUMMARY = obj({ key: str, slug: str, name: str, href: str, image: nul(str), priceRange: obj({ minCents: num, maxCents: num }), currencyCode: str });
const SELECTION = obj({ productKey: nul(str), options: arr(obj({ group: str, value: nul(str) })), variantSku: nul(str), quantity: num, preOrderConsent: bool });
const REJECT_REASON = lit('invalid', 'not-eligible', 'busy', 'disposed', 'cart-changed', 'cart-error', 'error');
export const ADD_RESULT = anyOf(
  obj({ status: lit('added'), sku: str, quantity: num, lineQuantity: num }),
  obj({ status: lit('added-unavailable'), sku: str, quantity: num, lineQuantity: num, availableQuantity: nul(num) }),
  obj({ status: lit('rejected'), reason: REJECT_REASON, message: nul(str) }));
const PURCHASE = obj({ stock: lit('unchecked', 'loading', 'ready', 'error'), eligible: bool,
  reason: nul(lit('select-product', 'select-options', 'stock-loading', 'out-of-stock', 'in-cart-limit', 'stock-error', 'consent-required', 'adding')),
  adding: bool, last: nul(ADD_RESULT), inCartQuantity: num, maxQuantity: num });
const LISTING_ITEM = obj({ slug: str, name: str, href: str, image: nul(str), priceCents: num, currencyCode: str, availability: lit('in-stock', 'out-of-stock') });

export const SHOP_DATA = obj({ identity: IDENTITY, listing: arr(LISTING_ITEM), inStockOnly: bool, detail: arr(VIEW_PRODUCT),
  detailStatus: lit('ok', 'partial', 'unavailable'), selection: SELECTION, purchase: PURCHASE });
const CONFIGURATOR_ACTIONS = { onOptionSelect$: action('configurator.option-select'), onQuantityChange$: action('configurator.quantity'),
  onConsentChange$: action('configurator.consent'), onAddToCart$: action('configurator.add'), onRetryStock$: action('configurator.retry-stock') };
export const ShopView = slotGate('route.shop', { data: SHOP_DATA, actions: { ...CONFIGURATOR_ACTIONS,
  onProductSelect$: action('configurator.product-select'), onInStockChange$: action('shop.in-stock') } });

export const PRODUCT_FOUND_DATA = obj({ identity: IDENTITY, state: lit('found'), product: VIEW_PRODUCT, siblings: arr(PRODUCT_SUMMARY),
  selection: SELECTION, purchase: PURCHASE, breadcrumbs: arr(obj({ name: str, href: str })) });
export const PRODUCT_MISSING_DATA = obj({ identity: IDENTITY, state: lit('missing'), shopHref: str });
export const ProductView = slotGate('route.product', { data: PRODUCT_FOUND_DATA, actions: CONFIGURATOR_ACTIONS });
export const ProductMissingView = slotGate('route.product', { data: PRODUCT_MISSING_DATA });   // same slot, no actions (§6)
```
`registry.ts` gains `'route.shop'` (data & actions) and `'route.product'` = found data & actions | missing data. Brands narrow on `state`. Option `code` is the catalog option code (`catalog.ts:246-253`). `VIEW_PRODUCT.description` is `toSanitizedHtml(raw, 'product')`. `availability` on a product is `in-stock` when any variant is in stock or on pre-order. `PRODUCT_SUMMARY` siblings carry no stock. `ProductCard`'s handle gains `href: opt(str)`, and `HomeTeeSection`'s gains `href: opt(str)` (§9).

## 3. Actions (`gateway/actions.ts` `ACTIONS`; controller methods go through `dispatch`)
| Action (prop) | Args | Result | Guard | Method rule (any failure → `invalid`, no state change, no request) |
|---|---|---|---|---|
| `configurator.product-select` (`onProductSelect$`, shop only) | `[str]` | `ACTION_RESULT` | none | key is a `detail[].key`. Sets `productKey`, clears options, quantity 1, consent false. No read |
| `configurator.option-select` | `[str, nul(str)]` | `ACTION_RESULT` | none | group is a code of the focused product; value is one of its codes or null (deselect). No read |
| `configurator.quantity` | `[num]` | `ACTION_RESULT` | none | integer, 1 ≤ q ≤ `purchase.maxQuantity` |
| `configurator.consent` | `[bool]` | `ACTION_RESULT` | none | `true` only when the resolved variant `isPreOrder` |
| `configurator.retry-stock` | `[]` | `ACTION_RESULT` | `'stock'` | only when `purchase.stock === 'error'`; starts one read (§4), resolves when started |
| `configurator.add` | `[]` | `ADD_RESULT` | `'add'` | §5 |
| `shop.in-stock` (`onInStockChange$`) | `[bool]` | `ACTION_RESULT` | `'listing'` | moves `shop/index.tsx:141-155` verbatim (live `searchProducts`, `liveStockOverride`) |
`ADD_RESULTS: DispatchResults` = `busy` → `{rejected, 'busy', null}`, `disposed` → `{rejected, 'disposed', null}`, `error` → `{rejected, 'error', null}`, `schema: ADD_RESULT`. The view also has to handle `ActionFailure` (`actions.ts:99-107`), as every bound action does. Calls apply in call order (`serial`): `onQuantityChange$(2); onAddToCart$()` without awaiting adds 2, and a selection made during an add applies after the add.

## 4. Live stock: one automatic read per direct load and per SPA navigation
`platform/controllers/stock-read.ts` (`useLiveStock(ctl, slugs)`), used by both controllers.
- **Read set.** PDP: the route product. Shop: every `detail[]` product (1-4 slugs, Rotten's sleeve buttons need both). One read is `Promise.all(slugs.map(s => fetchProductStock(s, { signal })))` under one `AbortController` and one `reqGen`. `fetchProductStock` gains an optional `signal` passed to the client (`sellright/catalog.ts:84-88`); its other callers are unchanged.
- **Identity.** `ctl.viewGen` increments in a `useTask$` that tracks the loader value, so a same-component SPA navigation (`/shop/a/` → `/shop/b/`) is a new view. SSR serialises `viewGen = 1`, `lastLoadGen = 0`.
- **Triggers.** Path A, direct load: `useOnDocument('qidle', …)`, as `ProductContent.tsx:171`. Path B, SPA navigation: a browser-only `useTask$` (an `isBrowser` guard; it runs at mount after client navigation and on `viewGen` change). Both call `requestLoad()`, which synchronously checks `ctl.lastLoadGen === ctl.viewGen` (then a no-op) and sets it before any await. So one view gets exactly one read, whichever path fires first or if both do. `pdp.stockRefreshTrigger` stays out of scope (v3.1 §5), and the trigger stays `qidle`.
- **Apply.** `reqGen = ++ctl.stockGen`. A response applies only if `reqGen === ctl.stockGen` and its `viewGen` is current. Otherwise it is dropped and cannot set `in-stock` or `eligible`. A `viewGen` change or unmount aborts the in-flight read and resets every variant to `unchecked`. Per product: a 200 response → `mergeProductStock` (a missing SKU means out of stock); `null` (404) → every variant `out-of-stock`; a throw, 5xx or timeout → that product `error`. `stock = 'error'` when the focused product failed, else `'ready'`.
- **Never cached.** Results live only in the controller store of the current view. Nothing is written to sessionStorage, localStorage, a module cache or the manifest, and there is no TTL, debounce or "loaded" flag (`lastLoadGen` is a per-view generation check, reset by navigation, not a skip-if-fresh flag). Back/forward is a new view and reads again. Retry is explicit (§3) and only after an error.
- **Shop listing.** Unchanged: manifest `inStock` on load; `shop.in-stock` is its only live read.

## 5. Purchase state and add outcome (follow-up 1, astra3 item 3)
**Eligibility** (focused product, current generation): `select-product` (shop with no `productKey`) → `stock-loading` (`unchecked`/`loading`) → `stock-error` → `select-options` (incomplete) → `out-of-stock` (resolved variant not in stock and not pre-order, or absent from the response) → `in-cart-limit` (`maxQuantity === 0`) → `consent-required` (pre-order without consent) → eligible. `maxQuantity` = 10 for pre-order or uncapped variants; otherwise `clamp(availableQuantity - inCartQuantity, 0, 10)`. `inCartQuantity` comes from the cart mirror (display only, as `ProductContent.tsx:298-303`). Partial selections are never wiped. A complete selection resets only if it no longer resolves (`ProductContent.tsx:154-163`). `findVariant`/`getOptionGroups`/`toCartEnrichment` move to `platform/controllers/product-model.ts`; `ProductContent` imports them from there, with unchanged bodies.

**Authoritative outcome, with no pre-add baseline.** The result is built only from the operation's own server response, inside the cart lock:
- `CartService.addLine` (`CartService.ts:448-464`) returns, additively, `applied: boolean` (`install` returned non-null: the response, the request token and the cookie name the same cart) and `line` = the response body's own line for `sku` (`data.lines.find(...)`, not the mirror). Existing callers ignore the new fields.
- `addToCartWithOutcome(cart, sku, qty, enrichment)` sits in `CartContext.tsx` beside `addToCart` (`:146-158`) and reuses its private `loadCartIfNeeded`/`applyResult`/`reportError`. It returns `{ kind: 'applied', line } | { kind: 'not-applied' } | { kind: 'error', message }`. `addToCart` is unchanged.
- The mapping uses the server contract: an append increments by exactly `qty` (`cart.ts:341-349`), so a 200 always means `qty` units were added.

| Server outcome | `AddResult` | Drawer / `add_to_cart` |
|---|---|---|
| applied, `line.available === true` | `added { quantity: qty, lineQuantity: line.quantity }` | open / fire `qty` |
| applied, `line.available !== true` (stock fell since the load read, or `availableQuantity < line.quantity`) | `added-unavailable { …, availableQuantity }`; the drawer shows the line flagged, and checkout blocks it | open / fire `qty` |
| applied, `line` absent from the response | `rejected 'cart-error'` | closed / none |
| not applied (cookie replaced by another tab while the request ran) | `rejected 'cart-changed'`, "Your cart changed in another tab. Please try again." | closed / none |
| `CartError`/`ConvertedCartError` thrown (`CartService.ts:47-62,389`) | `rejected 'cart-error'`, `message` = `cart.lastError` | closed / none |
A stale mirror never affects the result: `syncToCookie` runs first under the lock (`:223-225`), and `dropped` (other SKUs) keeps feeding only the existing cart notice (`CartContext.tsx:93-96`). On `added*` the controller sets `appState.showCart = true`, calls `loadCountryOnDemand(appState)` and posts the live-region text (`ProductContent.tsx:279-287`). `adding` clears on every path, and `purchase.last` holds the result.

## 6. Missing-product contract (follow-up 2, item 4)
`useBrandProductDetail` (§7) returns `{ state: 'missing' }` and calls `status(404)` for an invalid slug (`SAFE_SLUG`, `product.ts:46-50`), for no manifest file and no live product, and for a product with no variants (`ProductContent.tsx:49-51`). `BrandProductMount` (L1) is a switch with no hooks: `missing` → `<ProductMissingMount/>` renders `ProductMissingView` with `{ identity, state: 'missing', shopHref: '/shop/' }`, and no controller, stock read or `view_item` exists on that path. `found` → `<ProductFoundMount/>` runs `useProductController`. The head for `missing` is `createSEOHead({ title: 'Product Not Found', noindex: true })` (Rotten parity, `rt shop/[slug]:143-149`), and the 404 status stays.

## 7. One pinned generation for product + siblings (follow-up 3, item 5)
`services/catalog-snapshot.ts` adds `readCatalogGeneration<T>(files)`. It pins `current` once, validates the marker once (the same checks as `:9-21`), reads every file from that directory and returns `{ generation, files: Record<string, T | null> }`. `readCatalogSnapshot` becomes a one-file wrapper with unchanged behaviour.
- **PDP** (`platform/product-detail.ts`, `useBrandProductDetail`). Files: `products/<route slug>.json` plus, when the route slug is a `detailProducts` member, the other members' files. This also covers route products outside `detailProducts` (a one-file set, `siblings = []`). If the generation is invalid or any file in the set is missing, the **whole set** is read live (`getProductDetail` + `liveProductMeta` + reviews, as `product.ts:63-78`). So a product and its siblings never mix sources or generations.
- **Shop** (`platform/configurator-detail.ts`, `useConfiguratorDetail`). Files: `shop-catalog.json` plus every `detailProducts` file, in one generation. The listing comes from the same read through `normalizeBrowseCatalog(raw)`, split out of `browse-catalog.ts:16-21`. The same all-or-live rule applies, and the live listing is `searchCatalog` as `browse-catalog.ts:23-25`. A detail product that fails both sources is omitted, which sets `detailStatus`.
- **Unbranded branch unchanged.** Both new loaders start with `if (!hasView('route.product'|'route.shop')) return null` (a build constant, no I/O). `useProductLoader` and `useCatalogLoader` start with the inverse guard, so a branded build performs one catalog read per request, and an unbranded build runs exactly today's loader bodies. Each route file exports `head = hasView(...) ? brandProductHead : head`, so the base `head` (`product.ts:97-148`) runs untouched without a view, and `brandProductHead` resolves only `useBrandProductDetail` + `useProductJsonLd`.

## 8. Per-product head copy (follow-up 4, item 6)
`routes.json` `shop.detailProducts[]` entries gain `head?: { title, description }` (plain text; title 1-70 chars, description 1-170, no `<`), `breadcrumbName?` (1-80) and `schemas?: StaticSchema[]` (the §2.4 allowlist; Rotten uses `FAQPage`). `content-routes.ts` registers each one as a per-path declaration for `productPath(slug)`, so `resolveHead` applies it at precedence (1) (`head-resolve.ts:150`), with og/twitter following. Product JSON-LD (`useProductJsonLd`, live offers and availability), `og:type product`, canonical = `productUrl(slug)`, `og:image` and the breadcrumb (`Home` / `Shop` / `breadcrumbName ?? product.name`) stay platform-built. The static-schema root allowlist (`static-schema.ts:4`) gains `CollectionPage`, and the nested allowlist gains `ItemList`, for Rotten's `/shop/` page (`rt shop/index.tsx:128-150`). The forbidden commerce keys still apply.

## 9. productPath and every URL generator
`routes.json productPath`: `'/products/:slug/'` (default) | `'/shop/:slug/'`. `platform/product-path.ts` exports `productPath(slug)` (`encodeURIComponent`, trailing slash) and `productUrl(slug)` = `siteUrl + productPath(slug)`. Routes:
- `routes/products/[...slug]/index.tsx`: serves when the setting is `/products/:slug/`. Otherwise `onGet` 301s a `SAFE_SLUG` path to `productPath(slug)` (the API's emails, feed and sitemap keep working until `seo.productUrlPattern` changes, §11.3), and anything else gets today's 404.
- `routes/shop/[slug]/index.tsx` (new): serves the same loaders when the setting is `/shop/:slug/`. Otherwise its `onGet` and default export are today's `[...catchall]` 404 (status, component and `NOT_FOUND_HEAD`), proven byte-equal.
| Generator | Change |
|---|---|
| `platform/product.ts:126,137` (breadcrumb, canonical) | `productUrl(slug)` |
| `platform/controllers/project.ts:136` (`ListingCard.href`) | `productPath(slug)` |
| `components/products/ProductCard.tsx:147` (L2) | `href` prop from the caller via the gateway; callers pass `productPath(slug)`; default stays `/products/${slug}/` |
| `components/home/HomeTeeSection.tsx:37` (L2) | `href` from `routes/index.tsx` via the gateway |
| `components/cart-contents/CartContents.tsx:167`, `routes/index.tsx:131` | `productPath(slug)` |
| `routes/cache-admin/warm/index.ts:33`, `services/indexnow-webhook.server.ts:48`, `services/seo-schemas.ts:73` | `productPath`/`productUrl` |
| `routes/[...catchall]/index.tsx:92` (`startsWith('/products/')` hint) | the prefix derived from the setting |
| `api/src/cache/purge-hook.ts:32`, `api/src/email/dispatch.ts:316`, `api/src/routes/restock.ts:63` | `productPath(config, slug)` (`api/src/seo/config.ts:46`) |
| `api/src/seo/jsonld.ts:43`, `api/src/seo/sitemap.ts:48` | already on `productPath(config, …)`; no change |
`api/src/feeds/feed.ts:116,222` keeps its own `productUrlPattern` (Merchant feed, out of scope). A grep test bans `` `/products/${ `` outside `product-path.ts` and `api/src/seo/config.ts`.

## 10. Controllers and the calls they make
| Controller (`platform/controllers/`) | Calls (file:line) |
|---|---|
| `product.tsx` `useProductController`, `BrandProductMount`, `ProductFoundMount`, `ProductMissingMount` | `useBrandProductDetail` (§7) → `readCatalogGeneration`, `normalizeManifestProductDetail` (`catalog.ts:215`), `manifestProductMeta` (`:197`), fallback `getProductDetail` (`products.ts:30`) + `liveProductMeta` (`catalog.ts:186`) + `getProductReviews` (`product.ts:72`); `useProductJsonLd` (`product.ts:88-92`); stock via `useLiveStock` → `fetchProductStock` (`sellright/catalog.ts:84`) + `mergeProductStock` (`catalog.ts:267`); `addToCartWithOutcome` → `CartService.addLine` (`CartService.ts:448`); `useCart`, `APP_STATE.showCart`, `loadCountryOnDemand` (`utils/addressStorage.ts:119`); `track('view_item')` once per `viewGen` (`sellright/analytics.ts`), `track('add_to_cart')` on `added*` |
| `shop.tsx` `useShopController`, `BrandShopMount` | `useConfiguratorDetail` (§7) → `readCatalogGeneration`, `normalizeBrowseCatalog`, `normalizeManifestListItem` (`catalog.ts:116`), fallback `searchCatalog`/`getProductDetail`; the same stock, add and track calls (no `view_item` on `/shop/`, Rotten parity); `shop.in-stock` → `searchProducts` (`shop/index.tsx:141-155`, moved) |
| `stock-read.ts` `useLiveStock` | §4 only |
| `product-model.ts` | Pure: option groups, variant resolution, availability per value, projection to `VIEW_PRODUCT` (field by field, `toSanitizedHtml`), `toCartEnrichment` |
| Cart layer 4 | Unchanged: `useCartToggle` → `refreshCartStock` (`platform/cart.ts:9-26`, `CartContext.tsx:113-127`); checkout entry and `placeOrder` revalidation |
**Initial selection (SSR, no race).** `productQuery` (`?style`/`?sleeve` → key, v3.1 §3.2) sets the shop's initial `productKey`. Then, for the focused product, each query param named like a group code (lower-case) whose value matches a value code or the slugified name (Rotten's `optionCode`, `rt shop/index.tsx:62`) preselects that value. Unknown params are ignored. Because preselection happens in the SSR state, a later click simply replaces it and stock never decides selection. Purchase stays gated by §5.

## 11. Open points for the orchestrator
1. §4 runs one automatic read per view covering every selectable product, and drops v3.1's per-selection and add-time reads (the add response is the live SKU check). This matches the brief and base PDP behaviour. It narrows the 2026-10-12 "live on load and selection" note, so confirm it.
2. Rotten's `/shop/` ProductGroup JSON-LD (`rt shop/index.tsx:62-110`) has no PR2 home: the static schemas forbid `Product`/`Offer`, and live ProductGroup JSON-LD is out of scope (v3.1 §5). Cutover would drop it until a platform ProductGroup endpoint exists.
3. Rotten's `seo.productUrlPattern = '/shop/{slug}/'` still needs Adrian's go (v3.1 §6.4). The 301 in §9 keeps API-generated `/products/` links working meanwhile.
4. Rotten's product facts in JSON-LD (`material`, `color`, `size`, `rt shop/[slug]:181-194,230`) come only from the API JSON-LD, so PR2 does not reproduce them.

## 12. Files (PR2)
`platform/gateway/{index.tsx,actions.ts}` (§2, §3); `components/slots/registry.ts` (two slots); `platform/views.ts` (types, plus the `ProductReviewsWidget` `{ slug, productName }` and `LoyaltyEarnWidget` `{ productId, priceCents }` exports from `platform/widgets/`, wrapping the L1 `ProductReviews`/`LoyaltyPdpEarn`); `platform/controllers/{product.tsx,shop.tsx,stock-read.ts,product-model.ts}`; `platform/{product-detail.ts,configurator-detail.ts,product-path.ts}`; `services/{catalog-snapshot.ts,browse-catalog.ts,CartService.ts}`; `contexts/CartContext.tsx`; `sellright/catalog.ts` (signal); `platform/brand-data/{routes.schema.json,static-schema.ts,validate.ts}`, `platform/content-routes.ts`; `routes/products/[...slug]/{index.tsx,ProductContent.tsx}`, `routes/shop/{index.tsx,[slug]/index.tsx}`; the §9 generators; v3.1 §3.5 files (unchanged scope).

## 13. Tests
| Area | Tests |
|---|---|
| Schemas | `gateway/types.test.ts`: `Infer` ⇄ `ShopViewProps`/`ProductViewProps`; `schema.test.ts`: `VIEW_PRODUCT` with a signal-backed variant array copies disjoint; unknown key, record-shaped `optionCodes` and a function rejected |
| Actions | `actions.test.ts`: each new name's arg validation (`[num]` rejects a string, `[str, nul(str)]` accepts null); `ADD_RESULT` rejects an unknown status; a throwing add → `ActionFailure` |
| Forged calls | unknown key/group/value, quantity 0/11/1.5/NaN or above `maxQuantity`, consent on a non-pre-order, add while not eligible, retry while not in error → `invalid`/`not-eligible`; no state change, zero requests (stubbed `fetchProductStock` and `addLine` counters) |
| One read | `stock-read.test.ts` with a fake document: direct load fires qidle → 1 read; qidle plus browser task in the same view → 1; SPA navigation (mount in browser) → 1; same-component slug change → 1 more, and the old read is aborted; back/forward → 1 each; selections and add → 0 reads; focus/visibility events → 0; shop with 2 detail products → 2 requests under one `reqGen`; retry after error → 1 |
| Generations | out-of-order responses (old `reqGen`) dropped; a response landing after `viewGen` changes never sets `in-stock`/`eligible`; 404 → OOS; SKU absent → OOS; 500/timeout → `error` on that product only |
| No cache | after a view ends, no storage key or module state holds stock (spy `Storage.prototype.setItem`); a new view starts `unchecked` |
| Add outcome | `CartService.test.ts`: `addLine` returns `applied`/`line` from the response body; cookie swapped mid-request → `applied: false`. `cart-result.test.ts`: available → `added`; `available:false` → `added-unavailable`; stale mirror (other tab added the same SKU first) still `added` with the server's `lineQuantity`; cart replaced → `rejected 'cart-changed'`, drawer closed; `ConvertedCartError` → `cart-error` with `lastError`; double `onAddToCart$()` → second `busy`, one PATCH |
| Missing product | invalid slug, no file + live 404, zero variants → status 404, `ProductMissingView` props, `Product Not Found` + `noindex`; zero stock requests, no controller task, no `view_item` |
| Generation pinning | `catalog-snapshot.test.ts`: `current` swapped between files still yields the pinned set; `product-detail.test.ts`: route + siblings from one generation; one sibling file missing → whole set live; non-member slug → one file, `siblings: []`; no view → no I/O; `configurator-detail.test.ts` the same for listing + details |
| Head | `head.test.ts`: a detail product's `head.title` beats the product name; og/twitter follow; canonical = `productUrl`; breadcrumb uses `breadcrumbName`; `FAQPage` accepted, `Product`/`offers` in `schemas` rejected; `CollectionPage` + `ItemList` accepted |
| URLs | `product-path.test.ts`; grep test; each setting: active route 200, inactive `/products/x/` 301 to `/shop/x/`, inactive `/shop/x/` byte-equal to today's 404 |
| Fallback | `gateway/fallback.render.test.tsx` + §2.7 SSR equality: `/shop/`, `/shop/?q=x`, a PDP, an OOS PDP, unknown slug, `/shop/x/`, with no view files |
| E2E (fixture brand, 2 products × size × colour) | `brand-views-shop.spec.ts`: load → one stock request → select → add → `added` → drawer; `stock-parity.spec.ts` under `/shop/<slug>/`: an OOS product shows OOS on PDP first paint, `added-unavailable` or a disabled CTA at add, and is blocked at checkout entry and `placeOrder` |
Focused tests, then `pnpm typecheck`, `pnpm build`, `pnpm test:scripts`, `pnpm test:tools`, `pnpm verify`.

## 14. Rotten's overlay after PR2
- `src/brand-slots/route.shop.tsx` and `route.product.tsx`: `ShopComponent`'s markup ported to the props above. Sleeve buttons come from `detail[].availability`, sizes and colours from `optionGroups[].values[].availability`, the CTA label and hint from `purchase.reason`, "Checking stock..." from `purchase.stock === 'loading'`, and the success flash from `purchase.last`. Gallery, swipe, image decode/warm, size guide, accordions, `PDP_KICKER`/`PDP_ABOUT`, `COLOR_SWATCHES` (by option code) and the visible FAQ live in `src/brand/configurator/*.tsx`. The close button uses `useNavigate`/`history.back()`. The rating link renders from `product.rating`; `<LoyaltyEarnWidget>` and `<ProductReviewsWidget>` come from `~/platform/views`.
- `src/brand/GuaranteeModal.tsx`, `src/brand/GuidesLinks.tsx` (pure, local signal) and the overlay stylesheet from `ShopComponent.css`.
- `src/brand/routes.json`: `productPath: '/shop/:slug/'`; `shop.detailProducts` = `{ key: 'short', slug: 'shortsleeveshirt' }` and `{ key: 'long', slug: 'longsleeveshirt' }` (v3.1's `short-sleeve-shirt` slugs were wrong), each with `head` (the `rt shop/[slug]:162-172` strings), `breadcrumbName` and `schemas: [FAQPage]`; `productQuery` `{ params: ['style','sleeve'], values: { short: 'short', long: 'long' } }`; `pages['/shop/'].head` (`rt shop/index.tsx:116-117`); `operational` as v3.1 §3.2.
- `src/brand/head.json` `pageSchemas['/shop/']`: `BreadcrumbList` + `CollectionPage`/`ItemList`.
- **Gone from the overlay:** `routes/shop/**`, `ShopComponent`'s cart, `APP_STATE`, stock and track code, `services/shop-queries.ts`, `services/shop-cache.ts` (`localStorage` image cache), `sellright/derive-catalog`, `data/shop-constants` fallbacks, SSR stock `useResource$`, per-selection reads, the `cart-updated` event, `trackEcommerce`, and the hand-built Product/ProductGroup JSON-LD (§11.2, §11.4).

## 15. Stock rule check
No cache, TTL, debounce, sessionStorage or brand flag; loaders never read stock; missing stock or a SKU absent from the response means out of stock; one live read per view (§4); superseded responses are dropped; layers 1, 4 and 5 are untouched; a rejected or unapplied add never reports success; brand code receives detached data and gateway actions only.

## 16. Review fold (`bv-pr2-plan.astra1.json`) and implementation deviations
| # | Finding | Resolution in the code |
|---|---|---|
| high | pre-order flag overriding live OOS | Already fixed on main (PR 211). The controller requires the live `inStock === true` for availability and eligibility; `isPreOrder` only shows the label and asks consent (`product-model.ts` `computePurchase`, test "a stale pre-order flag ...") |
| medium | code-based selection vs name-based helpers | View codes are the slug of the catalog name (Rotten's `optionCode`), unique per group; each code maps to one name, so `findVariant` keeps working on names and the controller resolves on codes (`buildModelProduct`, `resolveVariant`). Deep links: a param named like the group code with a value code or name slug (`?size=medium&color=forest-green`). Fixtures use option ids that differ from names |
| medium | quantity not revalidated | `selection.quantity` is always normalised to `1..max(1, maxQuantity)` (selection, stock or cart change), and the add revalidates it against the current cap |
| medium | Promise.all vs per-product isolation | Tagged per-product outcomes (`stock-read.ts` `readStock`), one product's failure never discards a sibling's live result |
| medium | product declarations override the missing head | Product head copy is not a per-path declaration: `brandProductHead` applies it only in the found state; missing is always `Product Not Found` + noindex |
| medium | redirect drops the query | The `/products/<slug>/` 301 keeps `url.search` |
| medium | API URL migrations lack a config contract | Not changed in PR2: the 301 forwards API-built `/products/` links with their query; threading `seo.productUrlPattern` into the purge hook, review and restock emails is a follow-up |
| low | grep test vs ProductCard fallback | The test allows the documented L2 defaults in `ProductCard.tsx` and `HomeTeeSection.tsx`; every base caller passes `href` from `productPath` |

Deviations: the `purchase` event fires once per order on the confirmation page (every settled path lands there) instead of also at the checkout settle points; `pdp.stockRefreshTrigger` is wired in the separate stock-settings PR.
