# Damned + Rotten storefront audit — 2026-10-31

Scope: live `www.damneddesigns.com` (Damned) and `rottenhand.com` (Rotten), both on the SellRight core storefront
(Qwik 2.0.0-rc.3, core `0e83b022`, ADR-0001 edge-cached shell). Compared against Damned and Rotten on Vendure
(Qwik beta.45, last tuned 2026-09-26/28). Read-only audit; the fixes it led to are tracked in Orthic-Labs/sellright#425
(see [Fix status](#fix-status)).

## Summary

Both stores regressed badly after the Vendure → SellRight move.

| | Damned on Vendure (2026-09-26) | Damned live today | Rotten on Vendure (PSI) | Rotten live today |
|---|---:|---:|---:|---:|
| Home, LH mobile (Vendure protocol) | **100**, FCP 605 ms | **82**, FCP 2,351 ms | PSI 98 | **81**, FCP 2,351 ms |
| Shop | 100, FCP 495 ms | 70, FCP 3,369 ms | PSI 99 | 72, FCP 3,364 ms |
| Product | 100, FCP 521 ms | 81, FCP 2,352 ms | PSI 99 | 70, FCP 3,367 ms |
| JS requests / JS KB (home) | 55 / 163 KB | 124 / 681 KB | — | 122 / 714 KB |
| Total transfer (home) | 454 KB | 986 KB | 705 KB (PSI) | 958 KB |

Four causes explain nearly all of it, in order of impact:

1. **The startup Qwik JS holds the first frame (~2.35 s, sometimes ~3.37 s), on every page of both brands.** Proven by A/B
   on live Damned home: blocking `/build/q-*` and the bundle graph brings first paint to **594 ms** (Vendure: 605 ms);
   blocking all fonts changes nothing (2,356 ms); blocking GTM changes nothing for paint (2,356 ms) but lifts the score to
   95 by removing blocking time.
2. **Qwik's speculative preloader is on.** 115-271 script requests and 650-1,011 KB of JS per page (checkout: 264-267
   scripts, ~1 MB). Vendure ran `preloader: false` plus a targeted warm graph (144 → 55 scripts) and had measured
   re-enabling it and rejected it (`damned/docs/PERFORMANCE-2026-09-27.md`).
3. **The global stylesheet is render-blocking** (`<link rel=stylesheet>` to a 97 KB / 119 KB file at the end of `<head>`).
   Vendure measured exactly this and rejected it (FCP 599 → 1,332 ms). It came in with bedbed29 (2026-10-31), unmeasured.
4. **Google Tag Manager: 300 KB, 0.5-0.9 s of main-thread time** (plus, on Rotten, an OpenAI ads pixel loaded by the GTM
   container: 36 KB, 1.3 s bootup in simulation). This is the blocking time (TBT 500-570 ms) on every page.

Also: five public route loaders refetch their data in the browser (`/q-loader-*.json`), the stock and session reads start
only after Qwik boots, Rotten's shop page carries its JSON-LD twice, and core hard-codes Damned's payment hosts as
`dns-prefetch` on every brand.

## Method

- **Vendure protocol (primary)**: the exact settings Damned's Vendure-era report used
  (`damned/store/scripts/measure-performance.mjs`): Lighthouse 13.0.3, mobile, `--throttling-method=devtools`,
  150 ms latency, 1,600/750 Kbps, CPU ×4, median of 3 runs. Vendure baselines are the retained reports in
  `damned/tmp/performance-20260926/{before,complete}`. Today's runs: `~/sites/tmp/audit-20261031/{dd,rh}-devtools/`.
  The Vendure runs used HeadlessChrome 152, today's 156; a control page (example.com) paints at 256 ms under today's
  harness, so the paint hold is not a harness artifact.
- **Lighthouse default (Lantern simulate)**: the speed-gate baselines from earlier today
  (`~/sites/tmp/speed-gate/{dd,rh}/base-0e83`). Same model as PSI, different hardware; numbers are lower than PSI.
- **PSI**: Rotten's and Damned's Vendure-era PSI results are from their reports; the PSI API was over quota today.
- **Structure**: live HTML/headers fetched with curl (`html/`), parsed by `anal.py`; build manifests compared directly.
- **A/B**: Lighthouse with `--blocked-url-patterns` on live Damned home (`ab/`).

## Scores — Vendure protocol (median of 3, mobile)

| Page | Damned Vendure | Damned now | Rotten now |
|---|---|---|---|
| Home | 100 · FCP 605 · LCP 605 · TBT 1 · 55 js / 163 KB | 82 · 2,351 · 2,351 · 511 · 124 / 681 KB | 81 · 2,351 · 2,351 · 547 · 122 / 714 KB |
| Shop | 100 · 495 · 888 · 0 · 55 / 163 KB | 70 · 3,369 · 3,369 · 544 · 117 / 661 KB | 72 · 3,364 · 3,364 · 521 · 134 / 742 KB |
| Product | 100 · 521 · 1,277 · 56 · 80 / 217 KB | 81 · 2,352 · 2,352 · 540 · 145 / 717 KB | 70 · 3,367 · 3,367 · 563 · 156 / 792 KB |
| Blog | — | 83 · 2,351 · 2,351 · 488 · 89 / 594 KB | 71 · 3,374 · 3,374 · 526 · 84 / 616 KB |
| Checkout | — | 81 · 2,353 · 2,353 · 549 · 267 / 973 KB | 81 · 2,365 · 2,365 · 565 · 264 / 1,011 KB |

Vendure-era PSI mobile (Lantern, Moto G Power): Damned home 94; Rotten home 98, shop 99, product 99, checkout 89.
Lantern on this box today (earlier baseline): Damned 32-47, Rotten 33-40 mobile.

## Root causes and evidence

### 1. First-frame hold by the startup JS (all pages, both brands)

- FCP clusters at ~2,351 ms or ~3,367 ms on every page, and on blog/product/checkout the `load` event fires **before**
  first paint (Damned blog: load 1,867 ms, first paint 2,352 ms). Nothing is painted, not even the background.
- The CSS (18 KB br) has arrived at ~1,031 ms; the main thread shows no long task over 122 ms before paint.
- A/B, live Damned home, Vendure protocol:

  | Variant | First paint | Score |
  |---|---:|---:|
  | as live | 1,504-2,356 ms | 79 |
  | all `.woff2` blocked | 2,356 ms | 81 |
  | GTM + CF beacon blocked | 2,356 ms | 95 |
  | `/build/q-*` + bundle graph blocked | **594 ms** | 82 |

- Vendure's own "before" release (beta.45, preloader on, 144 scripts) still painted at 599 ms, so the hold is specific to
  this build's startup graph (rc.3 + SellRight's qinit/qidle tasks + preloader), not to "many scripts" alone. The fix
  (preloader off, #425 step 3) is gated on staging before any deploy; if first paint is still held after it, the next
  suspects are the qinit handler chain (the loader awaits handlers serially) and `useVisibleTask$` mounts.

### 2. Preloader on (`vite.config.ts:140` preload graph plugin, 48c023e0)

- Live per-page JS: Damned home 124 requests (35 before first paint, 56 after load); checkout 267 requests, 541 KB of
  first-party JS **after** load. Build: 885 bundles / 1.48 MB / 989 symbols (Vendure: 516 / 1.23 MB / 651).
- Vendure 2026-09-27: "Restoring Qwik's general preloader with one idle slot … increased JavaScript requests from 94 to
  157, while product readiness did not improve. It was rejected."

### 3. Render-blocking stylesheet (bedbed29)

- Live: `<link rel="stylesheet" href="/build/style-*.css">` is the last element in `<head>`; 96,607 B raw (17 KB br) on
  Damned, 118,702 B (20 KB br) on Rotten; LH flags it render-blocking on every page.
- Vendure: critical CSS inline + the full sheet loaded after `load` (with a `<noscript>` fallback). Its report measured
  the plain external sheet: home FCP 599 → 1,332 ms, shop 512 → 1,372, product 521 → 1,475. Rejected.

### 4. GTM (and Rotten's OpenAI pixel)

- `gtm.js` + `gtag/js` ≈ 300 KB; 0.5-0.9 s main-thread; LH "unused JavaScript" 109-141 KB of it. Starts ~2.4-3.4 s
  (first interaction or a 4 s timer, 3a578ac4), inside Lighthouse's window, so it is the TBT on every page.
- Rotten loads `bzrcdn.openai.com/sdk/oaiq.min.js` through the GTM container (not in code).
- Owner decision 2026-09-28: GTM for every visitor, no consent gate (damned cfadacf). Moving it after `load` keeps that.

### 5. Route loaders refetch their JSON

- Qwik Router rc.3 defaults loader serialization to `never` (`@qwik.dev/router/lib/chunks/head.qwik.mjs:29`). Loaders
  without `serializationStrategy: 'always'` are refetched as `/q-loader-*.json` when a client re-render reads them:
  `platform/home-spotlight.ts:28` (Damned home spotlight — the "CHECKING STOCK…" block), `platform/shop.ts:28`,
  `platform/product-detail.ts:110`, `platform/blog.ts:15/20/31`, `platform/configurator-detail.ts:82`,
  `platform/content-review-summary.ts:8`, `routes/collections/[slug]/index.tsx:22`.
- Vendure found and fixed the same ("Product rerenders following live stock were consequently refetching metadata …
  loaders now serialize … with `always`").

### 6. Live reads start after Qwik boots

- Stock (PDP/spotlight) at `qinit`; session/identity at `qidle` (`routes/layout.tsx:248`); loyalty/config and
  pay-later on idle or interaction. Ads measured in a real browser: Damned home stock request at 689 ms desktop,
  4,151 ms with any query string. Adrian's decision #415: every read starts at document parse.

## Damned: Vendure vs SellRight

| Area | Vendure (2026-09-28) | SellRight live (0e83b022) |
|---|---|---|
| Qwik | 2.0.0-beta.45 | 2.0.0-rc.3 |
| Preloader | off; cart render graph warmed after load; product closure at DCL (low); checkout on intent | on (pruned graph); 115-271 scripts/page |
| Global CSS | critical inline (85 KB) + full sheet after `load`, noscript fallback | full sheet render-blocking link (97 KB); 20 KB other inline styles |
| Home HTML / Qwik state | 143,320 B / 16,286 B | 90,252 B / 27,146 B |
| Shop HTML / state | 155,517 B / 36,779 B | 130,249 B / 45,737 B |
| Product HTML / state | 164,826 B / 32,748 B | 104,274 B / 28,884 B |
| Font preloads | 3 (Cormorant 700, 700i, Plex 400) | 3 in HTML + Cloudflare `Link` header sent twice on home |
| Loader serialization | `always` for catalog/product/related | `never` (default) for spotlight, catalog, brand PDP, blog |
| Stock read start | `useProductStock` hook, request handler captures only the slug (median 825 ms first product, throttled) | qinit after controller restore; 689 ms desktop / 4,151 ms with a query string (Ads' measurement) |
| Public navigation | document navigation (0 SPA links on home) | document navigation on Damned (0 of 22 links); Rotten SPA (30 of 31) |
| BFCache | `pageshow.persisted` refreshes stock | same (`stock-triggers.ts:31`) |
| Analytics | GTM for every visitor (after 2026-09-28) | GTM on first interaction or 4 s |
| Service worker | image cache worker | same image cache worker (unbounded cache, no eviction) |
| Header glass | SVG displacement + blur | same; F1 (b0c7bb54, not live) defers blur/scroll-timeline to after paint |
| Routes | 44 | 62 (account passkeys/rewards/magic-link, collections, subscriber, cart-link, …); `/reviews/` still 200 |
| Product JSON-LD | offers in HTML | no `offers` in HTML (ADR-0001 DP-2: filled by the client) |

## Rotten specifics

- 5 font preloads (Fraunces 400/500, Montserrat 300, Inter 400/500) plus a hero image preload; Cloudflare adds a
  `Link` header for 2 more fonts on home.
- Shop page: two ~10 KB `ProductGroup` JSON-LD blocks in the HTML **and** the same strings escaped again in the Qwik
  state (state 71 KB, page 168 KB raw). PDP state 48 KB; blog state 53 KB.
- Home product cards: `sizes="(max-width: 600px) calc((100vw - 40px) * 3.5), 1870px"` makes phones pick the 1,280-2,048 px
  candidates of a flat-lay PNG preset; the `<img>` fallback is `?preset=xxl` (2,048×1,024).
- `dns-prefetch` to `secure.nmi.com`, `services.sheerid.com`, `gateway.sezzle.com`, `sandbox.gateway.sezzle.com`,
  `ipapi.co`, `api.country.is`, `get.geojs.io` — Damned's providers; Rotten uses Stripe. Hard-coded in
  `components/head/head.tsx:118-130` for every brand.

## Qwik best-practice findings (core)

- 129 `useVisibleTask$` in core; on public pages several exist only to set a cleanup flag
  (`platform/controllers/shell.tsx:31`, `platform/controllers/shop.tsx:45`), which forces their component closure to load
  on visibility. Use `useTask$` cleanup or a `useOn` handler.
- 38 `qinit` and 21 `qidle` handlers; the loader awaits `qinit` handlers serially, so one slow handler delays the rest.
- Serialized state is larger than Vendure's on home (27 vs 16 KB) and shop (46 vs 37 KB); head JSON-LD is serialized into
  state (Rotten shop).
- Route loaders: default `never` serialization (above); `strictLoaders` default means loaders without `search` never see
  query params, which is correct for these pages.
- `readHomeSpotlight`, `readShopCatalog`, `readBrandProductDetail` are `server$` POSTs for live values; they cannot start
  before Qwik boots (#415 replaces them with parse-time GETs).

## E-commerce best-practice findings

- Product JSON-LD has no `offers` in the HTML on either brand (DP-2: price is a live value). Google renders JS, but
  merchant listings read offers more reliably from HTML; the merchant feed stays the crawl source (accepted in ADR-0001).
- Product image `q=` parameter is ignored by the image service (same bytes for q=65/80/85); card AVIFs are 40 KB at 512 w.
  LH estimates 27-67 KB of image savings on home/shop.
- Checkout loads ~1 MB of JS for an empty cart.
- Cloudflare `Link` early-hint headers are configured in the dashboard, not code; Damned home sends the header twice.

## How it got approved

- `ops/cutover/FINAL-READINESS-AUDIT.md` (1 Oct GO) gated payments and correctness only. Performance parity with Vendure
  was never a criterion (Ads confirms: not in its records either).
- No SellRight document referenced `damned/docs/PERFORMANCE-2026-09-26/27.md` or `rotten/docs/PERFORMANCE*`; their
  rejected experiments (external CSS, preloader on) and fixes (loader `always`, early stock hook) were never ported.
- bedbed29 (render-blocking stylesheet) and 48c023e0 (preloader graph) shipped without before/after measurement; the
  speed gate only exists since 2026-10-31 (#422).

## Fix status

Orthic-Labs/sellright#425 (Adrian: "fix everything in source and make sure my scores are back to 100"). Order: core →
demo → rightsites → Damned + Rotten, each gated (Vendure protocol, median of 3, mobile + desktop, both brands).

| Step | Change | Commit | Status |
|---|---|---|---|
| 1 | public loaders `serializationStrategy: 'always'` | 3653e558 | live 8ecdaf9b |
| 2 | global stylesheet inline (built file read once per process, link fallback) | 957f0111 | live 8ecdaf9b |
| 3 | `preloader: false` + warm graph; warming narrowed to intent only | 957f0111, ff6ccb2c | live (warm cut not yet) |
| 4 | first-frame hold | — | cause = startup JS (A/B); expected fixed by step 3, verified by the gate |
| 5 | #415 every API read at document parse | 3967365c, de4bc832, f283b58c | live (license part not yet) |
| 6 | 1456f5e3 (pill labels) + edge purge on dd/rh deploys | in core | ships with the chain |
| 7 | GTM after `load`; per-brand `dns-prefetch`; GTM on first interaction | 3967365c; 3959d33e | live; interaction-only waits on GA4 check |

## Live now (8ecdaf9b, deployed 2026-10-31 21:15 UTC) vs Damned on Vendure

Live Lighthouse is measured off the box (Ads, Adrian's PC, Lantern default, median of 3); the Vendure column is its PSI result
(same Lantern model) and its retained local reports.

| Damned | Vendure (2026-09-28) | Live now | Still different |
|---|---|---|---|
| Home, mobile / desktop | PSI 94 | 54 / 90 (FCP 5,190, LCP 6,696, TBT 366) | first paint held on cached pages (below) |
| Shop | — | 74 / 93 (FCP 2,895, LCP 3,401) | dynamic since DP-6; fine |
| Product | — | 53 / 89 (FCP 5,339, LCP 7,227) | same hold as home |
| Blog / checkout | — | 61 / 89, 78 / 93 | |
| Scripts on home (count / KB, incl. GTM) | 55 / 163 KB (GTM consent-gated then) | 158 / 749 KB | ~120 were the warm graph (fixed in core ff6ccb2c, not live); ~35 are startup handler chunks; ~300 KB is GTM |
| Global CSS | critical inline + full sheet after load | full sheet inline (117 KB raw, ~17 KB br), no blocking link | equal for paint per the Vendure measurement; HTML is heavier |
| Preloader | off + narrow cart warming | off; warm graph too broad until ff6ccb2c | |
| Loader serialization | `always` on catalog/product | `always` on every public loader | same |
| Stock read start | qinit hook, ~825 ms throttled | parse-time fetch, ~194-300 ms | better |
| Shop listing | SSR from manifest | SSR from live stock per request (DP-6) | |
| Edge cache | Cloudflare HTML 4 h + swr | ADR-0001 shell, 1 h, instant purge; shop/checkout dynamic | |
| Font preloads | 3 in HTML + CF early hints | 1 in HTML + CF early hints (Link header on cached responses) | |
| GTM | consent-gated, later every visitor | after load (first-interaction-only build 3959d33e waits on the GA4 check) | |
| Serialized state (home / shop / product) | 16 / 37 / 33 KB | 31 / 37 / 29 KB | home larger |

**Open: the first-paint hold on edge-cached pages.** Same body as the dynamic render (verified by diff); on cached pages the whole
HTML arrives at ~315 ms, Qwik's loader starts its startup-handler chunk chain before the first frame, and the frame waits for it
(main thread idle 475-1,419 and 1,474-2,469 ms on dd home; first paint 2,579 ms). Dynamic pages paint while the HTML streams,
before Qwik starts. Earlier A/B on the box: blocking `/build/q-*` moved first paint to 594 ms. Confirmation A/B pending (Ads);
candidate fix: start Qwik's loader after the first frame.

## Evidence

- `~/sites/tmp/audit-20261031/`: `{dd,rh}-devtools/` (Vendure protocol), `ab/` (A/B), `html/` (live HTML + headers),
  `anal.py`, `lhx.py`, `devsum.py`, `waterfall.mjs`.
- `~/sites/tmp/speed-gate/{dd,rh}/base-0e83/` (Lantern baselines).
- Vendure: `damned/docs/PERFORMANCE-2026-09-26.md`, `PERFORMANCE-2026-09-27.md`, `damned/tmp/performance-20260926/`;
  `rotten/docs/PERFORMANCE-2026-09-27.md`, `PERFORMANCE-AUDIT-REMAINING-2026-09-27.md`.
