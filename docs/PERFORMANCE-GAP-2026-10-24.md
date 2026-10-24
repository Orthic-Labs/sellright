# SellRight: the gap between today and "10k concurrent users on a $20 box"

Companion to [`PERFORMANCE-AUDIT-2026-10-24.md`](PERFORMANCE-AUDIT-2026-10-24.md) (the failure points).
This document answers a different question: what stops SellRight from being the fastest commerce backend
it could be, and what the system looks like once the gap is closed. Same snapshot (`d973b2a`), same
method (static review, no load generated). Throughput numbers below are engineering estimates, labelled
**estimate**, not measurements.

## 1. What the "10k concurrent on a $20 server" claim actually means

A $20/month VPS is roughly 4 vCPU and 8 GB (Hetzner CPX31 class; **estimate**). "10k concurrent users"
in those demonstrations means 10k open browser sessions with human think time (one request every 5 to
10 s), so 1,000 to 2,000 requests per second, almost all of them reads. The demonstrations always have the
same three properties:

1. **Reads never reach the database.** Pages or API responses come from memory, a CDN, or a static file.
   The database sees writes and the few reads that must be live.
2. **One request costs one unit of work.** No per-request bookkeeping writes, no transaction per read,
   no fan-out.
3. **Every core is used.** A process per core (or a runtime that does it for you) behind a reverse proxy.

Node with Hono can answer about 30k trivial requests per second per core (**estimate**) and Postgres on
4 vCPU can run several thousand simple indexed queries per second (**estimate**). The hardware is not the
limit. The architecture decides whether a page view costs one memory read or five transactions.

## 2. Where SellRight is today, per storefront page view

Measured by reading the code (counts from the call trace in §5):

| Cost line | Today | Why |
|---|---|---|
| API calls per SSR page view | 3 to 7, 2 of them identical on every page | `/v1/shop/identity` and `/v1/maintenance` run in the root layout on every request (`packages/storefront/src/routes/layout.tsx:59,104`); content loaders add 1 to 5 more |
| Transactions per API call | 1 (BEGIN, `set_config`, queries, COMMIT); cart routes 2 | `withStore()` wraps reads too (`src/db/client.ts:229`); `/v1/shop/cart/*` adds the rate-limit transaction (`src/routes/cart.ts:215`) |
| Pages served without touching Postgres | 0 | Every HTML document and every loader response is `private, no-store` because it "renders stock-derived state" (`packages/storefront/src/config/route-cache-policy.ts:1-12`) |
| In-memory read models | 1 (host → store, 60 s) | `src/store-context.ts:36` |
| Processes per core | 1 process total for the API, 1 for the storefront | no `cluster`, no `NODE_OPTIONS`, single `serve()` (`src/sdk/create-app.ts:276`) |
| Postgres tuning | defaults (128 MB `shared_buffers`, 4 MB `work_mem`) | `deploy/compose.yaml:10-25` |
| Per-request writes on the hot path | 1 (rate limiter) on cart/checkout; audit rows on admin | `src/auth/rate-limit-backend.ts:129` |
| Measurement in production | none: no `pg_stat_statements`, no per-route p95, no pool gauges | |

So at 1,000 page views per second, today's design asks for roughly 5,000 API calls and 5,000 to 6,000
transactions per second from one Node process and a 10-connection pool. That is 2 ms per transaction
including Node overhead, with queries that aggregate the whole catalogue per page (`catalog.ts:157-176`)
and load every promotion per cart call (`promotion-resolver.ts:44-47`). It cannot work, and no amount of
index tuning makes it work. The bottleneck is the number of database-backed operations per view, not the
speed of any one of them.

## 3. The one rule that costs the most

`docs/ARCHITECTURE.md` and the storefront cache policy encode a correct invariant: **stock must never be
cached, debounced or served stale.** The implementation then generalises it to "therefore no document
that mentions stock may be cached", and because every product card, PDP, home page and search result
mentions stock, nothing is cached. One invariant about one small, fast-changing integer has made the
whole content layer dynamic.

The fix is not to weaken the invariant. It is to **separate stock from content** so the invariant applies
only to stock:

- **Content** (product names, prices, images, descriptions, collections, blog, menus, SEO, JSON-LD) changes
  when an admin saves. It is versioned by the existing `catalog_manifest_pending` / product-changed events
  and can be cached anywhere with an explicit purge, which already exists (`src/cache/purge-hook.ts`).
