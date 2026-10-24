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

Measured by reading the code (counts from the call traces in §6 and §7):

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

## 6. Storefront → API → Postgres, per journey

Counted by reading handlers; each count includes BEGIN, `set_config`, COMMIT (3). **RL** is the
6-statement rate-limit write on a second connection that precedes every `/v1/shop/cart/*` call. Unless
noted, every API response and every storefront document or q-data response is `private, no-store`.
Qwik runs layout and page loaders in parallel; awaits inside one loader are sequential.

### Endpoint cost reference

| Endpoint | SQL | Notes |
|---|---|---|
| `GET /v1/shop/identity`, `GET /v1/maintenance` | 0 | store cache, `existsSync` |
| `GET /v1/shop/auth/me` | 5 signed in | joins the full `store.config` JSONB and `passwordHash`; **writes** `session.expires_at` on every call because the route passes `forceRenew = true` (`routes/auth.ts:683`, `auth/session.ts:142`) |
| `GET /v1/shop/config` | 9–18 (+4 per NMI/Sezzle account) | resolves Stripe credentials three times in three transactions (`routes/shop-config.ts:52-60`); called by the CSP middleware on every SSR request on a 60 s cache miss (`entry.express.tsx:161`) and by four browser components |
| `GET /catalog/products` (listing, home) | 5 | variant LEFT JOIN + GROUP BY + 3 correlated subqueries per row + COUNT (`catalog.ts:166-183`) |
| `GET /collections/{slug}?pageSize=60` | 6 | products past 60 are silently dropped (`collections/[slug]/index.tsx:20`) |
| `GET /catalog/products/{slug}` (PDP) | 8 | 5–30 KB with description HTML, options, assets and **live stock the storefront throws away** (`sellright/catalog.ts:76`) |
| `…/{slug}/stock`, `…/{slug}/reviews`, `GET /seo/jsonld/products/{slug}` | 5, 6, 6 | the JSON-LD route re-reads the same product, variants, stock and images (`seo/queries.ts:122-170`) |
| `POST /v1/shop/cart`, `GET /cart/{token}`, `PATCH /cart/{token}/lines` | RL+8, RL+12 (guest) / RL+16 (signed in), RL+17–19 | `cartResponse` resolves the customer twice (`cart.ts:112,435`); `pricingIntent=checkout` adds the promotion `FOR UPDATE` |
| `POST /v1/shop/shipping-methods` | 11 | a read-only quote that still prices in checkout mode and locks every promotion (`shop-extra.ts:300`) |
| `POST /v1/shop/checkout`, `POST /orders/{code}/payment-intent` | ~50 + 3/line in ≥2 txns, ~35–45 over ~6 txns | plus the advisory lock and the Stripe call |
| `GET /orders/{code}` | ~21 (+8 and a Stripe call when reconciling) | loads every promotion for coupon display (`order-facts.ts:204`); polled 9× on confirmation |

### Per journey

| Journey | Calls | SQL (approx) | What hurts |
|---|---|---|---|
| Home, first visit | 5 SSR (`identity`, `maintenance`, org JSON-LD, products×4, collections) + `config` on a CSP miss | 9 (+9–18) | with spotlight/feature env set, +4 calls / +26 statements fetching full PDP detail for a name and a price |
| Collection | 3–4 SSR + `cart/{token}` in the browser when a cart cookie exists | 6 (+18) | the browser cart read on **every document load** with a cart cookie, RL included |
| PDP | SSR: snapshot read, then `products/{slug}` → `reviews?limit=1` sequential, JSON-LD in parallel; browser: `stock`, `reviews?limit=10` → `auth/me`, `config` | **~40–55** across ~7 calls | the same product/variant/stock/image rows read **three times** (detail, JSON-LD, stock), reviews twice, a full review fetched for the aggregate, `config` for one loyalty line |
| `/shop` | with a valid snapshot: 0 API calls, but the snapshot file is re-read and re-parsed per request (`catalog-snapshot.ts:56-92`); **without**: `take=10000` becomes ceil(N/100) **sequential** OFFSET calls on the SSR critical path (`browse-catalog.ts:34`, `sellright/catalog.ts:146-163`) | 5 per 100 products | **the snapshot check defaults `storeSlug` to `'demo'`** (`catalog-snapshot.ts:7,42`), so a generic per-host image with no `VITE_SELLRIGHT_STORE_SLUG` rejects every real store's snapshot and always falls back to live; the whole catalogue (~400 B/product) is serialised into the HTML |
| Search | plain GET form, no typeahead; `search?take=60` | 5 | a category filter asks `take=10000` and filters client-side (`search/categories.ts:15`) |
| Add to cart → drawer | `POST cart` → `PATCH lines` sequential (the create-with-items form exists and is unused), then `shipping-methods` ∥ `config`; header open = `cart` ×1–2 → `shipping-methods` | 14 + 24, then 11 + 9–18 | every quantity change or coupon = `PATCH lines` + `shipping-methods` again (24 + 11); missing line names trigger one PDP call per line (`CartContents.tsx:103-120`) |
| Checkout page | `cart` (bootstrap) ∥ `config` ∥ `cart` again → `cart` live, `shipping-methods` ×2–3, `auth/me` → account orders, loyalty; per address commit `cart?pricingIntent=checkout` + `shipping-methods`; shipping auto-select repeats both; place order = `cart` → `checkout` → `payment-intent` | **~450–600 per checkout** across ~20–25 calls | 3–5 cart reads, 2–4 shipping quotes, and every one of them in checkout mode takes `FOR UPDATE` on all promotions (`checkout/index.tsx:104-164,368-371`) |
| Confirmation | SSR layout + browser `cart` ∥ `orders/{code}` **polled 9× at 1.5 s** → `cart/{token}/checkout` | ~20 + 9×21 (+ reconcile + Stripe) + 13 | the poll returns the full order (lines, addresses, payments) when only `state` is needed (`confirmation-data.ts:98-112`) |
| Signed-in, any page or SPA navigation | `auth/me` on every SSR page and every navigation, with its UPDATE | 5 | `/account` calls it **three times** (layout loader, `account/layout.tsx:35`, `account/index.tsx:37`); ~8 calls / 55–70 statements per account view |
| Prefetch | `<Link prefetch>` on every product card and the header Shop link (`ProductCard.tsx:156`, `header.tsx:85`) | ~25–40 per hovered card | pointer/focus fetches the PDP's q-data, which runs all its loaders server-side; q-data is `no-store` |

