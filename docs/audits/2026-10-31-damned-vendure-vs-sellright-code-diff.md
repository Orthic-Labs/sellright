# Damned: Vendure storefront vs SellRight storefront — code diff (home, shop, product, cart, checkout)

Source of truth: the code and build output, not Lighthouse.

- **Vendure**: `~/sites/damned/store` (Qwik 2.0.0-beta.45), last built 2026-10-22. Its built server was started on 127.0.0.1:4466 to
  capture each page's HTML (same host header), then stopped.
- **SellRight**: live Damned store `~/sites/.work/dd-prod/store-sellright` (core b2f69ebc, Qwik 2.0.0-rc.3). HTML fetched from the
  origin (127.0.0.1:4350, no cookies). Server-side API calls taken from the API's own request log for each single render.
- Build numbers come from each build's `dist/q-manifest.json`.

## The five differences that matter

1. **Cart lives on the server now.** Vendure kept the cart in the browser (`localStorage`): add to cart and opening the cart made
   no request except a stock check; the order was created on the server only at checkout. SellRight's cart is a server object:
   the first add creates it (`POST /v1/shop/cart`) and writes lines (`PATCH /v1/shop/cart/{token}/lines`); opening the cart and
   entering checkout read it (`GET /v1/shop/cart/{token}`).
2. **More, smaller code files.** 888 bundles vs 516 (775 under 3 KB vs 446). The cart's code is 80 files / 208 KB vs 49 / 131 KB;
   checkout 162 files vs 54. Qwik fetches a component's code only when that component renders, so opening the cart walks the
   tree level by level: one network round trip per level. Vendure pre-downloaded the whole cart closure after page load
   (`cartPreloads` in its `entry.ssr.tsx`); SellRight did too until ff6ccb2c removed it (the 4-7 s add to cart).
3. **Pages are cached at the edge and values are fetched by the browser.** Vendure rendered stock and prices into the HTML
   (from catalog files on disk, cached at Cloudflare for hours). SellRight's home and product HTML carry no price or stock
   (ADR-0001); the browser fetches them (3 requests at page start on home and product).
4. **Every SellRight render calls the API.** identity + maintenance on every render, plus the page's data. Vendure's home, shop and
   product pages read catalog files from disk; only the home spotlight called the Vendure API.
