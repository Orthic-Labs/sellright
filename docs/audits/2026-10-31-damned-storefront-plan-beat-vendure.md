# Damned storefront: every place it is worse than the Vendure version, and the plan to beat it

Basis: code and build comparison (`2026-10-31-damned-vendure-vs-sellright-code-diff.md`). Vendure = `~/sites/damned/store`
(Qwik beta.45). SellRight = live Damned (core b2f69ebc, Qwik rc.3).

## 1. Why there are so many more code files when the design did not change

The pages look the same; the code behind them is not. Code symbols: 989 vs 651 (+338), bundles 888 vs 516. Where the extra 338
come from (counted from both build manifests):

| Source | Vendure | SellRight | Extra | Cause |
|---|---:|---:|---:|---|
| `platform/controllers` | 0 | 68 | +68 | The multi-brand platform layer: every page is a controller component that builds view data, wrapping a view component |
| `brand-slots` + `brand` | 0 | 50 | +50 | Brand overrides render through slot components: a second component layer around each view |
| `platform/*` (gateway, views, widgets, license) | 0 | 54 | +54 | Slot gateway, view contracts, widgets (pay later, restock, loyalty), license-flow stubs |
| `components/checkout` + `routes/checkout` | 51 | 132 | +81 | Checkout rewritten for the server cart, server quotes and several payment gateways |
| `routes/account`, `orders`, `sign-in`, `components/account`, `loyalty` | 77 | 156 | +79 | New account features (passkeys, rewards, magic link, order pages) |
| `components/cart` + `cart-contents` | 27 | 39 | +12 | Server-cart states (sync, conflicts, revisions) |
| Probe routes shipped to production | 0 | 5 | +5 | `__platform-reexport-probe`, `__express-buy-now-probe` (test routes, 404 live but built) |

By kind: `$` closures 306 vs 187, `component$` 220 vs 125, `useVisibleTask$` 67 vs 21. Qwik puts almost every symbol in its own
file (`entryStrategy: smart`), so +338 symbols became +372 files, 775 of them under 3 KB.

**What we got wrong:** SellRight was built as a generic platform (any brand, any store) on top of the Damned design, and the platform
indirection (controller -> slot -> view) plus features Damned does not use are all compiled and shipped. Nobody set a code budget
per page, and the bundle count was never compared with the Vendure build.

## 2. Every place it is worse, and the exact fix

Status: **live** = fixed and deployed; **ready** = committed, not deployed; **todo** = planned here.

### Cart, add to cart, checkout (the 7 s and the blank checkout)

| # | Worse than Vendure | Exact fix | Status |
|---|---|---|---|
| C1 | Add to cart waits for the server: the click awaits `POST /v1/shop/cart` (first add) + `PATCH /v1/shop/cart/{token}/lines` before the drawer opens (`configurator.ts:155` -> `addToCartWithOutcome` -> `CartService.addLine`). Vendure: instant, local. | Local-first cart (section 3): the click updates the local cart and opens the drawer immediately; the server write runs in the background. | todo (needs your decision on the stock wording, section 3) |
| C2 | Opening the cart fetches its code on the click in serial levels (ff6ccb2c removed the after-load download). Vendure downloaded the cart code after load. | Revert ff6ccb2c (cart code downloads at idle after load again). | todo, first deploy |
| C3 | Checkout from the cart: the checkout code is fetched on the click; the cart's checkout button is not a link, so the intent warm-up never fired -> blank page with the old page behind. | Same revert; plus download the checkout code as soon as the cart holds an item (not only on link intent). | todo, first deploy |
| C4 | After every deploy the new file names are cold at Cloudflare; each cold file costs a trip to the US origin (~0.75 s). | Deploy step: request every new `/build/` file through the public hostname once (both brands). | todo, first deploy |
| C5 | Cart code: 80 files (Vendure 49); checkout code: 162 files (Vendure 54). | Merge into one cart file and one or two checkout files (section 4, P2). | todo |
| C6 | Cart lines need server revisions/locks (`navigator.locks`, revision retry) on every change. | With the local-first cart the server sync is batched (debounced lines, one PATCH), never on the UI path. | todo |

