# Rotten brand layer on the shared storefront (Plan A25 redo)

Status: layer built and composed on the merged base; **not deployed** (A25a adoption, A26 entry and A27 cutover stay with the owner).
Base: SellRight `main` with brand views PR1 (#207), the gateway (#209), PR2 (#217) and the stock settings (#218), plus this PR (single-segment content paths). The first attempt (`rotten-brand-layer.report.md`, blocked on B1-B4) is superseded: B1-B4 are now closed by slots and data.

## Where it lives
- Layer: the Rotten repo, `storefront/` (`brand.json`, `overlay/`, `overlay.manifest.json`, `pnpm-lock.yaml`), on a local branch `feat/brand-layer-2` of a working clone (not pushed; plan A25: uncommitted in `rotten/` unless the owner asks).
- Composed scratch build: `compose.mjs <layer> --out <scratch>/store --repo <sellright> --apply`, then `pnpm install --frozen-lockfile`, the vendored client build and `build.client`/`build.server` with `SELLRIGHT_DISABLE_SSG=1`. Exit 0; the overlay passes check-imports, check-code-shape and check-l2 (24 overlay code files).

## Blockers of the first attempt, closed
| First attempt | Now |
|---|---|
| B1 brand routes were L1 | `route.home`, `route.content` (about, privacy, terms, slow-fashion, shipping-returns), `route.contact`, `route.blog`, `route.blog-post`, `route.shop`, `route.product` views; `/slow-fashion/` and `/shipping-returns/` are declared single-segment content paths (this PR) |
| B2 header, footer, head ejects | `shell.header`, `shell.footer` views; `src/brand/head.json` (fonts, GTM with implied consent, Facebook verification, canonical policy, favicon, page schemas) |
| B3 `/shop/<slug>` had no home | `routes.json productPath: '/shop/:slug/'`, `shop.detailProducts` (shortsleeveshirt, longsleeveshirt, per-product head copy and FAQPage), `productQuery` (`?style=`/`?sleeve=`), the configurator on the PR2 props |
| B4 slot gaps | `cart.free-shipping-progress` gets `countryCode` (US/PR always free); the guarantee modal is the brand's own component on the home and product views |
| Operational routes | `operational.cartSeedPath: /checkout/facebook/`, `analyticsPath: /api/analytics/performance/` (platform cart seed and event sink, no Meta CAPI) |

## Settings (owner decisions, brand.json)
`shop.stockOnLoad = live` (O1: the shop makes one live, uncached, fail-closed listing read per view on load), `pdp.stockRefreshTrigger = qidle` (the non-Damned default), `pdp.bfcacheRefresh = false`. No stock cache, TTL, debounce or sessionStorage anywhere; missing stock fails closed.

## Not carried (deploy, A26)
`build-production.sh`, `retain-build-assets.mjs`, `assert-no-stale-snapshots.sh` (Node built-ins and executable public files are refused in an overlay since PR1), `public/analytics.js` (replaced by `head.json` analytics), `public/ios-privacy-sw.js` (the base ships one). `brand.json packageScripts` uses the base build; the A26 entry owns the production build script.

## Visual comparison (scratch preview vs live rottenhand.com, 1440 and 390)
The preview mirrors production nginx read-only: `/v1/*` GETs go to the live Rotten API (any other method is refused, nothing is written), `/assets/*` from the asset directory. Pages: home, shop, both product pages, cart drawer (empty: opening it writes nothing), checkout entry, contact. Section heights on the home page match the live page section by section. Differences found and left for the owner's eye:
1. Cart drawer empty state says "Your cart is empty" (base, L1) where the live site says "Your bag is empty"; the cart drawer has no copy seam.
2. The product page's reviews block showed "Loading reviews..." at capture time where live showed "No reviews yet" (base `ProductReviews`).
3. Sleeve buttons on `/shop/` are enabled until the view's one live read answers (live resolved product stock during SSR); the cart drawer opens right after a successful add (live showed the 700 ms "Added" flash first); no badge pop animation in the header.
4. Head: no hero image preload (head.json image preloads need build-hashed URLs), extra iOS/msapplication metas of the legacy head are gone, `/blog/*` font preload (paths are exact), ProductGroup JSON-LD on `/shop/` and per-style material/colour/size facts are dropped (static schemas may not carry commerce types).
5. The base `global.css` still imports Inter from Google Fonts (blocked by the CSP, a console error; Rotten self-hosts Inter).
6. Newsletter and contact submit buttons need `VITE_TURNSTILE_SITE_KEY` in the build environment to start disabled as live does.
