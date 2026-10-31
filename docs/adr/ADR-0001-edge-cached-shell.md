# ADR-0001: Cache every storefront HTML shell at the edge; fetch only live values

- Status: **accepted** (Adrian, 2026-10-31; relayed by the Ads chat). Realization: **live** 2026-10-31 on rightsites store.*, Damned and Rotten (see Realization).
- Owner: SellRight core (storefront + API). Decision authority: Adrian.
- Supersedes: storefront cache policy 2026-10-11.1 (commits 98f465f5, bf56ffff) and the blog/content-only edge cache added in #408 wave 1 (`SELLRIGHT_EDGE_HTML_CACHE`).
- Related: #360 (P4b, P7), #408, `~/sites/CLAUDE.md` Stock Architecture (LOCKED).

Adrian, 2026-10-30: "actually even for checkout. the html, should be cached, shouldn't it? only the values should come fresh."

## Decisions taken

- **DP-1** Price is a **live value**, not in the cached shell. It renders into space reserved in the shell (no layout shift). JSON-LD `offers` is filled by the client after the live read; the merchant feed (`no-store`) stays the crawl source.
- **DP-2** PDP JSON-LD availability is never in the shell; filled by the client.
- **DP-3** Account pages are out of scope (they redirect on a cookie).
- **DP-5** (2026-10-31, by measurement) `/checkout/` is `dynamic`. Its LCP is the visitor's order summary: uncached, the server renders it from the cart cookie (~0.4 s at m375); a cached shell must fetch it in the browser after hydration (~4.1-4.2 s at m375 even with one entry read). Adrian's 2026-10-30 rule "all pages except checkout cached" stands.
- **DP-4** Stock rules are unchanged. The LOCKED doc only records that the shop's manifest read moves from SSR to the browser, still uncached (owner edits that doc).

## Invariants

- **I-1** No stock value is ever served from a cache (edge, browser, service worker, memory).
- **I-2** No cacheable response varies by visitor. Structural: a `shell` render runs on an anonymous request context; the SSR layer strips `Cookie`, `Authorization` and preview inputs before any loader runs. Cacheable responses carry no `Set-Cookie`.
- **I-3** A cacheable response is identical for every query string; query-dependent routes (`/search?q=`) are `dynamic`.
- **I-4** Every input a cacheable page renders has a purge trigger.
- **I-5** Fail closed: an unclassified route is `dynamic` (`no-store`).
- **I-6** Cacheability is decided **after render**: route class `shell`, HTTP 200, store published, maintenance off, not a fallback or error render, no `Set-Cookie`, anonymous context. Anything else is `private, no-store`.

## Route classes

| Class | Routes | Header (only when I-6 holds) |
|---|---|---|
| `shell` | `/`, `/shop/`, `/products/*` (and the brand product path), `/collections/*`, `/blog*`, `/about`, `/contact`, legal pages (`/checkout/` is excluded per store with `SHELL_CACHE_EXCLUDE`, DP-5) | `public, max-age=0, s-maxage=<TTL>` (no stale-while-revalidate) |
| `dynamic` | `/checkout/` (DP-5), `/checkout/payment/`, `/checkout/cart-link/`, `/checkout/<alias>/`, `/checkout/confirmation/*`, `/account*`, `/sign-in`, `/search`, `/track-order`, `/verify*`, password routes, `/api/*`, `/cache*`, preview requests, every unclassified path | `private, no-store` |
| `data` | Qwik loader/action data, `/v1/*` | `private, no-store` |

The origin's `Cache-Control` is the single authority; Cloudflare rules are eligibility only.

## What changes