- **Stock** is one boolean per variant (`inStock`) for browse and one integer at cart/checkout. The manifest
  already models exactly this (`src/manifest/catalog.ts:47-50`: "`inStock` as the ONLY availability
  signal"). It is served live from a tiny endpoint (`GET /v1/shop/stock?variantIds=…`, one indexed
  query, or an in-process map maintained by the stock trigger's NOTIFY), and rendered client-side or as a
  streamed fragment. The checkout path already re-checks live stock regardless of what the page showed.

Once that split exists, every storefront document becomes `public, s-maxage=…, stale-while-revalidate`
with purge on content change, and the catalogue read path never touches Postgres. That is the single
change that moves SellRight from "5 transactions per view" to "0 transactions per view" for browse
traffic, which is 95 % or more of traffic on a shop.

## 4. The ladder: from today to the target

Each rung is independently shippable and each one removes a class of work from the hot path. Rungs 1 to
4 are the ones that change the order of magnitude.

### Rung 1. Reads without transactions, and no bookkeeping on reads
- Add `withStoreRead()` that runs `SELECT set_config('app.current_store', $1, false)` on a pooled
  connection and `RESET` on release, or batches `BEGIN; set_config; query; COMMIT` as one round trip
  where the driver allows. Reads drop from 4 round trips to 1 or 2.
- Rate-limit only mutations, from an in-memory token bucket, with Postgres as the backstop for
  login-style buckets only (audit A6, G1).
- Resolve the customer once per request and pass it down (audit B5, C4).

### Rung 2. Stock/content split, then cache everything that is content
- `inStock` and live stock come from a dedicated endpoint or an in-process map fed by
  `pg_notify` from the existing stock trigger (`drizzle/0049:86-101`).
- Storefront documents become cacheable with `s-maxage` plus the existing Cloudflare purge; the Qwik
  loaders for identity and maintenance become a 5 s per-host memo (or one `GET /v1/shop/bootstrap`),
  and the maintenance flag arrives by NOTIFY instead of a call per page.
- The catalogue manifest becomes the default browse path in compose (audit E4) and the storefront loads
  it into memory, hot-swapping on the next generation. Product, collection, search and home pages then
  make **zero** API calls on the server. Search runs over the in-memory manifest for catalogues under
  ~50k variants (**estimate**) and over the Postgres trigram index above that.

### Rung 3. Make the write path short
- One transaction per checkout, locks taken as late as possible and in a fixed order, order number last
  (audit B1 to B3), everything after COMMIT through the outbox. Target: a checkout transaction under
  50 ms of database time (**estimate**).
- Pricing rules (promotions, credits, shipping, tax) cached per store in memory with NOTIFY invalidation;
  a cart quote then needs one `SELECT` for lines and stock, not one per promotion.
- CPU work (sanitising, hashing, XLSX, image processing) never inside a transaction (audit C2, C8).

### Rung 4. Use the machine
- `cluster` with one worker per core for the API and for the storefront; a `PGPOOL_MAX` per worker of
  `floor((max_connections − reserved) / (workers × brands))`; the job runner as its own process
  (audit §1 item 6). RLS via transaction-local `set_config` is compatible with PgBouncer transaction
  pooling, so a pooler can be added when a second box appears.
- Postgres tuned to the host (`shared_buffers` 25 % of RAM, `effective_cache_size` 75 %, `work_mem`
  16 MB, `random_page_cost` 1.1 on SSD, `shm_size`), `pg_stat_statements` on, `auto_explain` for
  statements over 100 ms.
- Storefront to API over a Unix socket or HTTP keep-alive on the same host; HTTP/2 from Caddy; Brotli
  precompressed build assets (already `immutable`); images resized at upload into the srcset widths the
  storefront already asks for (audit F4) and served from the asset volume or R2 with long cache.

### Rung 5. Query hygiene (the audit's C and D sections)
- Listing without the variant GROUP BY; keyset pagination everywhere; has-more instead of `COUNT(*)`;
  the missing indexes (`promotion(store_id)`, `fulfillment(store_id, state, updated_at)`,
  `customer(store_id, birth_month, birth_day)`, `processed_event(processed_at)`,
  `rate_limit_attempt(attempted_at)`, the admin orders sort expression).
- Jobs: one global due-check per tick, batched deletes, backoff columns.

### Rung 6. Measure, then budget
- `pg_stat_statements` top-20 by total time in the ops runbook; per-route p50/p95 and pool gauges in the
  structured log and on `/v1/readyz`; a k6 scenario (browse, cart, checkout, 1k virtual users, one hourly
  job tick) run in CI against a seeded store with a budget: PDP p95 under 20 ms cached and under 100 ms
  uncached, cart quote under 50 ms, checkout under 300 ms (**estimates**, to be replaced by the first
  measured baseline).

## 5. Where the gap comes from

Not from any single bad decision. Four patterns compound:

1. **A correctness rule applied one level too wide.** The stock rule (§3) turned the content layer
   dynamic. Everything downstream (SSR per view, `no-store`, identity call per page, manifest rebuild per
   checkout) follows from it.
2. **Per-request ceremony without a per-request budget.** Each safety feature was added correctly in
   isolation: a transaction per read for RLS, a locked write per request for rate limiting, an audit row
   per admin call, a leader lock per job, a full manifest rebuild on every stock change. Nobody summed
   them. A page view now costs 15 to 25 round trips before it does any work.
3. **No production measurement.** There is no `pg_stat_statements`, no per-route latency, no pool
   gauge. The hourly failure was found by a user, and the "blog edit held connections" diagnosis was a
   guess. The 10k-users demonstrations always start with a flame graph.
4. **Single process, default database, jobs in the request server.** The deployment runs one Node
   process per service on default Postgres settings with the job scheduler inside the API. That is the
   simplest correct deployment, and it is also the one that falls over first.

Closing the gap is mostly subtraction: fewer calls per view, fewer transactions per call, fewer locks per
checkout, fewer jobs in the request process. The additions (an in-memory catalogue, a stock map, cluster
workers, a tuned Postgres) are small.

<!-- STOREFRONT TABLE -->

<!-- ADMIN TABLE -->
