# SellRight performance audit: connections, locks and failure points

Point-in-time review of `d973b2a`, 2026-10-24. Read-only; nothing was built, run or load-tested. Paths are
repo-relative. Facts about the Hetzner hosts come from the incident report and
[#357](https://github.com/Orthic-Labs/sellright/issues/357) /
[#358](https://github.com/Orthic-Labs/sellright/issues/358) and are marked **unverified** where this
repository cannot prove them. Security is covered in §2.G, denial-of-service first, plus a short classic pass.

## Summary

The 08:29 / 09:29 failures on Rotten Hand are not a tuning problem. They are the designed shape of the API
process: one `pg` pool of 10 connections serves shoppers, admins, the rate limiter, a permanent LISTEN
session and about 17 background jobs, and every job needs **two** of those connections at once (one held
idle for a leader lock, one for the work). All job intervals share one `setInterval` base time, so every 60
minutes 17 jobs wake in the same event-loop tick and ask for 34 connections from a pool that has 9 free.
`pg` queues waiters first-come-first-served, so the shopper request that arrives next waits behind all of
them and fails after 5 s with `timeout exceeded when trying to connect`.

Raising `PGPOOL_MAX` to 20 (the box-side stopgap) moves the cliff; it does not remove it. The proposal in
#358 (own job pool plus stagger) is necessary but incomplete: the leader lock, the LISTEN client, the rate
limiter and the manifest rebuild all still draw from the request pool, and no statement or lock timeout
bounds how long anything holds a connection.

Beyond the pool there are two lock sites that serialise every checkout in a store (every promotion row is
locked `FOR UPDATE` during pricing, and the order-number row is locked for most of the checkout
transaction), a full catalog-manifest rebuild on every checkout, and CPU work (HTML sanitising, XLSX
export) done inside open transactions. Those are the next cliffs once the pool is fixed.

## 1. Connection budget of one API process

Who takes a connection from the 10-connection request pool (`packages/api/src/db/client.ts:27-33`):

| Consumer | Connections | Held for | Where |
|---|---|---|---|
| Store-cache LISTEN client | 1, **permanent** | process lifetime | `src/store-context.ts:168` |
| Leader lock, per running job | 1 per job, **idle** | the whole job pass, including SMTP, webhook, Listmonk, Sezzle and file I/O | `src/jobs/leader-lock.ts:89-100` |
| Job work (`withStore` / `unsafeUnscopedDb`) | 1 per transaction, sequential per store | per transaction; no timeout | every `src/jobs/*.ts` |
| `catalog-manifest-drain` | 3 (nested leader lock + work) | pass | `src/jobs/scheduler.ts:186-191` |
| Rate limiter `consume` | 1, in a transaction under `pg_advisory_xact_lock` | 6 round trips | `src/auth/rate-limit-backend.ts:129-150` |
| Shopper or admin request | 1 per `withStore`; checkout uses 4 to 6 sequential checkouts | handler duration; no statement timeout | `src/db/client.ts:229`, `src/routes/checkout.ts:321-376` |
| `/v1/readyz` | 1 | up to 5 s when the pool is full | `src/app.ts:421-447` |
| Manifest regeneration after any stock change | 2 (leader lock + `withStore` over the whole catalog) | seconds, back to back under checkout traffic | `src/manifest/stock-hook.ts:118`, `src/manifest/catalog.ts:369` |

Outside the request pool, but on the same Postgres: an advisory-lock pool of `ceil(PGPOOL_MAX/4)` = 3
connections (`client.ts:34-41`) shared by `/pay`, refunds, gateway-events and gateway-recovery, and a fresh
2-connection pool created by the webhook job on every pass (`src/webhooks/emit.ts:157-166`). Per process at
`PGPOOL_MAX=10` that is up to 15 Postgres sessions; three brands on one box is 45, which matches the
"about 18 of 100 in use" idle figure (**unverified**).

### Why the hourly tick

`every()` creates its `setInterval` synchronously while `startJobScheduler` registers jobs
(`src/jobs/scheduler.ts:93`). The 750 ms stagger (`:100`) applies only to the one-shot startup kick, not to
the interval. All 17 intervals therefore share one base time to within a millisecond, and because 15 s,
60 s, 5 min, 15 min and 60 min all divide 3600 s, every job's interval fires in the same tick once an
hour. The hour offset is the process start minute, which is why Rotten fires at :29.

Jobs registered by default (`JOBS_PUSH_ENABLED=0`, manifest jobs off): pending-effects (15 s);
gateway-events, webhooks, emails, restock-notify (1 min); gateway-recovery, listmonk-sync, webhook-reaper
(5 min); passkey-prune (10 min); release-stale, reservation-release-sweep, cart-maintenance (15 min);
auto-deliver, sheerid-expiry, birthday-bonus, processed-event-reaper, rate-limit-reaper (1 h). That is 17
jobs, 18 with the manifest drain. At the hour: 17 leader-lock checkouts are queued first, then 17 work
checkouts, then every request that arrives in the next 5 s. With 9 usable connections, the leader locks take
all 9, the work checkouts wait on each other, and the 5 s connection timeout fails whichever waiters are
still queued: jobs and shoppers alike. Nothing is corrupted, because every job is idempotent and the
scheduler catches the error, but requests are refused.

At `PGPOOL_MAX=20` the leader locks take 17 of 19 usable connections, leaving 2 for 17 units of job work
and all shoppers. The incident did not recur at 10:29 because the window is a few hundred milliseconds
wide and only hurts when a request-side transaction is already long (the blog save in §4.7).

### Design for the fix

The target is simple to state: **a background job can never take a connection a shopper needs, a shopper
can never take a connection a payment needs, and nothing holds a connection while doing nothing.**

1. **Three pools with fixed budgets.** `requests` (default 10; only `withStore` from HTTP handlers),
   `jobs` (default 3; `withStore` and `unsafeUnscopedDb` from `src/jobs/**`, outbox drains, manifest
   regeneration), `locks` (default 4; leader locks and workflow advisory locks). Give the LISTEN client its own
   `pg.Client`, not a pooled one. Make `pool`/`unsafeUnscopedDb` resolve to the right pool through an
   `AsyncLocalStorage` scope set by the scheduler and by the HTTP entry, so jobs cannot accidentally use the
   request pool; keep the existing ESLint boundary for `src/routes/**`. Document `PGPOOL_MAX`,
   `PGJOBS_POOL_MAX`, `PGLOCKS_POOL_MAX` and warn at boot when their sum plus 1 exceeds the role's
   connection limit.
2. **The leader lock must not hold a work-pool connection.** Take it on the `locks` pool and keep it there for
   the pass. Better: replace the session advisory lock with a row claim in a `scheduler_lease`
   table (`job, owner, expires_at`, `UPDATE … WHERE expires_at < now() RETURNING`), renewed every 30 s by
   the running job. Then a job holds zero connections between its own transactions and a crashed leader
   releases itself after the lease expires instead of after a TCP timeout.
3. **Replace `setInterval` with a per-job schedule.** Each job gets `next = now + offset(job) + interval +
   jitter(0..10 % interval)`, where `offset(job)` is a fixed slot derived from the job name so no two jobs
   share a second. Run jobs through a semaphore of 2 (configurable) so at most two passes run at once, and
   give every pass a deadline (`AbortSignal.timeout`) after which it is logged and skipped, never left running.
   A job that cannot get a connection logs `job skipped: pool busy` and reschedules, instead of erroring and
   taking the request path's 5 s with it.
4. **Server-side timeouts set by `db-init`, not by a runbook.** `ALTER ROLE <app role> SET
   statement_timeout = '15s', idle_in_transaction_session_timeout = '10s', lock_timeout = '5s'` in
   `deploy/compose.yaml`'s db-init step, with the jobs pool raising `statement_timeout` per session
   (`SET statement_timeout = '120s'` on connect). Today `docs/runbooks/postgres-app-role.md:70-85`
   describes these and nothing applies them; the Hetzner roles may or may not have them (**unverified**).
   Without them a storefront request the Qwik server abandons at 8 s keeps running on the API and keeps
   its connection.
5. **Fail fast and visibly.** Map `pg`'s connection-timeout error to `503` with `Retry-After: 2` in
   `app.ts`'s error envelope (today it is a 500). Export pool gauges (`total`, `idle`, `waiting`) per pool
   on `/v1/readyz` and in the structured log every 30 s, so the next saturation is seen before the
   timeouts are. Have `/v1/readyz` probe through the `locks` pool with a 1 s budget and clear its timer.
6. **Separate the job runner from the request server in the deployment.** `deploy/compose.yaml` gets an
   `api-jobs` service that runs the same image with `JOBS_ENABLED=1` and no listener, and the `api`
   service runs with `JOBS_ENABLED=0`. Single-instance operators keep the in-process mode. This is the only
   change that makes the two workloads unable to interfere even under a bug.
7. **Tests to lock the fix in.** A scheduler unit test asserting distinct first-fire offsets and that no two
   hourly jobs share a slot; a db test that fills the request pool with held transactions and proves a job
   still runs, and the reverse; a db test that a leader-lock holder uses zero request-pool connections; a
   test that the pool-timeout error maps to 503.

## 2. Findings, ranked

Severity: **critical** means it refuses or corrupts shopper traffic under normal load; **high** means it
serialises or multiplies load on a hot path; **medium** means it degrades under spikes or at scale;
**low** means cost or hygiene.

### A. Pool and scheduler

| # | Sev | Finding | Where | Fix |
|---|---|---|---|---|
| A1 | critical | Jobs and requests share one 10-connection pool; each job needs two; all intervals align hourly. | `src/db/client.ts:27`, `src/jobs/scheduler.ts:93,100`, `src/jobs/leader-lock.ts:89` | §1 design, items 1 to 3. |
| A2 | critical | Leader lock holds a request-pool connection idle for the whole pass, including SMTP (no timeouts, nodemailer defaults 2 min connect / 10 min socket), APNs (no timeout) and Listmonk calls. | `leader-lock.ts:89-100`, `src/email/mailer.ts:43,85`, `src/push/apns.ts:101-138` | Lock on the `locks` pool or a lease row; set `connectionTimeout`, `greetingTimeout`, `socketTimeout` ≈ 10 s; `req.setTimeout(10_000)` on APNs. |
| A3 | high | LISTEN client permanently occupies one request-pool slot (effective pool 9). | `src/store-context.ts:168` | Dedicated `pg.Client` with its own reconnect. |
| A4 | high | `catalog-manifest-drain` nests two leader locks plus work: 3 connections per pass. | `scheduler.ts:186-191` | Call `publishCatalogManifest` directly; the drain lock already serialises it. |
| A5 | high | Every stock change (every checkout, every paid webhook) schedules a **full** manifest rebuild because `onStockChanged` is called without variant ids; the rebuild holds a leader connection plus a `withStore` that reads the whole catalog. | `src/routes/checkout.ts:939`, `src/routes/payment-webhooks.ts:345`, `src/manifest/stock-hook.ts:118`, `src/manifest/catalog.ts:151-193,369` | Pass the reserved variant ids (known in `reserveStockOrThrow`); run on the `jobs` pool; coalesce with a 2 s debounce. Ties to #357. |
| A6 | high | Rate limiter runs a BEGIN / `pg_advisory_xact_lock` / DELETE / COUNT / INSERT / COMMIT transaction on the request pool for **every** `/v1/shop/cart/*` request, GETs included, and again twice per checkout. | `src/auth/rate-limit-backend.ts:129-150`, `src/routes/cart.ts:215-222`, `src/routes/checkout.ts:321-334` | In-memory token bucket per process as the fast path with Postgres as backstop only on mutations; or one statement `INSERT … SELECT count(*)` without the advisory lock. |
| A7 | high | Advisory-lock pool is 3 connections per process; `pg_advisory_lock` waits with no timeout; `/pay` holds one across the Stripe call, whose SDK timeout is the 80 s default. The 4th concurrent payment fails after 5 s. | `src/db/client.ts:34-41`, `src/routes/pay.ts:97,274`, `src/payments/stripe-client.ts:22` | `newStripeClient(key, { timeout: 15_000, maxNetworkRetries: 1 })`; size the lock pool independently (8); `SET lock_timeout` or `pg_try_advisory_lock` with bounded retry. |
| A8 | medium | gateway-events nests a second advisory lock (`pay:` / `refund:`) inside the per-event lock on the same 3-connection pool: three outer holders deadlock the pool together with `/pay`. | `src/jobs/reconcile-gateway-events.ts:15,32,43`, `src/payments/gateway-payment.ts:264` | Acquire outer and inner keys together with `withAdvisoryLocks([...])`, or replace the outer lock with a row claim. |
| A9 | medium | Webhook job builds a new 2-connection `Pool` (new TCP + auth handshakes) every minute, outside the `PGPOOL_MAX` budget. | `src/webhooks/emit.ts:157-166` | Use the `jobs` pool with the same per-query timeouts. |
| A10 | medium | `/v1/readyz` competes for the request pool, never clears its race timer, and under saturation leaves a 5 s waiter per probe. | `src/app.ts:421-447` | Probe via the `locks` pool, 1 s budget, clear the timer. |
| A11 | medium | Pool-timeout error surfaces as 500, not 503 with `Retry-After`; nothing exports pool gauges. | `src/app.ts` error envelope | §1 item 5. |
| A12 | medium | No `statement_timeout`, `idle_in_transaction_session_timeout` or `lock_timeout` is applied by the deploy; the runbook describes them, db-init does not run them. | `deploy/compose.yaml:40-60`, `docs/runbooks/postgres-app-role.md:70-85` | §1 item 4. |
| A13 | low | Shutdown closes the listener immediately with an 8 s drain budget, shorter than the 80 s Stripe default; compose sets no `stop_grace_period`. | `src/sdk/create-app.ts:212-229,331`, `deploy/compose.yaml` api service | Fail readiness, wait ~5 s, then close; `stop_grace_period: 30s`; A7's Stripe timeout. |

### B. Locks that serialise a store

| # | Sev | Finding | Where | Fix |
|---|---|---|---|---|
| B1 | critical | In payment mode the pricing resolver runs `SELECT * FROM promotion WHERE store_id = … FOR UPDATE`, locking **every** promotion row in the store until commit. Checkout reaches it three times; every account credit and affiliate adds a promotion row, so the set grows. All checkouts in a store run one at a time. The public, unauthenticated `POST /v1/shop/cart/estimate` and `GET /v1/shop/cart/{token}` accept `pricingIntent=checkout`, which sets `selectedCreditOnly` and takes the same locks. | `src/money/promotion-resolver.ts:44-45`, `src/routes/cart.ts:136,244,586`, `src/routes/checkout.ts:494,586,781` | Lock only the promotions actually applied (`WHERE id IN (...) ORDER BY id FOR UPDATE`) immediately before the `usedCount` bump at `checkout.ts:801`; never lock from estimate or cart GET. |
| B2 | critical | The per-store `order_number_sequence` row is upserted (and so locked) at `checkout.ts:672` and stays locked through line inserts, policy hooks, credit reserve, promotion usage, loyalty, settlement and gift-card work. Admin draft orders and subscriptions use the same row. | `src/orders/order-number.ts:125-128`, `src/routes/checkout.ts:672` | Allocate the code as the last statement before COMMIT, or in its own short transaction (gaps are already accepted per the file header). |
| B3 | high | Stock rows are locked early (cart order) and held to commit; admin bulk stock locks in payload order. Opposite orders deadlock (40P01) and `withLockedSet` retries the whole checkout. The lock-order guard never sees implicit UPDATE locks. | `src/orders/stock-reservation.ts:53-61`, `src/routes/admin-products.ts:259-276`, `scripts/assert-lock-order.mjs:10-11,61` | Sort by `variant_id` in both; reserve as late as possible; teach the guard about `stock` and `order_number_sequence`. |
| B4 | high | Explicit `FOR UPDATE` on the `store` row blocks every insert that has a foreign key to `store` (orders, lines, carts take `FOR KEY SHARE`). | `src/routes/admin-settings.ts:78-83,168-173`, `admin-seo.ts:32`, `admin-marketing.ts:259`, `sheerid.ts:179`, `account-credit/service.ts:145` | `.for('no key update')`. |
| B5 | medium | `withLockedSet` always plans in a separate transaction before the locking one; `/pay` runs about 7 transactions around one Stripe call, checkout runs 4 to 6 before its main transaction. | `src/db/locks.ts:413`, `src/routes/pay.ts:278-354`, `src/routes/checkout.ts:321-376` | Plan inside the locked transaction for single-order subjects; resolve the customer once. |

### C. Request path overhead

| # | Sev | Finding | Where | Fix |
|---|---|---|---|---|
| C1 | high | Reading an unpaid order (the confirmation page polls this) calls Stripe inline under the advisory lock, up to 80 s. The throttle is per process. | `src/routes/orders.ts:107-109`, `src/payments/stripe-reconcile.ts:414-462,761` | Serve DB state; run the reconcile in the background or via the outbox. |
| C2 | high | Blog save runs `sanitize-html` on up to 2 MiB synchronously **inside** the transaction, plus two sha256 hashes of the whole row, while holding the row lock. The event loop stall also freezes every other in-flight transaction in the process. This is the "blog edits held connections" in the incident. No revision rows, FTS or after-commit hooks are involved. | `src/routes/admin-content.ts:115-119`, `src/routes/admin-blog-protocol.ts:40-43` | Sanitise and hash before `withStore`; return `id` and `updatedAt` only; cap the body for this route. |
| C3 | high | Product listing and search LEFT JOIN variants, GROUP BY product and ORDER BY name with OFFSET, which defeats the `(store_id, name)` index, plus three correlated subqueries per row and a separate COUNT(*) per page. The variant join is unused. | `src/routes/catalog.ts:157-176,464-477` | Drop the join and GROUP BY; use `productImage()` as the collection route does; keyset pagination; has-more instead of COUNT. |
| C4 | high | Pricing loads **all** promotions and **all** account-credit rows on every estimate, cart GET and checkout, then one or two `promotion_usage` queries per candidate. No `promotion(store_id)` index (only the partial one in `drizzle/0052`). `cartResponse` resolves the customer twice. | `src/money/promotion-resolver.ts:44-47,84-97`, `src/routes/cart.ts:112,437` | Filter to `code IN (...) OR code IS NULL`; add the index; batch usage counts. |
| C5 | high | Admin bulk stock: about 7 statements per item, up to 500 items, one transaction, holding hot stock rows; 500 after-commit purge calls. | `src/routes/admin-products.ts:259-276`, `src/webhooks/catalog.ts:16-21` | Set-based `UPDATE … FROM unnest()`, `INSERT … SELECT`, one product-changed event per product. |
| C6 | medium | Customer login runs Argon2id inside `withStore` under `FOR UPDATE`; Argon2 uses libuv's 4-thread pool, which new pg connections also need for DNS. | `src/routes/auth.ts:162-177` | Verify outside the transaction, then lock and recheck; `UV_THREADPOOL_SIZE=16`. |
| C7 | medium | Unknown hosts (bots on the IP, the `:8090` default, the storefront healthcheck) run a full `store` scan on every request; misses are never cached; `Origin` and `x-forwarded-host` are client-controlled and evict real entries from the 1000-entry cache. | `src/store-context.ts:331-351`, `src/cors-origins.ts:73` | In-memory hostname index rebuilt on NOTIFY; negative cache ≈ 30 s. |
| C8 | medium | Order export loads up to 50,000 rows with per-row correlated subqueries in one transaction, then builds XLSX synchronously with no stream consumer (whole file in memory) or CSV in memory. | `src/routes/admin-order-ops.ts:213-247`, `src/orders/export.ts:16` | Cursor / keyset batches, await backpressure, `SET LOCAL statement_timeout`. |
| C9 | medium | Stripe webhook with no matching env secret fans out one `withStore` per store per mode (2N transactions per event, including junk unsigned POSTs). | `src/routes/payment-webhooks.ts:139-156` | Per-store webhook URL or an in-memory secret index. |
| C10 | medium | Admin orders list orders by `coalesce(placed_at, created_at)` with no matching index, COUNT(*) over a customer join, and `ILIKE '%q%'` without trigram indexes. | `src/routes/admin.ts:~381` | Expression index `(store_id, coalesce(placed_at, created_at) DESC)`; keyset; trigram or prefix search. |
| C11 | medium | Node HTTP server runs on defaults (`keepAliveTimeout` 5 s, `requestTimeout` 300 s); admin nginx has no `client_max_body_size` (1 MB default vs 10 MB uploads) and the default 60 s `proxy_read_timeout`. | `src/sdk/create-app.ts:276`, `packages/admin/nginx.conf.template:20-28` | `keepAliveTimeout` 65 s, `headersTimeout` 66 s, `requestTimeout` 60 s; `client_max_body_size 11m`; align proxy timeouts. |
| C12 | low | `/v1/openapi.json` rebuilds the document per request (with an admin DB lookup in production). | `src/app.ts:95-102,600` | Memoise. |
| C13 | low | Unbounded lists: admin blog list, collections list; COUNT(*) on every storefront list page; search accepts 1-character terms the trigram index cannot serve. | `src/routes/admin-content.ts:24-26`, `src/routes/catalog.ts:324-336,443` | Paginate; min 3 characters. |

### D. Inside the jobs

| # | Sev | Finding | Where | Fix |
|---|---|---|---|---|
| D1 | high | Every job lists all stores and opens at least one transaction per store per tick even with no work: about N × (4/min + 1 per 15 s) idle transactions for N stores. `pending-effects` alone claims per store every 15 s. | `src/payments/settlement/effects.ts:332-341` and every `src/jobs/*.ts` store loop | One global due-check (`EXISTS` over the due index) before the per-store loop. |
| D2 | high | `webhook-reaper` is dry-run by default and compose never sets the apply flag, so a crashed webhook claim stays `processing` forever; `deliverWebhooks` never reclaims. | `src/jobs/scheduler.ts:256`, `src/webhooks/emit.ts:85` | Default apply on, or reclaim `processing` rows older than 10 min in the claim, as emails and pushes already do. |
| D3 | medium | `processed-event-reaper` loops over stores for a table that has no RLS, runs a full-table COUNT per store per hour, never deletes by default; no index on `processed_at`. The table grows forever. | `src/jobs/processed-event-reaper.ts:46-79` | Run once, no store loop; index `processed_event(processed_at)`; default apply on. |
| D4 | medium | `rate-limit-reaper` is an unbounded DELETE with no usable index on a table the login path writes to. | `src/auth/rate-limit-backend.ts:206` | Index `(attempted_at)`; batched `DELETE … WHERE ctid IN (SELECT … LIMIT 5000)`. |
| D5 | medium | `restock-notify` puts 200 variants × every waitlister in one transaction (thousands of `email_outbox` inserts). | `src/routes/restock.ts:255,283,366-384` | One transaction per variant; LIMIT the claim and re-queue. |
| D6 | medium | `birthday-bonus` runs all grants for the day in one transaction per store, 24 times a day, with no `customer(store_id, birth_month, birth_day)` index. | `src/loyalty/bonus.ts:173-200` | Transaction per 500-row batch; add the index; run daily. |
| D7 | medium | `gateway-recovery` applies `LIMIT 50` before the due filter, so 50 backing-off rows starve newer due rows. | `src/jobs/gateway-recovery.ts:243-251` | Push `next_attempt_at <= now()` into the WHERE. |
| D8 | medium | `reservation-release-sweep`: imported-reconciliation orders return early but keep `release_requested_at`, filling the 100-row window forever; the partial index covers `held` only while the query asks for `held, consumed`; no ORDER BY. | `src/jobs/reservation-release-sweep.ts:30-40` | Exclude them in SQL; ORDER BY `release_requested_at`; extend the index. |
| D9 | medium | `listmonk-sync` has no attempt counter or backoff; failing rows are re-sent every 5 min and starve newer rows. `gateway-events` has no backoff either and flips events to `manual` after 29 one-minute failures, so a 30 min Sezzle outage sends everything to manual review. | `src/jobs/listmonk-sync.ts:206-216`, `src/jobs/reconcile-gateway-events.ts` | `attempts` + `next_attempt_at` with exponential backoff on both. |
| D10 | low | `auto-deliver` has no `fulfillment(store_id, state, updated_at)` index and runs `FOR UPDATE SKIP LOCKED` even in dry-run. | `src/jobs/auto-deliver.ts:77-85` | Add the index; plain SELECT in dry-run. |
| D11 | low | `release-stale` in apply mode makes up to 800 sequential Stripe calls per store while holding the leader connection; two transactions per order. | `src/jobs/release-stale-allocations.ts` | Batch, and release the leader lock before gateway I/O (moot after A2). |

### E. Deployment (`deploy/`)

These describe the compose stack in this repository. The Hetzner hosts use their own configuration
(**unverified**).

| # | Sev | Finding | Where | Fix |
|---|---|---|---|---|
| E1 | critical | The storefront site in `Caddyfile` proxies **everything** to `storefront:4100`. The browser client calls relative `/v1/...` and the API returns relative `/assets/...`; the Qwik server has no proxy and no assets volume. Cart, checkout, live stock and product images on a compose-deployed storefront never reach the API; each `/assets` miss becomes a full SSR 404 with two API calls. | `deploy/Caddyfile:31-39`, `packages/storefront/src/sellright/client.ts:47`, `packages/storefront/src/entry.express.tsx`, `deploy/compose.yaml:206-221` | `handle /v1/* { reverse_proxy api:3300 }` and `handle /assets/* { reverse_proxy admin:8080 }` before the storefront proxy. |
| E2 | high | Postgres is untuned: no `command`, no `shm_size`, no limits (128 MB `shared_buffers`, 4 MB `work_mem`, 64 MB `/dev/shm`). | `deploy/compose.yaml:10-25` | `-c shared_buffers=512MB -c work_mem=16MB -c effective_cache_size=1GB -c max_connections=50`, `shm_size: 256m`, sized to the host. |
| E3 | high | No memory or CPU limits on any service and no Node heap flag; `install.sh` allows 2 GiB hosts. The OOM killer picks the victim. | `deploy/compose.yaml`, `packages/api/Dockerfile:57`, `deploy/install.sh:38` | `mem_limit` per service and matching `NODE_OPTIONS=--max-old-space-size`. |
| E4 | high | The catalog manifest (the documented "preferred browse path") is never enabled by compose: no `CATALOG_DIR`, `STORE_SLUG` or shared volume; the storefront's snapshot check is keyed on a build constant. `/shop` therefore pages through the whole catalog with sequential OFFSET calls on every view. | `deploy/compose.yaml:98-169,206-221`, `packages/storefront/src/services/catalog-snapshot.ts:7,42`, `packages/storefront/src/sellright/catalog.ts:147-163` | Shared `catalog` volume plus env; key the snapshot by resolved store; cap `/shop` to one page. |
| E5 | medium | Storefront healthcheck fetches `/` (two API calls, a store-host miss) with a 3 s timeout, and Caddy `depends_on` it being healthy: a slow API during `compose up` or `sellright update` leaves Caddy and the admin down. | `packages/storefront/Dockerfile:64-65`, `deploy/compose.yaml:226-230` | Static `/healthz` in Express; do not gate Caddy on it. |
| E6 | medium | Admin nginx resolves `api` once at startup, has no upstream keepalive, default timeouts. Recreating `api` alone gives 502 until admin restarts. | `packages/admin/nginx.conf.template:20-28` | `resolver 127.0.0.11 valid=10s` with a variable upstream; keepalive. |
| E7 | medium | No `logging:` limits; pino at `info` to json-file logs grows until the disk fills, taking Postgres with it. | `deploy/compose.yaml`, `src/lib/logger.ts:31` | `x-logging` with `max-size: 20m`, `max-file: 5`. |
| E8 | low | `sellright backup` runs `pg_dump` and `tar czf` inside the live api container with no `nice`/`ionice`. | `deploy/sellright.sh:76-79` | Throwaway container on the volume; `nice`/`ionice`. |
| E9 | low | Healthchecks spawn a Node process every 30 s. | `packages/api/Dockerfile:49-50` | `wget`/`curl`. |

### F. Storefront and admin

| # | Sev | Finding | Where | Fix |
|---|---|---|---|---|
| F1 | high | Every SSR page view costs 2 uncached control calls (`/v1/shop/identity`, `/v1/maintenance`) plus 1 to 3 content calls, all `private, no-store`; a home view holds about 5 request-pool connections at once, so two simultaneous home views fill the pool. | `packages/storefront/src/routes/layout.tsx:59,104`, `platform/home.ts:27,79,90`, `route-cache-policy.ts:11` | Per-host memo (≈5 s) for identity and maintenance, or one `/v1/shop/bootstrap`; `s-maxage` on catalog documents. |
| F2 | medium | The product page fetches reviews sequentially after the product. | `packages/storefront/src/platform/product.ts:63-78` | Parallel loaders. |
| F3 | medium | SSR calls never forward the shopper's IP, so every server-side call shares one rate-limit key (the storefront container's address). Browser calls are fine where Caddy sets `X-Real-IP`. | `packages/storefront/src/utils/sellright.ts:129-135`, `src/auth/rate-limit.ts:150-159` | Forward `x-real-ip` from the storefront and trust its CIDR. |
| F4 | medium | Image transformer appends `?w=&h=&format=avif` for four widths but nothing resizes at request time; full-size images per srcset width, four cache keys each. | `packages/storefront/src/routes/layout.tsx:150-151`, `constants.ts:12` | Drop the transformer or add a resizing proxy. |
| F5 | low | Cloudflare purge fires on every stock commit with no debounce and no fetch timeout, and purges documents that are `no-store` anyway. | `src/cache/purge-hook.ts:47-55`, `src/cache/cloudflare-purge.ts:53` | `AbortSignal.timeout(5000)`, coalesce, or drop. |
| F6 | low | Admin React Query `retry: 1` doubles every failing call during an outage. | `packages/admin/src/main.tsx:67` | Do not retry on 5xx. |

### G. Security (availability first)

| # | Sev | Finding | Where | Fix |
|---|---|---|---|---|
| G1 | high | The Postgres-backed rate limiter is itself a pool-exhaustion vector: concurrent requests on one key queue on the advisory lock, each holding a connection; admin login runs three `consume` calls in sequence, so about ten parallel logins from one IP fill the pool for everyone. Requests already over the cap still pay the full transaction; `check()` writes too. | `src/auth/rate-limit-backend.ts:99-150`, `src/auth/rate-limit.ts:90-97` | Per-process "blocked until T" cache answered without the DB; single-statement consume; own small pool (see A6). |
| G2 | high | Unknown `Host`, `X-Forwarded-Host` or `Origin` values trigger an uncached full `store` scan including the config JSONB, before any guard, with no auth. | `src/store-context.ts:331-350`, `src/app.ts:190-192`, `src/cors-origins.ts:73` | See C7. |
| G3 | high | The public merchant feed rebuilds the whole catalogue (every variant, image, option) into an in-memory CSV on every request, `no-store`, no limiter. | `src/routes/feeds.ts:141-163` | Cache per store for ~15 min, invalidated on catalogue writes, or require a feed token. |
| G4 | high | Coupon enumeration: estimate and cart GET accept up to 100 coupon codes per request and report applied/reason per code; with the 60/min cart budget that is 6,000 private-code guesses per minute per IP, each one also taking the promotion locks (B1). | `src/routes/cart.ts:197,244,586` | At most 5 codes per request; count codes, not requests, against the budget. |
| G5 | medium | Bad Stripe webhook signatures fan out over every store × 2 modes (a transaction, a decrypt and an HMAC over up to 2 MiB each) with no limiter; NMI and Sezzle cap bodies at 256 KiB, Stripe does not. | `src/routes/payment-webhooks.ts:140-158` | Per-store webhook path or route on the event's account; `bodyLimit(262144)`. |
| G6 | medium | Shop login hashes (Argon2id 19 MiB, or bcryptjs cost 14 on the main thread for legacy hashes) inside a locked transaction, limited only per (ip, email), so rotating emails gives unlimited hashes per IP; registration is likewise per (ip, email) and cleared on success, so one IP can create unlimited accounts and send unlimited verification mail. Turnstile is the only brake. | `src/routes/auth.ts:105-131,156-168`, `src/auth/password.ts:107-110` | Per-IP and per-store hourly caps; verify outside the transaction (C6). |
| G7 | medium | An admin account can be locked out from one IP: the account bucket (20/h across all IPs) is spent before verification. | `src/auth/rate-limit.ts:90-97` | Soft-lock (challenge or delay) instead of a hard 429; exempt known devices. |
| G8 | medium | Search `ILIKE '%term%'` does not escape `%`/`_`, and `offset`/`skip`/`page` are unbounded; with no statement timeout, slow anonymous queries pin connections. | `src/routes/catalog.ts:134,357,446,455-459` | Escape LIKE metacharacters; cap offset; A12. |
| G9 | medium | Per-IP buckets key on the full IPv6 address, so /64 rotation defeats every limit. | `src/auth/rate-limit.ts:22,139-153` | Normalise IPv6 to /64. |
| G10 | medium | Admin SMTP settings accept any host and port and return the raw nodemailer error, so a store owner can probe `postgres:5432` or the metadata address across tenants. | `src/routes/admin-email-settings.ts:51,72`, `src/email/smtp-settings.ts:89-115` | Apply the `outbound-url.ts` IP policy to the SMTP host; generic errors. |
| G11 | medium | No HSTS from Caddy or admin nginx; API JSON carries no `nosniff`. | `deploy/Caddyfile`, `packages/admin/nginx.conf.template:8-12` | Add both in the Caddy site blocks. |
| G12 | low | Gift-card balance check has no limiter; `x-store-slug` is honoured in production from any client; shop CORS allows any scheme and any subdomain of any store with credentials and is not bound to the resolved store; NMI webhook timestamp freshness is not checked; email fields have no max length (a ~2.7 KB key breaks the `rate_limit_attempt` btree insert with a 500); the ESLint guard covers only `routes/**` for `unsafeUnscopedDb`, not raw `pool` or `admin/`, `sdk/`, plugins. | `src/routes/shop-extra.ts:161-177`, `src/store-context.ts:385,281-287`, `src/cors-origins.ts:61-76`, `src/routes/disputes.ts:34-41`, `eslint.config.mjs:31-55` | Per-IP bucket; dev-only header; https-only CORS bound to the store; 5 min tolerance; `.max(254)`; extend the lint rule. |

Done well: session and agent tokens are random 32-byte values stored as sha256 hashes with HttpOnly, Lax,
Secure cookies; admin CSRF is a double-submit token with `timingSafeEqual`; admin login reserves its
buckets before verifying and runs a dummy Argon2 for unknown accounts; client IP comes from a proxy header
only when the TCP peer is a trusted proxy and `X-Forwarded-For` is never read; outbound SSRF protection is
strong (DNS-pinned connects, IPv6 and mapped addresses, own-host IPs, redirects refused, 8 MiB cap) and
webhooks, Listmonk and SheerID all go through it; image uploads are capped and single-slot; Stripe, NMI,
Sezzle and SheerID signatures use HMAC with `timingSafeEqual` and `processed_event` idempotency; secrets
use AES-256-GCM with purpose AAD; error bodies are sanitised and access logs record route templates.

Dependencies (`packages/api/package.json`, not checked against a live advisory feed, **unverified**): hono
4.13.13, pg 8.23, drizzle-orm 0.45.4, stripe 23, sharp 0.35.5, sanitize-html 2.18.1,
@simplewebauthn/server 14.0.3, nodemailer 10.1.7 are all past their known advisories. exceljs 4.4.0 is
unmaintained and pulls archiver 5.3.2, unzipper 0.10.14 and tmp 0.2.7; it is used for writing only.

## 3. Order of work

1. **Stop the bleeding (one PR, closes #358):** three pools, leader lock off the request pool, dedicated
   LISTEN client, per-job offsets plus jitter plus a concurrency cap plus a pass deadline, 503 on pool
   timeout, pool gauges. Role timeouts in db-init. This alone removes the hourly failure and bounds every
   other failure to a known duration.
2. **Stop serialising checkout:** B1, B2, B4, then B3. These are small, local changes with large effect
   and should ship before any ad spend grows.
3. **Take CPU and I/O out of transactions:** C2 (blog), C1 (order read), A7 (Stripe timeout), A2
   (SMTP/APNs timeouts), A5 (manifest scope).
4. **Cut per-request cost:** A6 (rate limiter), C4 (pricing reads), C3 (listing query), F1 (storefront
   control calls), C7 (negative host cache).
5. **Jobs hygiene:** D1 (global due check), D2, D3, D4, then the rest of D.
6. **Security hardening:** G1 and G4 ride with step 4; G3, G5, G6, G10 next; the rest as hygiene.
7. **Deployment:** E1 now (it is a correctness bug for anyone installing from the README), then E2, E3,
   E7, E5, E6, E4.

## 4. How to prove it

- Add `pg_stat_activity` and pool-gauge sampling to `/v1/readyz` and the 30 s log line before changing
  anything, so the before/after is measured on Rotten, not estimated.
- A synthetic load test (`autocannon` or `k6` against a dev store): 50 concurrent shoppers doing
  browse → add to cart → estimate → checkout with a test gateway, run across one hourly job tick, with
  `PGPOOL_MAX=10`. Today this should reproduce the `timeout exceeded when trying to connect` errors; after
  step 1 it should show zero, and after step 2 the checkout p95 should drop by the width of the
  promotion lock wait.
- `EXPLAIN (ANALYZE, BUFFERS)` on the listing query (C3) and the pricing read (C4) on the Rotten catalog
  size, before and after.
- The tests listed in §1 item 7.

## Appendix: checked and fine

Row-level-security policies are plain `store_id = current_setting(...)` comparisons with no subselects.
Hot lookups (product/collection/blog by slug, variant by SKU, customer by email, order by code and
idempotency key, cart and session tokens, provider refs) are indexed. Outboxes claim with
`FOR UPDATE SKIP LOCKED`, and email and webhook delivery release the connection before sending. Turnstile
runs outside transactions. Sharp runs off-thread with a pixel cap. Argon2 and scrypt are async. In-memory
maps are bounded. Pool `error` handlers are installed. The storefront client has an 8 s timeout and no
retries, so there is no retry storm. The API healthcheck does not touch the database, so a busy process is
not restarted. The storefront's trigger functions (`stock_restock_event`, `order_line_snapshot_product_name`)
are cheap per-row lookups.

Method: static review of the API, storefront, admin and deploy sources at `d973b2a` by five parallel
read-only passes (request path, jobs, deploy and frontends, hot queries and locks, security), with the
load-bearing claims re-read at source by the lead. No database was queried and no load was generated.