1. **Shell free of per-visitor data (I-2):** anonymous render context for `shell` routes; `useAuthLoader` stops serialising customer data (header/account UI read `/v1/shop/me` in the browser); `countryCode` read client-side; `sr_legacy_cart` set from a `no-store` endpoint; preview requests `dynamic`.
2. **Shell free of stock (I-1):** home spotlight/features, search and collections show availability from a live read on load (PDP fail-closed default); the shop grid reads the manifest snapshot in the browser on load, `no-store`.
3. **Price live (DP-1)** into reserved space; JSON-LD offers client-filled.
4. **CSP by hash, no nonce** on cacheable responses. Prove Qwik inline bootstrap is byte-stable per build (K-1). No shared-nonce fallback; if hashes are infeasible, the switch stays off (C-4 edge nonce is the path).
5. **Purge:** remove HTML purges on stock commits; add purges for content/blog publish (page, `/blog/`, `/`), collection change (collection, `/shop/`), theme/store identity/CSP-affecting settings and maintenance toggle (everything for the host). Size worst cases against Cloudflare plan purge limits (K-3); retry with alerting.
6. **Policy and tests:** `route-cache-policy.ts` to the classes above, decided at response end (I-6), behind `SHELL_CACHE` (default off: headers stay `no-store`). Tests: signed-in vs anonymous byte identity per `shell` route; stock absence; price absence; no `Set-Cookie`; error/maintenance/unpublished renders on `shell` paths are `no-store`.
7. **Cloudflare rules** (dd, rh, rightsites zones) respect origin headers. sellright.cc out of scope.
8. **Docs:** `docs/ARCHITECTURE.md`, route policy comments.

## Quality scenarios