### Page load

| # | Worse than Vendure | Exact fix | Status |
|---|---|---|---|
| L1 | 888 bundles, 775 under 3 KB; startup pulls ~35 tiny files in waves. | Group code by page and feature (startup, home, product, cart, checkout) with Qwik's `entryStrategy.manual` / Rolldown `codeSplitting.groups`; target under 40 files per page start. | todo (P2) |
| L2 | Controller + slot + view layers: two or three components per view. | Flatten: brand views render the page directly; controllers become plain hooks/functions (no `component$`), view data built in the loader. | todo (P3) |
| L3 | `useVisibleTask$` used only to set a cleanup flag force their component's code to load: `platform/controllers/shell.tsx:31`, `platform/controllers/shop.tsx:45`, `platform/controllers/configurator.ts:122`. | Replace with a disposal check that needs no task (generation counter in the store, checked when a response lands). | todo (P1) |
| L4 | 6 `qinit` + 4 `qidle` handlers on the product page (Vendure 4 + 2); the loader runs `qinit` handlers one after another. | One `qinit` handler per page that starts everything it needs (one file). | todo (P2) |
| L5 | Every render calls the API 2-4 times: `/v1/shop/identity` and `/v1/maintenance` on every render, plus page data. Vendure read catalog files from disk. | Keep identity in process memory (it changes only when the store is edited; the existing purge hook clears it); maintenance from the API's purge event, not per render; product JSON-LD from the catalog snapshot. Target: 0-1 API calls per render. | todo (P1) |
| L6 | Home and product: the browser makes 3 requests at page start for stock and prices (ADR-0001: values are not in the cached HTML). Vendure: 0 on home, 1 on product. | One batched live-values endpoint per page (stock + prices + config in one GET), started at document parse. | todo (P1) |
| L7 | HTML 196 KB vs 143 KB: the whole stylesheet is inline (117 KB vs Vendure's 87 KB critical subset). | Critical CSS per page group inline, full sheet loaded after `load` (Vendure's method); measure before shipping. | todo (P3) |
| L8 | Serialized page state 31 KB vs 13 KB on home, 37 vs 18 KB on shop (loaders return whole objects; head JSON-LD serialized into state). | Loaders return only the fields the page renders; JSON-LD built at render, never in state. | todo (P3) |
| L9 | Qwik's speculative preloader was on (115-271 files per page). | Off; targeted warming. | live |
| L10 | Render-blocking external stylesheet (bedbed29). | Stylesheet inline again. | live |
| L11 | Page data refetched in the browser (`/q-loader-*.json`): loaders defaulted to `never` serialization. | `serializationStrategy: 'always'` on every public loader. | live |
| L12 | Stock read started after app boot (~0.7-4 s). | Stock and every page read start at document parse. | live (better than Vendure: ~200-300 ms) |
| L13 | Qwik's startup ran before the first paint on cached pages. | Loader starts after the first frame. | live |
| L14 | Shop page shifted as out-of-stock cards were removed (CLS 0.36-0.52). | Shop rendered with live stock per request (DP-6). | live |
| L15 | Google Tag Manager on every page's main thread (300 KB, 0.5-1 s). | Load on the first interaction (3959d33e). | ready, waiting on the GA4 check |
| L16 | Test routes in the production build. | Exclude `__*-probe` routes from production builds. | todo (P1) |
| L17 | `dns-prefetch` to providers Damned or Rotten do not use. | Per-brand list from the store's own gateway config. | live |

### Images

| # | Worse than Vendure | Exact fix | Status |
|---|---|---|---|
| I1 | All pre-generated AVIF variants capped at quality 50 (dce2ccce9). | Quality table: AVIF 65 (product sizes, the Vendure quality), 70 for large and up; WebP/JPEG 85 for large and up; all variants re-encoded. | in progress (re-encode running) |
| I2 | Product image stops at 1,024 px; phones capped at 819 px (86e3239f). Vendure served 1600x2000. | Sizes up to 1,638 px real width, truthful `sizes`, preset map fixed, revision parameter to replace cached soft files. | ready (parked, separate timed deploy) |