Transport: SSR uses Node's global `fetch` with the default agent (implicit keep-alive, no per-origin cap,
no HTTP/2); the browser's `/v1` calls go through admin nginx with no upstream keepalive, so **every
browser API call opens a new TCP connection to the API** (`nginx.conf.template:20-28`). Images: every
srcset candidate (`?preset=…&format=avif|webp`, `?w=&h=`) is the same full-size WebP under a different
URL, the `avif` source serves WebP bytes, and the PDP preloads both variants (`LazyImage.tsx:47-61`,
`product.ts:126`).

### Storefront reductions, ranked (estimates)

1. **Fix the snapshot store check and cache the parsed generation in memory.** `/shop` goes from
   ceil(N/100) sequential calls to 0; PDP loses 2 calls / 14 statements and related products start working.
2. **One PDP payload.** The detail route already has stock; add the review aggregate, build JSON-LD from
   it, keep its stock. PDP SSR: −2 calls / −12 statements and one sequential hop gone.
3. **Make `/v1/shop/config` cheap and single-flight.** Resolve Stripe credentials once (−6 statements,
   −2 pool checkouts per call); share one promise across the CSP step and the four browser callers.
4. **Return shipping methods from the cart read at checkout** and drop the duplicate entry reads:
   −4–6 calls / −80–120 statements per checkout view, and no read-only `FOR UPDATE` on promotions.
5. **No rate-limit write on cart reads**; in-memory bucket for mutations (audit A6).
6. **`auth/me`: renew only inside the window, drop the config/passwordHash columns, and reuse the layout
   loader's result** instead of three calls per account view: −1 UPDATE per SSR page and navigation.
7. **Confirmation: slim order-state endpoint with backoff** (1, 2, 4 s), full order once: −6 calls /
   −120–150 statements worst case.
8. **`prefetch="js"` instead of data prefetch** on product cards: −25–40 speculative statements per hover.
9. **Create the cart with its first line**: −1 call / −20 statements including RL.
10. **Listing without the variant GROUP BY; a slim `(slug, inStock)` availability endpoint; no 100-row
    OFFSET loops**: 1,000 products go from 10 sequential calls / 50 statements to 1 / 5.

After rungs 1 to 3 of §4, items 1, 2, 8 and 10 above become moot for browse traffic (no API call at all)
and the remaining cart and checkout items are what the database actually sees.


## 7. Admin → API → Postgres, per screen

Counted by reading handlers; "SQL" includes BEGIN, `set_config`, COMMIT (3) and excludes the per-request
admin principal lookup (one `pool.query`, plus an UPDATE at most once a minute). React Query defaults are
`retry: 1`, `refetchOnWindowFocus: false`, `staleTime: 15 s` (`packages/admin/src/main.tsx:67`), so there
is no polling and no focus refetch; returning to a screen after 15 s refetches it. The iOS app has no
polling either and debounces its searches at 300 ms.

