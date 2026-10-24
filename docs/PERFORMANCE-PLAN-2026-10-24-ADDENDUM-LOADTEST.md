# Addendum: load-test method and edge microcache (2026-10-24)

Adds to `PERFORMANCE-PLAN-2026-10-24.md` (Astra) after Adrian shared Arjay McCandless, "How Many Users Can a $12 Server
Handle?" (relayed by the Ads chat). Where this and the plan disagree, the stricter rule wins.

## Load-test method (P0 / P9)
- **Generator:** a short-lived Hetzner VM in the same region as the target. Never Adrian's PC: India-to-Germany latency
  and a single IP contaminate the results and trip per-IP limits.
- **Target:** never production. A clone stack (sanitised `rh_sellright` copy, API + storefront + nginx) on its own
  short-lived VM sized like the production share; the plan's "same-host alternate ports are not isolation" stands.
- **Workload:** k6 closed-model users with think time (~0.1 req/s per user, i.e. ~10 s between pages), on the plan's
  journey mix; separately, open-model arrival rates for capacity.
- **Pass bar per step:** p95 < 500 ms, p99 < 1 s, errors < 1% (expected business rejections such as sold-out are
  classified separately), zero pool timeouts, no dropped iterations.
- **Search:** double the users until a step fails, binary-search between the last pass and the first fail, then repeat
  the run at the limit 3 times; report the median of the three.
- **What broke (sampled every step):** per-process CPU (storefront vs API vs Postgres vs nginx), CPU steal, load
  average and run queue, Node event-loop lag, pool total/idle/waiting per pool, `pg_stat_activity` states and wait
  events, `pg_stat_statements` deltas.
- **Raw per-endpoint baselines,** separately from the mix: SSR home, SSR PDP, `GET /v1/shop/config`, `GET` cart, live
  stock batch.
- **Cost:** two VMs for a few hours, billed hourly; deleted after the run.

## Edge microcache (new phase, after P1 and P2)
- nginx `proxy_cache` with a 1-5 s TTL, anonymous requests only (bypass on any session or cart cookie or
  `Authorization`), cache key without cookies, `proxy_cache_lock on`, `proxy_cache_use_stale updating`.
- **Eligible:** only responses that carry no stock and no per-user data: `/v1/shop/config`, `/v1/shop/identity`, blog
  list and posts, organisation JSON-LD.
- **Not eligible until stock is stripped from them (plan N8):** catalog lists, collections, PDP data. Anything carrying
  `inStock` or quantities stays uncached.
- **Never cached:** stock, cart, auth, checkout, account, admin, any mutation.
- **Maintenance gate:** stays live, uncached (plan N10).
- **Proof:** a test that asserts no cached response body contains a stock field or per-user data, and a header
  (`X-Cache-Status`) checked in the browser suite.
- **Needs:** an nginx rebuild (sudo).

## Per-page cost is the multiplier
The video's users made ~1 API call per page; ours make 6-15 calls plus SSR per page, so the same hardware gives a
ceiling roughly 10x lower until P2 (config fetched once per document, no guest `/auth/me`, no unused home loaders)
lands. P2 and the microcache together are the largest browse-capacity gain; P1 and P3a are the largest
checkout-correctness and contention gains.