### Product options

| # | Worse | Exact fix | Status |
|---|---|---|---|
| O1 | A value is greyed when it is unavailable with the current other choice (Fenrir with Black), so it cannot be clicked (#426). | Grey only when no in-stock variant has the value; clicking an available-elsewhere value selects it and clears the conflicting choice. | todo (P1) |

## 3. Cart: local first, server in the background

**Today (worse):** the cart exists only on the server. First add: create the cart, then write lines, then the drawer opens; every
change waits for its server round trip and revision check.

**Target (better than Vendure):**

1. **The browser owns the cart for display.** Add / change / remove update the local cart (memory + `localStorage`) and the
   drawer at once: 0 ms of network on the click.
2. **Server sync in the background.** One sync queue: changes are coalesced (several clicks = one `PATCH`), the cart is created on
   the first sync, retries are automatic. Nothing in the UI waits for it.
3. **Stock stays live (LOCKED rules unchanged).** The add's server response is the live stock check for that item: if it says the
   item cannot be bought, the line is marked unavailable in the drawer with the reason (fail closed). Cart open, checkout entry and
   place order still read live stock exactly as today; no stock cache, TTL or debounce of stock reads (the coalescing is of cart
   writes, not stock reads).
4. **Checkout** waits for the sync queue to be empty, then does its locked live read; the order is placed from the server cart.
5. **Multi-tab / multi-device**: the server cart stays the source of truth for checkout; a tab adopts a newer server cart on focus.

**Owner decision needed:** with this, the visitor sees an item in the drawer before the server has confirmed stock for it (a
fraction of a second later it can turn "unavailable"). Vendure behaved this way (local add, stock checked at cart open). The LOCKED
test "an OOS product must show OOS on ... cart-add" would read "within the add's own live response". Without your yes, the
fallback is: drawer opens immediately with the line marked "checking", confirmed by the response; still no blocking.

## 4. Plan to beat the Vendure version

Targets (Damned, mobile), each measured before it ships (code size and request counts from the build; timings in a visible
browser by Ads; PageSpeed Insights from Google):

| Measure | Vendure | Now | Target |
|---|---:|---:|---:|
| JS files at page start (home / product) | ~55 / ~80 | ~100+ | under 40 / under 50 |
| JS bundles in the build | 516 | 888 | under 350 |
| Add to cart -> drawer visible | instant (local) | 4-7 s | under 100 ms |
| Cart -> checkout visible | link hint | blank, seconds | under 300 ms |
| API calls per page render (server) | 0-1 | 2-4 | 0-1 |
| Browser API calls at page start (home / product) | 0 / 1 | 3 / 3 | 1 / 1 |
| Home HTML | 143 KB | 196 KB | under 140 KB |
| Home page state | 13 KB | 31 KB | under 12 KB |
| PageSpeed Insights mobile | home 94 | 97-98 | 100 |

Phases (one deploy each, every click path timed before it ships):

- **P0 now:** revert ff6ccb2c (C2, C3); post-deploy edge warm (C4); deploy Damned then Rotten.
- **P1 (days 0-1):** image quality and sizes (I1, I2); options (O1, #426); cleanup-only visible tasks (L3); probe routes out (L16);
  API calls per render (L5); one live-values request per page (L6); GTM on interaction after the GA4 check (L15).
- **P2 (days 1-3):** code grouping (L1, C5): one file each for startup, cart, checkout and per page; one `qinit` per page (L4).
  Target under 40 files at page start.
- **P3 (days 2-5):** local-first cart (section 3, C1, C6) after your decision; flatten controller/slot/view (L2); critical CSS
  (L7); smaller page state (L8).
- **Gate for every step:** build output (files, KB), request count per page, add to cart and checkout timed in a visible
  browser, PSI mobile; anything slower than before does not ship.