- **QS-1a** ≥90% edge HIT per page type over 24h; HTML TTFB p75 ≤200 ms US, ≤400 ms India.
- **QS-1b** (joint with #360 P7) m375 throttled: LCP ≤2.0 s, CLS ≤0.05 on home, shop, PDP, blog, checkout-with-cart.
- **QS-2** After a stock commit the next load shows true availability; OOS test passes on shop, PDP, cart-add, checkout entry, place-order.
- **QS-3** Zero personal data in any shared-cacheable response; signed-in render byte-identical to anonymous; canary after deploy and every 15 min.
- **QS-4** Cacheable responses carry a nonce-free CSP (hashes, no `'unsafe-inline'` for scripts); live canary confirms resume and no CSP violations; on failure switch off + purge.
- **QS-5** Content/price/theme/identity changes visible within 60 s via purge.
- **QS-6** Maintenance on/off visible within 60 s (purge-all; maintenance response `no-store`).
- **QS-7** Purge failures logged, retried, alerted; never store an error/fallback/unpublished render.

## Rollout

1. **Core:** §1–4 and §6 as separate behaviour-preserving commits with the switch off.
2. **Demo:** switch on, TTL 300 s; canaries and conformance check; measure against `perf/BASELINE-2026-10-30.md`; TTL 3600 then 86400 only after 24 h clean.
3. Rightsites, then Damned, then Rotten (owner go), full-host purge at switch-on.

Kill criteria (any → switch off + purge-all for the host): privacy canary, CSP/resume canary, OOS test, edge 5xx above baseline on shell routes, QS-1a unmet after 48 h, QS-1b regression. Rollback: switch off + purge-all; code commits revert individually; no data migration.

## Known unknowns (close before rollout step 2)

- **K-1** Qwik inline script byte-stability per build (decides hash CSP).
- **K-2** PDP JSON-LD availability source on main.
- **K-3** Cloudflare purge-by-URL limits vs worst-case URL counts.
- **K-4** Whether Cloudflare stores `Set-Cookie` responses under the current rule (moot if I-6 holds).

Council round 1 (2026-10-30) was degraded (3 of 6 seats); its findings were applied as advice. Security-ops and user-outcome angles are not yet reviewed.

## Realization (2026-10-31)

- Storefront: SellRight 2e0c7a3a (S1-S3, license-flow prices live, shell PDP stock "not known yet", per-request `shellRender()`, `SHELL_CACHE_EXCLUDE`, shop/checkout shells, checkout entry = one live read). API: S4 purge hooks + multi-host/zone fan-out (`STOREFRONT_HOSTS_BY_STORE`, `CLOUDFLARE_ZONE_ID_BY_HOST`).
- Switch (TTL 300): rightsites store.* all shell routes; Damned and Rotten all shell routes except `/checkout/`. Rotten PDP stock refresh moved to `qinit` (Adrian, 2026-10-31).
- Verification: `deploy/edge-conformance.mjs --allow --exclude --save-dir` (value/stock/identity scan, Cloudflare email-obfuscation and JS-detection normalised); origin proof signed == anonymous 10/10 per route; Rotten OOS check 9/9 with the switch on; purge timing admin edit -> edge: Rotten 466 ms, rightsites 418 ms.
- Measured (bench.mjs, m375 throttled, before -> after): home Damned 604 -> 316-344 ms, Rotten 584 -> 340-348 ms; shop Damned 456 -> 392 ms, Rotten 888 -> 728-772 ms; cached-page TTFB at origin ~10 ms (from far regions, Ads' laptop: HIT ~0.33-0.37 s vs MISS 1.0-1.2 s). Checkout: DP-5.
- Cloudflare JavaScript detections inject an inline script that the nonce-free shell CSP blocks (accepted, Ads 2026-10-31).

## Owner decisions (GitHub issues, label `decided`)

Every decision Adrian makes on this contract is an issue in Orthic-Labs/sellright, recorded here with its link and his words; commits that realize one cite it.

| Issue | Decision | Adrian | State |
|---|---|---|---|
| [#415](https://github.com/Orthic-Labs/sellright/issues/415) | The live stock read starts as soon as the page lands: an inline, non-blocking script first in `<head>` on every store page fires the live API reads in parallel with the page; it depends on nothing (not Qwik boot, not load). Qwik consumes the result once. Acceptance: stock request start <= 200 ms after navigation start, every store page, with and without query strings, measured live. Supersedes the `qinit` timing of #419. | 2026-11-01: "I clearly fucking said it should happen async as soon as the website, the store, lands." / "Stock should be requested asynchronously along with the fucking website, non-blocking. Not after anything, nothing." | in progress |
| [#416](https://github.com/Orthic-Labs/sellright/issues/416) | Cache every page's HTML at the edge; only values come fresh (this ADR). `/checkout/` dynamic by measurement (DP-5). | 2026-10-30: "isn't that the right design? actually even for checkout. the html, should be cached, shouldn't it? only the values should come fresh." | live |
| [#417](https://github.com/Orthic-Labs/sellright/issues/417) | Price is a live value, never in the cached shell (DP-1). | 2026-10-30: "only the values should come fresh." | live |
| [#418](https://github.com/Orthic-Labs/sellright/issues/418) | PDP option pills before live stock: grey + disabled, no "sold out" label (aria-label is the variant name only until live stock lands), as on the old Vendure PDP. Commit 1456f5e3. | 2026-11-01: "the buttons are grey or active, aren't they? where does it have to say SOLD out?" / "Then fucking fix it and get on with it." | committed, not deployed |
| [#419](https://github.com/Orthic-Labs/sellright/issues/419) | PDP live stock refresh at `qinit` on every storefront (Rotten as Damned). Timing superseded by #415. | 2026-10-31: "obviously yes" | live; superseded |
| [#420](https://github.com/Orthic-Labs/sellright/issues/420) | Edits show instantly: synchronous purge on admin commit as the end state (product edits purge their collections; maintenance purges every host). Measured 96-466 ms. | 2026-10-31: "there should be 0 delays in any changes it should be instant as end state. Clear?" | live |
| [#421](https://github.com/Orthic-Labs/sellright/issues/421) | pnpm 12.16.1 on the box and in every repo. | 2026-11-01: "upgrade them all as well as box to 12.16.1" | box done; repos in progress |
| [#422](https://github.com/Orthic-Labs/sellright/issues/422) | Every Lighthouse page 90+ mobile and desktop, tracked over time. Speed gate before every live deploy (`ops/rollout/speed-gate.sh`: mobile median of 3 + desktop; a drop > 5 points or a slower LCP = stop + revert). | 2026-10-31: "those yellow and red numbes are horrible. fix them asap" / "can we keep a track of that to see how the store is improving or getting worse?" | in progress |
| [#423](https://github.com/Orthic-Labs/sellright/issues/423) | Capture the real visitor IP for rate limiting (demo X-Real-IP, nginx rebuild). | 2026-10-30: "yes we need to capture actual ip so we can properly rate limit" | live |
| [#424](https://github.com/Orthic-Labs/sellright/issues/424) | Failed payments cancel after 30 minutes (gateway events retried every pass, ~30 min to manual review; 2a437b5f). | 2026-10-30: "30 minutes for failed payments to cancel" | live |