| Screen | Calls | SQL per call (approx) | What hurts |
|---|---|---|---|
| Login → shell | `setup/status`, `login`, `me`, full reload, `setup/status`, **`me` again** | 1, 8–12, 0, 1, 0 | duplicate `/me` after login (`Login.tsx:49`) |
| Global search | `GET /search` **per keystroke**, no debounce | 6 | three `ILIKE` queries; only `product.name` has a trigram index (`Layout.tsx:125`) |
| Dashboard | `dashboard`, then `reports/sales?days=30` **sequentially** | 9, 4 | whole store config JSONB read for one flag; all-time SUM/COUNT over paid orders; full stock scan; **~10 correlated subqueries per open order** for pending fulfilment (`admin-dashboard.ts:39`); `coalesce(placed_at, created_at)` date predicate with no index |
| Products list | per keystroke | 5 | 3 correlated subqueries per row, OFFSET, COUNT(*) |
| Product open | `products/:id` then `products/:id/options` sequentially | 7–8, 5 | `select *` on product |
| Product save | `PATCH product`, then **per changed variant** `PATCH variant` and `PATCH stock`, all sequential, then `GET product` | ~9, ~11, ~11 each, 8 | 5 variants with price and stock = 12 round trips, ~115 statements, up to 11 `catalog.product_changed` webhook deliveries, ~16 Cloudflare purges, and a manifest regeneration per stock PATCH (`ProductDetail.tsx:100-125`, `admin-products.ts:130,175,208`) |
| Bulk stock | 1 call | 5 + ~7 per item | emit and purge per item, products repeated |
| Inventory | per keystroke | 5 | `ILIKE` on sku/name with no trigram; ORDER BY a computed column; OFFSET + COUNT |
| Orders list | per keystroke | 5 | **~10 correlated subqueries per row** from `paymentStatusWithBalanceSql` + `fulfillmentStatusSql` (`orders/status-sql.ts:63,87`), in both the rows and the COUNT; with a status filter they run for every live order; ORDER BY `coalesce(placed_at, created_at)` has no index; code/email `ILIKE` without trigram |
| Order detail | `orders/:code` then `orders/:code/edit/context` sequentially | 16–18 (+8 with credit), 14–20 + N | both re-read order, lines, adjustments and amount due; `select *` from `audit_log` with JSONB; `liveEditSettlement` per history row (N+1) |
| Fulfil | 1 call, then both detail queries refetch | ~12 + 3–4 per line | webhook and email outbox inside the transaction; `onStockChanged(slug)` without variant ids = **full** manifest rebuild |
| Cancel | 1 call | ~35–45 across 5–7 transactions | lookup txn, config txn, credential reads, advisory lock, plan txn + main txn, Stripe call after commit, audit txn |
| Refund | 1 call | ~40+ | gateway HTTP call inside the advisory lock (pins one of 3 lock connections), then a second `withLockedSet` |
| Order export | 1 call | 4 | up to 50k rows × ~15 correlated subqueries, built in memory |
| Customers list / detail | per keystroke / 4 parallel | 5 / 7, 5, ~8, 6 | `ILIKE` on email/first/last with no trigram, in rows and COUNT |
| Blog list / open / save | 1 / 1 / 1 + list refetch | 4 / 4 / 5–6 | list unpaginated; open returns `body` and `bodyHtml`; sanitise inside the transaction |
| SEO page | `seo/config` + `seo/sitemaps` in parallel | 4, 10 in 2 txns | **rebuilds every sitemap URL (all products, collections, posts) on every page view** (`admin-seo.ts:181`) |
| Settings load / save | 6 parallel / 1 | 4 (full config JSONB) / ~14 in 2 txns + 2 NOTIFY | every config write does `SELECT … FOR UPDATE` on the whole blob, rewrites it, audits, then the page refetches the whole row (`admin-settings.ts:69-101,166-209`) |
| Activity | 1 | 4 | `audit_log` has only `(entity, entity_id)`; `ORDER BY at DESC` sorts the whole store's log (`admin-reports.ts:168`) |
| Reports | 3 parallel, re-run on every `days` change | 4 each | non-sargable `coalesce(...)` date predicate |

### Admin reductions, ranked (estimates)

1. **Materialise `payment_status` and `fulfillment_status` on the order row**, maintained on write. Removes
   ~10 sub-plans per row from the orders list, its COUNT, the dashboard pending count and the export
   (`admin.ts:373,383`, `admin-dashboard.ts:39`, `status-sql.ts:63,87`).
2. **Debounce `SearchInput` and the global search at ~250 ms** (`components/ui.tsx:276`,
   `Layout.tsx:125`): roughly 70–80 % fewer search requests.
3. **One `PATCH /products/:id` carrying variants and stock**: 12 round trips and ~115 statements become
   1–2 and ~30; webhook deliveries 11 → 1; one manifest regeneration instead of five.
4. **Index `audit_log (store_id, at DESC)`**; project columns instead of `select *` in order detail.
5. **Expression index `order (store_id, coalesce(placed_at, created_at) DESC) WHERE deleted_at IS NULL`**
   plus keyset pagination; count only when filters change. Fixes orders list, reports and dashboard.
6. **Merge order detail and edit context** (or share their reads) and drop the per-history-row
   `liveEditSettlement` call (`admin.ts:396-510`, `order-edit-service.ts:1594-1625`).
7. **Trigram indexes** on `customer.email/first_name/last_name`, `order.code`, `product_variant.sku/name`.
8. **Bulk stock**: group emit and purge by product; multi-row inserts for movements and audit rows.
9. **Dashboard**: `published` from the cached store context; 60 s roll-up of all-time KPIs; run the trend
   query in parallel.
10. **Settings**: one transaction with `jsonb_set`, one NOTIFY, skip no-op writes (~14 → ~6 statements).

Smaller: cache the sitemap preview; remove the duplicate `/me`; paginate `GET /blog`; scope the fulfil
`onStockChanged` to the order's variants.