5. **Bigger HTML and state.** The whole stylesheet is inline (117 KB vs Vendure's 87 KB critical subset), and the serialized
   page state is 2.4x larger on home.

## Totals (client build)

| | Vendure | SellRight |
|---|---:|---:|
| JS bundles | 516 | 888 |
| JS total (raw) | 1,233 KB | 1,485 KB |
| Bundles under 3 KB | 446 | 775 |
| Average bundle | 2,446 B | 1,713 B |
| Qwik core | 107 KB | 110 KB |
| Qwik loader | 5.1 KB | 5.2 KB |
| Code symbols (handlers/components) | 651 | 989 |

Code needed to render each area (its components plus everything they import; "depth" = levels of imports):

| Area | Vendure files / KB / depth | SellRight files / KB / depth |
|---|---|---|
| Home | 25 / 121 KB / 5 | 67 / 202 KB / 4 |
| Product page | 43 / 151 KB / 4 | 100 / 282 KB / 4 |
| Cart | 49 / 131 KB / 3 | 80 / 208 KB / 4 |
| Checkout | 54 / 359 KB / 3 | 162 / 339 KB / 4 |

## Page by page

Columns: HTML bytes (uncompressed), inline CSS, serialized Qwik state, inline JS, startup handlers (`qinit` / `qidle`), event
handlers in the markup.

### Home `/`

| | Vendure | SellRight |
|---|---|---|
| HTML | 143,247 B | 196,417 B |
| Inline CSS | 86,506 B (critical subset; full sheet after load) | 117,060 B (whole sheet) |
| Qwik state | 13,207 B | 31,394 B |
| Inline JS | 6,031 B | 11,794 B |
| Startup handlers | 3 qinit + 2 qidle | 4 qinit + 4 qidle |
| Font preloads | 3 | 1 |
| **Server API calls per render** | 1: GraphQL `product(slug: pocket-fixed-blade)` (spotlight, with price + stock). Trustpilot from a file. | 4: `GET /v1/shop/identity`, `GET /v1/maintenance`, `GET /v1/shop/seo/jsonld/organization`, `GET /v1/shop/catalog/products` |
| **Browser API calls at load** | none (cart read from localStorage) | 3 at document parse: `GET /v1/shop/catalog/products/pocket-fixed-blade/stock`, `GET /api/live/home-spotlight/`, `GET /api/live/home-values/`; plus `GET /api/session/` and `GET /v1/shop/cart/{token}` when the visitor has those cookies |
| Browser calls at idle | `EventSource /api/cache-events` + `GET /api/cache-version` every 60 s | session read (if not started at parse) |
| HTML cache | Cloudflare, hours | Cloudflare 1 h (shell), purged on edits |

### Shop `/shop/`

| | Vendure | SellRight |
|---|---|---|
| HTML | 136,616 B | 196,960 B |
| Inline CSS | 70,367 B | 100,839 B |
| Qwik state | 18,338 B | 36,621 B |
| Startup handlers | 3 qinit + 2 qidle | 4 qinit + 3 qidle |
| **Server API calls per render** | 0 (reads `shop-catalog.json` from disk; API only for text search) | 3: identity, maintenance, `GET /v1/shop/catalog/products` (live stock, DP-6) |
| **Browser API calls at load** | none | none |
| On interaction | in-stock toggle / search → GraphQL `search` | in-stock toggle → live listing read |
| HTML cache | Cloudflare | none (dynamic, live stock per request) |

### Product `/products/monsuta-bead/`

| | Vendure | SellRight |
|---|---|---|
| HTML | 165,632 B | 205,910 B |
| Inline CSS | 89,808 B | 119,965 B |
| Qwik state | 30,594 B | 29,008 B |
| Startup handlers | 4 qinit + 2 qidle | 6 qinit + 4 qidle |
| **Server API calls per render** | 0 (product JSON + shop catalog from disk) | 3: identity, maintenance, `GET /v1/shop/seo/jsonld/products/:slug` |
| **Browser API calls at load** | 1 at qinit: GraphQL `GetSingleProductStockLevels` | 3 at document parse: `GET .../products/monsuta-bead/stock`, `GET /api/live/product-values/?slug=`, `GET /v1/shop/config` |
| Later | reviews: none (Trustpilot static) | reviews `GET` when the block nears the viewport |
| **Add to cart** | 0 requests (local cart; stock already live) | first add: `POST /v1/shop/cart` then `PATCH /v1/shop/cart/{token}/lines`; later adds: `PATCH .../lines` (+ `GET .../cart/{token}` if the revision is not known) |
| Price/stock in HTML | yes (from the catalog file, rechecked live) | no (filled by the browser) |

### Cart (drawer)

| | Vendure | SellRight |
|---|---|---|
| Where the cart lives | browser `localStorage` | server (`/v1/shop/cart/{token}`, cookie `sr_cart`) |
| Load at page start | `qinit`: read localStorage (no request) | `qinit`: `GET /v1/shop/cart/{token}` if the cookie exists (started at parse) |
| **Open cart** | live stock read for the items (locked rule) | live cart read `GET /v1/shop/cart/{token}` (locked rule) |
| Code needed | 49 files / 131 KB, pre-downloaded after load | 80 files / 208 KB; pre-downloaded after load until ff6ccb2c, since then fetched on the click in serial levels |

### Checkout `/checkout/`

| | Vendure | SellRight |
|---|---|---|
| HTML | 160,127 B | 156,391 B |
| Inline CSS | 101,256 B | 105,420 B |
| Qwik state | 17,069 B | 20,105 B |
| Startup handlers | 5 qinit + 2 qidle | 4 qinit + 3 qidle |
| **Server API calls per render** | 0 (static) | 2 without a cart cookie (identity, maintenance); + a server cart read with one |
| **Browser API calls at entry** | `document-ready`, only with a cart/session: active customer, active order, addresses (parallel), live stock refresh; countries from static JSON | `GET /v1/shop/config` at parse; checkout-entry cart read `GET /v1/shop/cart/{token}?pricingIntent=checkout&includeShippingMethods=1` at parse (taken once by the entry boot) |
| Place order | convert local cart → Vendure order: add items, set customer, shipping address, shipping method, transition, add payment (NMI/Sezzle) | `POST /v1/shop/cart/{token}/checkout` (server cart already exists) + payment |
| Code needed | 54 files / 359 KB | 162 files / 339 KB |
| From the cart button | warmed on intent (link hints) | warmed on intent toward a `/checkout` link only since ff6ccb2c; the cart's button is not a plain link, so the click waits on the code chain (the blank page Adrian saw) |

## What this means for the fixes

- Add to cart / cart / checkout slowness is code delivery, not the API (cart write measured 25.9 ms server-side). Restore
  pre-downloading the cart and checkout code after load (revert ff6ccb2c), keep the edge warm after each deploy, then merge the
  cart and checkout code into a few files so there is no level-by-level chain.
- The server cart adds 1-2 requests to the first add to cart that Vendure did not have; they are fast (tens of ms) but they exist.
- Product images: the soft images are the AVIF quality cap (q50) applied 2026-10-31 to every pre-generated variant plus the
  1,024 px maximum on the product image; being re-encoded (AVIF 65/70) and the larger sizes are a separate, timed deploy.
