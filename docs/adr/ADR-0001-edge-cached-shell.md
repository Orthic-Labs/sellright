# ADR-0001: Cache every storefront HTML shell at the edge; fetch only live values

- Status: **accepted** (Adrian, 2026-10-31; relayed by the Ads chat). Realization: not started.
- Owner: SellRight core (storefront + API). Decision authority: Adrian.
- Supersedes: storefront cache policy 2026-10-11.1 (commits 98f465f5, bf56ffff) and the blog/content-only edge cache added in #408 wave 1 (`SELLRIGHT_EDGE_HTML_CACHE`).
- Related: #360 (P4b, P7), #408, `~/sites/CLAUDE.md` Stock Architecture (LOCKED).

Adrian, 2026-10-30: "actually even for checkout. the html, should be cached, shouldn't it? only the values should come fresh."

## Decisions taken

- **DP-1** Price is a **live value**, not in the cached shell. It renders into space reserved in the shell (no layout shift). JSON-LD `offers` is filled by the client after the live read; the merchant feed (`no-store`) stays the crawl source.
- **DP-2** PDP JSON-LD availability is never in the shell; filled by the client.
- **DP-3** Account pages are out of scope (they redirect on a cookie).
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
| `shell` | `/`, `/shop/`, `/products/*` (and the brand product path), `/collections/*`, `/blog*`, `/about`, `/contact`, legal pages, `/checkout/` (exact) | `public, max-age=0, s-maxage=<TTL>` (no stale-while-revalidate) |
| `dynamic` | `/checkout/payment/`, `/checkout/cart-link/`, `/checkout/<alias>/`, `/checkout/confirmation/*`, `/account*`, `/sign-in`, `/search`, `/track-order`, `/verify*`, password routes, `/api/*`, `/cache*`, preview requests, every unclassified path | `private, no-store` |
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
